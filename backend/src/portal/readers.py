"""Turn what the agent leaves on disk into what a business owner should see.

Everything here is shaped by the agent's real layout under its data directory:

=============================  ==================================================
``memories/MEMORY.md``         entries joined by ``\\n§\\n``, capped by config
``skills/.bundled_manifest``   vendor skills copied in at boot; never "learned"
``skills/.hub/lock.json``      third-party installs; never "learned"
``skills/.usage.json``         per-skill usage: ``last_used_at``, ``use_count``
``cron/jobs.json``             schedule, state and the job's private prompt
``cron/output/<id>/*.md``      each run: header, **private prompt**, response
``cron/usage_audit.jsonl``     per-run ``duration_ms``
``gateway_state.json``         per-platform connection state
``state.db``                   sessions and messages (SQLite)
=============================  ==================================================

The rule throughout is to fail closed. A run document that cannot be parsed
yields no text rather than the whole document, because the whole document
contains the job's prompt.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml
from fastapi import status

from ..clients.models import Client
from ..clients.skills import SKILL_MANIFEST
from ..config.settings import Settings
from ..orchestrator.templates import parse_env
from .errors import PortalError
from .sanitize import mentions_internals, scrub, validate_business_rule
from .schemas import (
    AgencySkill,
    AllowlistEntry,
    BusinessMemory,
    ChannelName,
    CronJobSummary,
    CronReport,
    CronReportFeed,
    LearnedSkill,
    MemoryFact,
    PortalChannel,
    ReportMetric,
    ReportStatus,
)
from .tenant_files import TenantFiles

logger = logging.getLogger(__name__)


def files_for(settings: Settings, client: Client) -> TenantFiles:
    """The tenant's directory. ``client.subdomain`` is the full FQDN it is keyed by."""
    return TenantFiles(settings.tenant_dir_for(client.subdomain))


# ------------------------------------------------------------- env and config
_SECRET_KEY = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|HASH", re.IGNORECASE)


def read_env(files: TenantFiles) -> dict[str, str]:
    """Parsed ``.env``. Server-side only: no value here may reach a response."""
    text = files.read_text(".env")
    return parse_env(text) if text else {}


def known_secrets(files: TenantFiles) -> list[str]:
    """This tenant's actual secret values, for exact-match redaction."""
    return [
        value
        for key, value in read_env(files).items()
        if _SECRET_KEY.search(key) and len(value) >= 8
    ]


def read_config(files: TenantFiles) -> dict[str, Any]:
    text = files.read_text("config.yaml")
    if not text:
        return {}
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        logger.warning("Tenant config.yaml under %s is not valid YAML", files.root)
        return {}
    return data if isinstance(data, dict) else {}


def _tenant_timezone(files: TenantFiles, config: dict[str, Any]) -> timezone | ZoneInfo:
    """The zone the agent stamps its filenames in; they carry no offset."""
    name = read_env(files).get("HERMES_TIMEZONE") or config.get("timezone")
    if isinstance(name, str) and name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            logger.warning("Unknown tenant timezone %r", name)
    return timezone.utc


def _from_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------- memory
MEMORY_PARTS = ("memories", "MEMORY.md")
MEMORY_DELIMITER = "\n§\n"
#: The agent's own default, used when the tenant's config does not override it.
DEFAULT_MEMORY_LIMIT = 2200


def _memory_limit(config: dict[str, Any]) -> int:
    section = config.get("memory")
    limit = section.get("memory_char_limit") if isinstance(section, dict) else None
    return limit if isinstance(limit, int) and limit > 0 else DEFAULT_MEMORY_LIMIT


def _parse_memory(raw: str) -> list[str]:
    entries = (entry.strip() for entry in raw.split(MEMORY_DELIMITER))
    return list(dict.fromkeys(entry for entry in entries if entry))


def _fact_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


#: First match wins. Policies come before Delivery because "exchanges within 7 days
#: of delivery" is a policy, and Hours stays narrow because "holds last 2 hours" is not.
_FACT_CATEGORIES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE))
    for name, pattern in (
        ("Policies", r"\b(return\w*|exchange\w*|refund\w*|polic\w+|warranty|guarantee|cancel\w*)\b"),
        ("Delivery", r"\b(deliver\w*|shipping|ship|courier|dispatch\w*|tracking)\b"),
        ("Pricing", r"\b(price\w*|pricing|discount\w*|BDT|USD|Tk|fee|fees|cost\w*)\b"),
        ("Customers", r"\b(customers?|VIP|clients?|patients?|members?)\b"),
        ("Hours", r"\b(open|opens|closed|holidays?|business hours|working hours|opening hours)\b"),
    )
)


def _fact_category(text: str) -> str:
    for name, pattern in _FACT_CATEGORIES:
        if pattern.search(text):
            return name
    return "Operations"


def _memory_view(entries: list[str], limit: int) -> BusinessMemory:
    """What the owner sees.

    An agent also notes things about its own environment. Those are not business
    facts, and they do reveal how the service is built, so they are left out of
    the view rather than rewritten into something misleading.
    """
    return BusinessMemory(
        facts=[
            MemoryFact(id=_fact_id(entry), text=entry, category=_fact_category(entry))
            for entry in entries
            if not mentions_internals(entry)
        ],
        used_chars=len(MEMORY_DELIMITER.join(entries)),
        limit_chars=limit,
    )


def read_memory(files: TenantFiles) -> BusinessMemory:
    raw = files.read_text(*MEMORY_PARTS) or ""
    return _memory_view(_parse_memory(raw), _memory_limit(read_config(files)))


def _not_found_fact() -> PortalError:
    return PortalError(
        status.HTTP_404_NOT_FOUND,
        "memory_fact_not_found",
        "That entry has changed since this page loaded. Refresh and try again.",
    )


def _bad_memory_request(detail: str) -> PortalError:
    return PortalError(422, "memory_bad_request", detail)


def patch_memory(
    files: TenantFiles, op: str, *, text: str | None, fact_id: str | None
) -> BusinessMemory:
    """Apply one owner edit under the agent's lock, or change nothing."""
    needs_text = op in {"append", "replace"}
    if needs_text and text is None:
        raise _bad_memory_request("Write the rule to save.")
    if op in {"remove", "replace"} and not fact_id:
        raise _bad_memory_request("Choose an entry to change.")
    cleaned = validate_business_rule(text or "") if needs_text else ""

    limit = _memory_limit(read_config(files))
    with files.locked(*MEMORY_PARTS):
        # ``None`` means absent, which is fine. An unreadable file raises rather
        # than reading as empty, which would then overwrite real memories.
        entries = _parse_memory(files.read_text(*MEMORY_PARTS) or "")

        if op == "append":
            if cleaned in entries:
                return _memory_view(entries, limit)
            updated = [*entries, cleaned]
        else:
            # Only entries the owner can see are addressable. Ids of hidden
            # agent notes are never returned and must not work if guessed.
            matches = [
                index
                for index, entry in enumerate(entries)
                if _fact_id(entry) == fact_id and not mentions_internals(entry)
            ]
            if not matches:
                raise _not_found_fact()
            updated = list(entries)
            if op == "remove":
                del updated[matches[0]]
            else:
                updated[matches[0]] = cleaned
            updated = list(dict.fromkeys(updated))

        if len(MEMORY_DELIMITER.join(updated)) > limit:
            raise PortalError(
                status.HTTP_409_CONFLICT,
                "memory_full",
                "Business memory is full. Remove an entry you no longer need, then "
                "add this one.",
            )
        files.write_atomic(MEMORY_DELIMITER.join(updated), *MEMORY_PARTS)
    return _memory_view(updated, limit)


# --------------------------------------------------------------------- skills
#: Directory names the agent itself never treats as skills, plus its own state.
_SKIP_DIRS = frozenset(
    {
        ".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv",
        "venv", "node_modules", "site-packages", "__pycache__",
    }
)
_MAX_SKILL_DEPTH = 3
_MAX_SKILLS = 200


def _split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    match = re.match(r"^---[ \t]*\r?\n(.*?)^---[ \t]*\r?$\n?", text, re.DOTALL | re.MULTILINE)
    if not match:
        return {}, text
    try:
        meta = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        meta = None
    return (meta if isinstance(meta, dict) else {}), text[match.end():]


def _humanise_name(name: str) -> str:
    return re.sub(r"[-_.]+", " ", name).strip().title()


def _first_sentence(text: str, limit: int = 180) -> str:
    collapsed = " ".join(text.split())
    match = re.match(r"(.+?[.!?])(\s|$)", collapsed)
    sentence = match.group(1) if match else collapsed
    return sentence if len(sentence) <= limit else f"{sentence[:limit - 1].rstrip()}…"


def _declared_category(meta: dict[str, Any]) -> str | None:
    """``metadata.<vendor>.category``, under whichever key the vendor uses."""
    metadata = meta.get("metadata")
    if isinstance(metadata, dict):
        for value in metadata.values():
            if isinstance(value, dict) and isinstance(value.get("category"), str):
                return value["category"]
    category = meta.get("category")
    return category if isinstance(category, str) else None


def read_agency_skills(settings: Settings, client: Client) -> list[AgencySkill]:
    """Skills from the agency library: what each does, never how.

    Only the frontmatter is parsed and only its first sentence leaves this
    function. The body is the proprietary prompt.
    """
    skills: list[AgencySkill] = []
    for name in sorted(client.synced_skills or []):
        path = settings.shared_skills_dir / name / SKILL_MANIFEST
        try:
            meta, _ = _split_frontmatter(path.read_text(encoding="utf-8"))
        except OSError:
            meta = {}
        description = meta.get("description")
        skills.append(
            AgencySkill(
                id=name,
                title=_humanise_name(name),
                category=_humanise_name(_declared_category(meta) or "Agency Verified"),
                description=(
                    scrub(_first_sentence(description))
                    if isinstance(description, str)
                    else "A verified capability maintained by your account team."
                ),
                active=True,
            )
        )
    return skills


def _manifest_names(files: TenantFiles) -> set[str]:
    """Names in ``.bundled_manifest``: one ``name`` or ``name:hash`` per line."""
    text = files.read_text("skills", ".bundled_manifest") or ""
    return {line.partition(":")[0].strip() for line in text.splitlines() if line.strip()}


def _hub_names(files: TenantFiles) -> set[str]:
    lock = files.read_json("skills", ".hub", "lock.json")
    installed = lock.get("installed") if isinstance(lock, dict) else None
    return set(installed) if isinstance(installed, dict) else set()


def _walk_skill_dirs(files: TenantFiles, mount_name: str) -> list[tuple[str, ...]]:
    """Relative paths of directories holding a ``SKILL.md``. Never follows links."""
    # A conventional ``os.walk(path)`` can be redirected after the pathname has
    # been checked. TenantFiles keeps this traversal descriptor-relative on the
    # production Linux host.
    return files.directories_with_file(
        "skills",
        filename=SKILL_MANIFEST,
        max_depth=_MAX_SKILL_DEPTH,
        max_results=_MAX_SKILLS,
        skip_names={*_SKIP_DIRS, mount_name},
    )


_TRIGGER_HEADING = re.compile(
    r"^#{1,4}\s*(when\s+to\s+use.*|use\s+when.*|triggers?.*|trigger\s+conditions?.*)$",
    re.IGNORECASE | re.MULTILINE,
)


def _trigger_conditions(body: str, description: str) -> str:
    heading = _TRIGGER_HEADING.search(body)
    if heading:
        rest = body[heading.end():]
        following = re.search(r"^#{1,4}\s", rest, re.MULTILINE)
        section = (rest[: following.start()] if following else rest).strip()
        if section:
            return section
    used = re.search(r"\bUse (?:this )?when\b.*", description, re.IGNORECASE | re.DOTALL)
    return used.group(0).strip() if used else description


@dataclass(frozen=True)
class _ScannedSkill:
    name: str
    aliases: frozenset[str]
    parts: tuple[str, ...]
    meta: dict[str, Any]
    body: str


def _scan_learned(
    settings: Settings, client: Client, files: TenantFiles
) -> list[_ScannedSkill]:
    """Skills the agent wrote for this business, excluding everything it was given.

    Without the exclusions this returns the vendor's whole bundled library, all
    named and described in the vendor's terms, as though the agent had learned it.
    """
    mount_name = PurePosixPath(settings.shared_skills_mount).name
    given = set(client.synced_skills or []) | _manifest_names(files) | _hub_names(files)

    skills: list[_ScannedSkill] = []
    for parts in _walk_skill_dirs(files, mount_name):
        text = files.read_text("skills", *parts, SKILL_MANIFEST)
        if text is None:
            continue
        meta, body = _split_frontmatter(text)
        declared = meta.get("name")
        name = declared if isinstance(declared, str) and declared else parts[-1]
        aliases = frozenset({name, parts[-1]})
        if aliases & given or mentions_internals(name):
            continue
        skills.append(_ScannedSkill(name, aliases, parts, meta, body))
    return sorted(skills, key=lambda skill: skill.name)


def _disabled_names(config: dict[str, Any]) -> set[str]:
    section = config.get("skills")
    listed = section.get("disabled") if isinstance(section, dict) else None
    return {str(item) for item in listed} if isinstance(listed, list) else set()


def read_learned_skills(
    settings: Settings, client: Client, files: TenantFiles
) -> list[LearnedSkill]:
    disabled = _disabled_names(read_config(files))
    usage = files.read_json("skills", ".usage.json")
    usage = usage if isinstance(usage, dict) else {}
    secrets = known_secrets(files)

    skills: list[LearnedSkill] = []
    for skill in _scan_learned(settings, client, files):
        record = usage.get(skill.name)
        record = record if isinstance(record, dict) else {}
        if record.get("state") == "archived":
            continue
        description_raw = skill.meta.get("description")
        description = scrub(description_raw, secrets) if isinstance(description_raw, str) else ""
        category = _declared_category(skill.meta) or (
            skill.parts[0] if len(skill.parts) > 1 else "Workflow"
        )
        use_count = record.get("use_count")
        skills.append(
            LearnedSkill(
                id=skill.name,
                title=_humanise_name(skill.name),
                category=scrub(_humanise_name(category), secrets),
                description=_first_sentence(description, limit=240),
                trigger_conditions=scrub(_trigger_conditions(skill.body, description), secrets),
                workflow_markdown=scrub(skill.body.strip(), secrets),
                last_used=_from_iso(record.get("last_used_at")),
                use_count=use_count if isinstance(use_count, int) else 0,
                enabled=not (skill.aliases & disabled),
            )
        )
    return skills


def _leading_comments(text: str) -> str:
    """The explanatory header of a generated file, which ``safe_dump`` would drop."""
    header: list[str] = []
    for line in text.splitlines(keepends=True):
        if not (line.startswith("#") or not line.strip()):
            break
        header.append(line)
    return "".join(header)


def set_skill_enabled(
    settings: Settings, client: Client, files: TenantFiles, skill_id: str, enabled: bool
) -> tuple[LearnedSkill, list[str]]:
    """Toggle a learned skill via ``skills.disabled``, the agent's own switch.

    Agency skills are not found here, so they cannot be switched off. The id is
    only ever compared against a fresh scan and never used to build a path.
    Returns the skill and the resulting list so the caller can record it for
    re-renders of ``config.yaml``.
    """
    scanned = next(
        (skill for skill in _scan_learned(settings, client, files) if skill.name == skill_id),
        None,
    )
    if scanned is None:
        raise PortalError(
            status.HTTP_404_NOT_FOUND, "skill_not_found", "That skill is no longer available."
        )

    with files.locked("config.yaml"):
        raw = files.read_text("config.yaml") or ""
        try:
            config = yaml.safe_load(raw) if raw else {}
        except yaml.YAMLError as exc:
            # Writing a guess back would destroy whatever this file really held.
            raise PortalError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "portal_data_unavailable",
                "This setting cannot be changed right now. Please try again shortly.",
            ) from exc
        config = config if isinstance(config, dict) else {}
        section = config.get("skills")
        section = dict(section) if isinstance(section, dict) else {}

        disabled = _disabled_names(config)
        if enabled:
            disabled -= scanned.aliases
        else:
            disabled.add(scanned.name)
        section["disabled"] = sorted(disabled)
        config["skills"] = section

        files.write_atomic(
            _leading_comments(raw) + yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
            "config.yaml",
        )

    current = next(
        skill
        for skill in read_learned_skills(settings, client, files)
        if skill.id == skill_id
    )
    return current, sorted(disabled)


# ----------------------------------------------------------------- cron jobs
_SAFE_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PROMPT_FRAME_RE = re.compile(r"(?m)^\*\*Prompt Characters:\*\* (\d+)\n## Prompt\n\n")
_RESPONSE_FRAME_RE = re.compile(r"(?m)^\*\*Response Characters:\*\* (\d+)\n## Response\n\n")
_MAX_REPORTS_PER_JOB = 10
_MAX_REPORTS = 40

_NO_REPORT_TEXT = "Nothing needed your attention on this run."
_FAILED_TEXT = (
    "This briefing could not be completed. It will run again at its next scheduled time."
)
_WEEKDAYS = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")


def extract_response(document: str) -> str | None:
    """The response half of a run document, or ``None``.

    The agent frames the prompt and response with their character counts, because
    either can quote the other's heading. Honouring the frame is what keeps the
    private prompt out of the result. Anything inconsistent yields ``None``, and
    so does a document with no response heading at all (script-mode runs), even
    though the agent's own reader would keep those whole.
    """
    prompt = _PROMPT_FRAME_RE.search(document)
    if prompt is not None:
        start = prompt.end() + int(prompt.group(1)) + len("\n\n")
        frame = _RESPONSE_FRAME_RE.match(document, start)
        if frame is None:
            return None
        tail = document[frame.end():]
        if len(tail) != int(frame.group(1)) + 1 or not tail.endswith("\n"):
            return None
        return tail[:-1].strip() or None
    if "## Response" not in document:
        return None
    # Unframed archives: the writer's boundary is the LAST occurrence.
    return document.rpartition("## Response")[2].strip() or None


def _report_body(document: str, secrets: list[str]) -> tuple[ReportStatus, str]:
    first_line = document.partition("\n")[0].rstrip()
    if first_line.endswith("(FAILED)"):
        # Failed documents end in a traceback. None of it is for the owner.
        return "failed", _FAILED_TEXT
    response = extract_response(document)
    if response is None or response.upper().startswith("[SILENT"):
        return "no_action", _NO_REPORT_TEXT
    return "success", scrub(response, secrets)


_BOLD_COUNT = re.compile(r"\*\*\s*(\d[\d,]*)\s+([A-Za-z][^*\n]{1,40}?)\s*\*\*")
_BOLD_LABEL = re.compile(r"\*\*\s*([A-Za-z][^*\n]{1,40}?)\s*:\s*\*\*\s*(\d[\d,]*)\b")


def extract_metrics(markdown: str, limit: int = 6) -> list[ReportMetric]:
    """Highlight pills from the counts a briefing already puts in bold."""
    found: dict[str, int] = {}
    for match in _BOLD_COUNT.finditer(markdown):
        found.setdefault(match.group(2).strip(), int(match.group(1).replace(",", "")))
    for match in _BOLD_LABEL.finditer(markdown):
        found.setdefault(match.group(1).strip(), int(match.group(2).replace(",", "")))
    return [ReportMetric(label=label, value=value) for label, value in list(found.items())[:limit]]


def _format_clock(hour: int, minute: int) -> str:
    suffix = "AM" if hour < 12 else "PM"
    return f"{hour % 12 or 12}:{minute:02d} {suffix}"


def _humanise_cron(expression: str) -> str | None:
    fields = expression.split()
    if len(fields) != 5:
        return None
    minute, hour, day, month, weekday = fields
    if month != "*":
        return None
    every_minutes = re.fullmatch(r"\*/(\d+)", minute)
    if every_minutes and (hour, day, weekday) == ("*", "*", "*"):
        return f"Every {every_minutes.group(1)} minutes"
    every_hours = re.fullmatch(r"\*/(\d+)", hour)
    if minute == "0" and every_hours and (day, weekday) == ("*", "*"):
        return f"Every {every_hours.group(1)} hours"
    if not (minute.isdigit() and hour.isdigit()):
        return None
    clock = _format_clock(int(hour), int(minute))
    if day == "*" and weekday == "*":
        return f"Every day at {clock}"
    if day == "*" and weekday.isdigit() and int(weekday) <= 7:
        return f"Every {_WEEKDAYS[int(weekday) % 7]} at {clock}"
    if day == "*" and weekday.lower() in {"1-5", "mon-fri"}:
        return f"Weekdays at {clock}"
    if weekday == "*" and day.isdigit():
        return f"Monthly on day {day} at {clock}"
    return None


def humanise_schedule(job: dict[str, Any]) -> str:
    schedule = job.get("schedule")
    if isinstance(schedule, dict):
        kind = schedule.get("kind")
        if kind == "cron" and isinstance(schedule.get("expr"), str):
            text = _humanise_cron(schedule["expr"])
            if text:
                return text
        if kind == "interval" and isinstance(schedule.get("minutes"), int):
            minutes = schedule["minutes"]
            if minutes % 1440 == 0:
                days = minutes // 1440
                return "Every day" if days == 1 else f"Every {days} days"
            if minutes % 60 == 0:
                hours = minutes // 60
                return "Every hour" if hours == 1 else f"Every {hours} hours"
            return f"Every {minutes} minutes"
        if kind == "once":
            return "One time"
    return "Custom schedule"


def read_jobs(files: TenantFiles) -> list[dict[str, Any]]:
    """Jobs from ``cron/jobs.json``, with the two historic shapes normalised."""
    raw = files.read_json("cron", "jobs.json")
    jobs = raw.get("jobs") if isinstance(raw, dict) else raw
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        return []
    return [
        job
        for job in jobs
        if isinstance(job, dict)
        and isinstance(job.get("id"), str)
        and _SAFE_JOB_ID.match(job["id"])
    ]


def _job_name(job: dict[str, Any]) -> str:
    name = job.get("name")
    return scrub(name) if isinstance(name, str) and name else "Scheduled briefing"


def _job_status(job: dict[str, Any]) -> str:
    state = job.get("state")
    if job.get("enabled") is False or state in {"paused", "completed"}:
        return "paused"
    if state == "error" or job.get("last_status") == "error":
        return "error"
    return "scheduled"


def _run_durations(files: TenantFiles) -> dict[str, list[tuple[float, int]]]:
    """``job_id -> [(finished_epoch, duration_ms)]`` from the usage audit log.

    Parsed field by field: these lines also hold the model name, so nothing else
    is read from them.
    """
    text = files.read_tail("cron", "usage_audit.jsonl") or ""
    runs: dict[str, list[tuple[float, int]]] = {}
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        finished = _from_iso(record.get("ts"))
        duration = record.get("duration_ms")
        job_id = record.get("job_id")
        if finished and isinstance(duration, int) and isinstance(job_id, str):
            runs.setdefault(job_id, []).append((finished.timestamp(), duration))
    return runs


def _duration_for(
    runs: list[tuple[float, int]], executed_at: datetime
) -> int | None:
    """The audit row written alongside this document, if one is close enough."""
    target = executed_at.timestamp()
    best = min(runs, key=lambda run: abs(run[0] - target), default=None)
    return best[1] if best and abs(best[0] - target) <= 120 else None


def read_report_feed(files: TenantFiles) -> CronReportFeed:
    jobs = read_jobs(files)
    config = read_config(files)
    zone = _tenant_timezone(files, config)
    secrets = known_secrets(files)
    durations = _run_durations(files)

    summaries: list[CronJobSummary] = []
    reports: list[CronReport] = []
    for job in jobs:
        job_id = job["id"]
        name = _job_name(job)
        schedule = humanise_schedule(job)
        if job.get("state") != "completed":
            summaries.append(
                CronJobSummary(
                    id=job_id,
                    job_name=name,
                    schedule_human=schedule,
                    status=_job_status(job),  # type: ignore[arg-type]
                    next_run_at=_from_iso(job.get("next_run_at")),
                    last_run_at=_from_iso(job.get("last_run_at")),
                )
            )

        names = list(reversed(
            files.list_regular_names("cron", "output", job_id, suffix=".md")
        ))[:_MAX_REPORTS_PER_JOB]

        for filename in names:
            stem = filename[: -len(".md")]
            try:
                executed_at = datetime.strptime(stem, "%Y-%m-%d_%H-%M-%S").replace(tzinfo=zone)
            except ValueError:
                continue
            document = files.read_text("cron", "output", job_id, filename)
            if document is None:
                continue
            report_status, body = _report_body(document, secrets)
            reports.append(
                CronReport(
                    id=f"{job_id}-{stem}",
                    job_id=job_id,
                    job_name=name,
                    schedule_human=schedule,
                    executed_at=executed_at,
                    duration_ms=_duration_for(durations.get(job_id, []), executed_at),
                    status=report_status,
                    summary_markdown=body,
                    metrics_json=extract_metrics(body) if report_status == "success" else [],
                )
            )

    reports.sort(key=lambda report: report.executed_at, reverse=True)
    return CronReportFeed(jobs=summaries, reports=reports[:_MAX_REPORTS])


# ------------------------------------------------------------------- activity
@dataclass
class Activity:
    """Derived from ``state.db``. ``None`` means no data, not zero."""

    tasks_30d: int | None = None
    trend_pct: float | None = None
    daily: list[int] = field(default_factory=list)
    avg_response_seconds: float | None = None
    #: Session source -> (messages in the last 24h, last message epoch).
    by_source: dict[str, tuple[int, float | None]] = field(default_factory=dict)


def read_activity(files: TenantFiles, now: float | None = None) -> Activity:
    """Read-only queries against the agent's session database.

    A tenant on an older schema, or whose database is locked, gets ``None``s and
    a dash in the portal. It must never cost the owner the rest of the page.
    """
    current = now if now is not None else time.time()
    day = 86_400.0
    with files.readonly_uri("state.db") as uri:
        if uri is None:
            return Activity()
        try:
            connection = sqlite3.connect(uri, uri=True, timeout=1.0)
        except (OSError, sqlite3.Error, ValueError):
            return Activity()

        try:
            connection.execute("PRAGMA query_only = ON")
            activity = Activity()

            rows = connection.execute(
                "SELECT CAST((? - timestamp) / ? AS INTEGER) AS age, COUNT(*) "
                "FROM messages WHERE role = 'tool' AND timestamp >= ? GROUP BY age",
                (current, day, current - 60 * day),
            ).fetchall()
            by_age = {int(age): int(count) for age, count in rows}
            activity.daily = [by_age.get(age, 0) for age in range(29, -1, -1)]
            activity.tasks_30d = sum(activity.daily)
            previous = sum(count for age, count in by_age.items() if 30 <= age < 60)
            if previous:
                activity.trend_pct = round((activity.tasks_30d - previous) / previous * 100, 1)

            row = connection.execute(
                """
                SELECT AVG(next_at - at) FROM (
                    SELECT m.role AS role, m.timestamp AS at,
                           LEAD(m.role) OVER turn AS next_role,
                           LEAD(m.timestamp) OVER turn AS next_at
                    FROM messages m JOIN sessions s ON s.id = m.session_id
                    WHERE m.timestamp >= ? AND s.source NOT IN ('cron', 'cli')
                    WINDOW turn AS (PARTITION BY m.session_id ORDER BY m.id)
                )
                WHERE role = 'user' AND next_role = 'assistant'
                  AND next_at - at BETWEEN 0 AND 3600
                """,
                (current - 30 * day,),
            ).fetchone()
            if row and row[0] is not None:
                activity.avg_response_seconds = round(float(row[0]), 1)

            for source, volume, last_at in connection.execute(
                """
                SELECT s.source,
                       SUM(CASE WHEN m.timestamp >= ? THEN 1 ELSE 0 END),
                       MAX(m.timestamp)
                FROM messages m JOIN sessions s ON s.id = m.session_id
                WHERE m.role IN ('user', 'assistant')
                GROUP BY s.source
                """,
                (current - day,),
            ):
                activity.by_source[str(source)] = (int(volume or 0), last_at)
            return activity
        except sqlite3.Error as exc:
            logger.warning("Could not read activity for %s: %s", files.root.name, exc)
            return Activity()
        finally:
            connection.close()


# ------------------------------------------------------------------- gateway
def read_gateway(files: TenantFiles) -> dict[str, Any]:
    state = files.read_json("gateway_state.json")
    return state if isinstance(state, dict) else {}


# ------------------------------------------------------------------ channels
@dataclass(frozen=True)
class ChannelSpec:
    name: ChannelName
    #: Keys in ``gateway_state.json``, which are also session sources in state.db.
    platforms: tuple[str, ...]
    allow_env: str | None = None
    allow_all_env: str | None = None
    identity_pattern: str | None = None
    identity_keys: tuple[str, ...] = ()


CHANNELS: tuple[ChannelSpec, ...] = (
    ChannelSpec(
        "whatsapp",
        ("whatsapp", "whatsapp_cloud"),
        "WHATSAPP_ALLOWED_USERS",
        "WHATSAPP_ALLOW_ALL_USERS",
        r"^\+?[1-9][0-9]{6,14}$",
        ("number", "phone", "whatsapp_number"),
    ),
    ChannelSpec(
        "telegram",
        ("telegram",),
        "TELEGRAM_ALLOWED_USERS",
        "TELEGRAM_ALLOW_ALL_USERS",
        r"^[0-9]{5,20}$",
        ("handle", "bot_username", "username"),
    ),
    ChannelSpec(
        "slack",
        ("slack",),
        "SLACK_ALLOWED_USERS",
        "SLACK_ALLOW_ALL_USERS",
        r"^[UW][A-Z0-9]{8,20}$",
        ("handle", "workspace"),
    ),
    ChannelSpec("web_widget", ("webhook",), identity_keys=("handle", "domain", "url")),
)
CHANNEL_BY_NAME = {spec.name: spec for spec in CHANNELS}

WHATSAPP_SESSION_PARTS = ("platforms", "whatsapp", "session")

#: Calling codes of two digits; everything not starting with 1 or 7 is otherwise
#: three digits. Enough to place the space in a masked number correctly.
_TWO_DIGIT_CODES = frozenset(
    "20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 "
    "60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split()
)


def mask_phone(value: str, keep_last: int = 0) -> str:
    """``8801712345678`` -> ``+880 17XX-XXXXXX``."""
    digits = re.sub(r"\D", "", value)
    if len(digits) < 7:
        return "XXXX"
    if digits[0] in "17":
        code_length = 1
    elif digits[:2] in _TWO_DIGIT_CODES:
        code_length = 2
    else:
        code_length = 3
    code, rest = digits[:code_length], digits[code_length:]
    tail = rest[4:]
    kept = tail[-keep_last:] if keep_last else ""
    return f"+{code} {rest[:2]}XX-{'X' * (len(tail) - len(kept))}{kept}"


def _mask_identity(spec: ChannelSpec, value: str) -> str:
    if spec.name == "whatsapp":
        return mask_phone(value, keep_last=3)
    if spec.name == "telegram":
        return f"ID {'X' * max(len(value) - 4, 2)}{value[-4:]}"
    return f"{value[:1]}{'X' * max(len(value) - 4, 2)}{value[-3:]}"


def _entry_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _split_allowlist(raw: str | None) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def _linked_whatsapp_number(files: TenantFiles) -> str | None:
    """The paired number from the bridge's credentials file.

    That file also holds the session's encryption keys, so exactly one field is
    read out and the rest is discarded here.
    """
    creds = files.read_json(*WHATSAPP_SESSION_PARTS, "creds.json")
    me = creds.get("me") if isinstance(creds, dict) else None
    identity = me.get("id") if isinstance(me, dict) else None
    if not isinstance(identity, str):
        return None
    match = re.match(r"(\d{7,15})", identity)
    return match.group(1) if match else None


def whatsapp_is_linked(files: TenantFiles) -> bool:
    return _linked_whatsapp_number(files) is not None


def _masked_handle(
    spec: ChannelSpec, recorded: dict[str, Any], files: TenantFiles
) -> str | None:
    if spec.name == "whatsapp":
        number = _linked_whatsapp_number(files)
        if number:
            return mask_phone(number)
    entry = recorded.get(spec.name)
    value: Any = entry
    if isinstance(entry, dict):
        value = next((entry[key] for key in spec.identity_keys if entry.get(key)), None)
    if not isinstance(value, str) or not value or mentions_internals(value):
        return None
    if spec.name == "whatsapp":
        return mask_phone(value)
    if spec.name == "telegram" and not value.startswith("@"):
        return f"@{value}"
    return value


_GATEWAY_DOWN_STATES = frozenset({"stopped", "startup_failed"})


def _channel_status(
    spec: ChannelSpec, gateway: dict[str, Any], is_recorded: bool
) -> tuple[str, str | None]:
    platforms = gateway.get("platforms")
    platforms = platforms if isinstance(platforms, dict) else {}
    entry = next(
        (platforms[key] for key in spec.platforms if isinstance(platforms.get(key), dict)),
        None,
    )
    if entry is None:
        return ("disconnected" if is_recorded else "not_configured"), None
    if gateway.get("gateway_state") in _GATEWAY_DOWN_STATES:
        return "disconnected", None
    if entry.get("needs_attention") or entry.get("error_code"):
        attention = (
            "Your WhatsApp link has expired. Re-link it with a QR scan."
            if spec.name == "whatsapp"
            else "This channel needs to be reconnected."
        )
        return "action_needed", attention
    state = entry.get("state")
    if state == "connected":
        return "connected", None
    if state in {"connecting", "retrying"}:
        return "connecting", None
    return "disconnected", None


def _epoch_to_datetime(value: float | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc)


def _stt_enabled(config: dict[str, Any]) -> bool:
    section = config.get("stt")
    return section.get("enabled", True) is not False if isinstance(section, dict) else True


def read_channels(client: Client, files: TenantFiles) -> list[PortalChannel]:
    gateway = read_gateway(files)
    env = read_env(files)
    config = read_config(files)
    activity = read_activity(files)
    recorded = client.channels if isinstance(client.channels, dict) else {}

    channels: list[PortalChannel] = []
    for spec in CHANNELS:
        status_name, attention = _channel_status(spec, gateway, bool(recorded.get(spec.name)))
        allow_values = _split_allowlist(env.get(spec.allow_env)) if spec.allow_env else []
        allow_all = "*" in allow_values or (
            bool(spec.allow_all_env)
            and str(env.get(spec.allow_all_env, "")).lower() in {"1", "true", "yes"}
        )

        volume = 0
        last_at: float | None = None
        seen = False
        for source in spec.platforms:
            if source in activity.by_source:
                seen = True
                count, last = activity.by_source[source]
                volume += count
                if last is not None and (last_at is None or last > last_at):
                    last_at = last

        channels.append(
            PortalChannel(
                channel=spec.name,
                status=status_name,  # type: ignore[arg-type]
                session_verified=(
                    status_name == "connected"
                    and (spec.name != "whatsapp" or whatsapp_is_linked(files))
                ),
                masked_handle=_masked_handle(spec, recorded, files),
                last_message_at=_epoch_to_datetime(last_at),
                messages_24h=volume if seen or activity.tasks_30d is not None else None,
                allowlist=[
                    AllowlistEntry(id=_entry_id(value), display=_mask_identity(spec, value))
                    for value in allow_values
                    if value != "*"
                ],
                allow_all=allow_all,
                voice_transcription=_stt_enabled(config) if spec.name == "telegram" else None,
                attention=attention,
            )
        )
    return channels


def _set_env_value(files: TenantFiles, key: str, value: str) -> None:
    """Edit one line of ``.env`` in place, keeping every other line byte for byte."""
    with files.locked(".env"):
        text = files.read_text(".env")
        if text is None:
            raise PortalError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "portal_data_unavailable",
                "This setting cannot be changed right now. Please try again shortly.",
            )
        line = f"{key}={value}"
        pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
        if pattern.search(text):
            updated = pattern.sub(lambda _: line, text, count=1)
        else:
            separator = "" if text.endswith("\n") or not text else "\n"
            updated = f"{text}{separator}{line}\n"
        files.write_atomic(updated, ".env")


def update_allowlist(
    spec: ChannelSpec, files: TenantFiles, add: list[str], remove_ids: list[str]
) -> None:
    """Change who may message the Coordinator on one channel.

    The agent re-reads ``.env`` on every turn and its WhatsApp adapter checks the
    live value, so this needs no restart. Values are held to a strict pattern
    because they land on a line of ``.env``, and a newline here would let a
    caller set any variable in the tenant's environment.
    """
    if not spec.allow_env or not spec.identity_pattern:
        raise PortalError(
            status.HTTP_404_NOT_FOUND,
            "channel_has_no_allowlist",
            "This channel does not use an approved list.",
        )
    additions: list[str] = []
    for raw in add:
        value = raw.strip().replace(" ", "").replace("-", "")
        if not re.fullmatch(spec.identity_pattern, value):
            raise PortalError(
                422,
                "allowlist_invalid_entry",
                "Enter numbers with the country code, such as +8801712345678."
                if spec.name == "whatsapp"
                else "Enter a valid account ID.",
            )
        # The agent's documented format: country code, no plus sign.
        additions.append(value.lstrip("+"))

    current = _split_allowlist(read_env(files).get(spec.allow_env))
    if "*" in current:
        raise PortalError(
            status.HTTP_409_CONFLICT,
            "allowlist_open",
            "This channel currently answers everyone. Ask your account manager to "
            "restrict it before managing an approved list.",
        )
    removing = set(remove_ids)
    kept = [value for value in current if _entry_id(value) not in removing]
    updated = list(dict.fromkeys([*kept, *additions]))
    _set_env_value(files, spec.allow_env, ",".join(updated))


# -------------------------------------------------------------------- uptime
_DOCKER_FRACTION = re.compile(r"\.(\d{6})\d+")


def _from_docker_time(value: str | None) -> datetime | None:
    """Docker writes nanoseconds, and ``0001-01-01`` for "never"."""
    if not value or value.startswith("0001-"):
        return None
    return _from_iso(_DOCKER_FRACTION.sub(r".\1", value))


def estimate_uptime(
    *,
    container_state: str,
    started_at: str | None,
    finished_at: str | None,
    provisioned_at: datetime | None,
    now: datetime | None = None,
) -> float | None:
    """Availability over the last 30 days from Docker's record of the last outage.

    Docker keeps only the most recent stop and start, so this is an upper bound:
    earlier outages in the window are invisible to it. A real figure needs
    continuous sampling, which the hub does not do.
    """
    # "unknown" means the daemon did not answer, which says nothing about the tenant.
    if provisioned_at is None or container_state == "unknown":
        return None
    current = now or datetime.now(timezone.utc)
    if provisioned_at.tzinfo is None:
        provisioned_at = provisioned_at.replace(tzinfo=timezone.utc)
    window_start = max(provisioned_at, current - timedelta(days=30))
    window = (current - window_start).total_seconds()
    if window <= 0:
        return None

    started = _from_docker_time(started_at)
    finished = _from_docker_time(finished_at)
    if container_state == "running":
        if not finished or not started or finished >= started:
            downtime = 0.0
        else:
            downtime = max(0.0, (started - max(finished, window_start)).total_seconds())
    elif finished:
        downtime = (current - max(finished, window_start)).total_seconds()
    else:
        downtime = window
    return round(max(0.0, 100.0 * (1.0 - downtime / window)), 2)
