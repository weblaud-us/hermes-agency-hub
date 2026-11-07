"""The white-label boundary, in both directions.

**Outbound**, anything derived from tenant files or the agent is text the agent
could have written, and the agent freely mentions its own platform, paths and
ports. :func:`scrub` rewrites that vocabulary, and :func:`mentions_internals`
identifies text that should not be shown at all.

**Inbound**, a business rule is written into ``MEMORY.md``, which the agent reads
as trusted context at the start of every session. :func:`validate_business_rule`
rejects text shaped like instructions to the agent rather than facts about the
business. That raises the bar considerably and is not a proof: a pattern list
cannot recognise every paraphrase, so the agent's own memory scanner remains the
second layer.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

from fastapi import status

from .errors import PortalError

# ------------------------------------------------------------------ outbound
_REPLACEMENTS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in (
        # Secrets first, so a key is never partly rewritten by a later rule.
        (r"\bsk-[A-Za-z0-9][A-Za-z0-9._-]{7,}", "[redacted]"),
        (r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", "[redacted]"),
        (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "[redacted]"),
        (
            r"\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*\S+",
            "[redacted]",
        ),
        (r"\bscrypt\$\S+", "[redacted]"),
        # Filesystem layout. Longest prefixes first.
        (r"/srv/hermes-multi\S*", "[internal]"),
        (r"/opt/data\S*", "[internal]"),
        (r"~?/?\.hermes\S*", "[internal]"),
        (r"\b(?:SOUL|AGENTS|CLAUDE)\.md\b", "[internal]"),
        (r"(?<![\w.])\.env\b", "[internal]"),
        (r"\bconfig\.yaml\b", "[internal]"),
        (r"\bagency_core\b", "agency skills"),
        # Vendors and product names.
        (r"\bhermes[\s_-]+agent\b", "your AI Coordinator"),
        (r"\bnous[\s_-]+research\b", "your provider"),
        (r"\bnousresearch\b", "your provider"),
        (r"\bopen[\s_-]?router\b", "your AI provider"),
        (r"\bhermes\b", "Coordinator"),
        # Infrastructure. Bare "container" stays: shops ship goods in them.
        (r"\bdocker(?:[\s_-]+(?:container|compose|image|daemon|socket))?\b", "the platform"),
        (r"\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)(?::\d{2,5})?", "[internal]"),
        (r"\bport\s+(?:8601|8642|9101|9119|19[0-9]{3})\b", "[internal]"),
        (r":(?:8601|8642|9101|9119|19[0-9]{3})\b", ""),
        (r"\bu?id[\s=:]+1000[01]\b", "[internal]"),
    )
)

#: Text matching any of these reveals how the service is built. Separate from
#: :data:`_REPLACEMENTS` because an agent note about its own environment is
#: dropped from view rather than rewritten into nonsense.
_INTERNAL_MARKERS = re.compile(
    r"\bhermes\b|\bnous\b|nousresearch|\bopen[\s_-]?router\b|\bdocker\b"
    r"|/srv/|/opt/data|\.hermes\b|(?<![\w.])\.env\b|\bconfig\.yaml\b"
    r"|\b(?:SOUL|AGENTS|CLAUDE|USER)\.md\b|\bagency_core\b"
    r"|\bsk-[A-Za-z0-9]|\bBearer\s+\S|\bscrypt\$"
    r"|\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]"
    r"|\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost)\b"
    r"|\b(?:8601|8642|9101|9119|1000[01])\b",
    re.IGNORECASE,
)


def scrub(text: str, secrets: Iterable[str] = ()) -> str:
    """Remove platform vocabulary and credentials from tenant-derived text.

    ``secrets`` are exact values to strip regardless of their shape: the tenant's
    own keys read from its ``.env``. A pattern can miss a key that an agent
    prints in an unusual form; an exact match cannot.
    """
    for secret in sorted((s for s in secrets if s), key=len, reverse=True):
        text = text.replace(secret, "[redacted]")
    for pattern, replacement in _REPLACEMENTS:
        text = pattern.sub(replacement, text)
    return text


def mentions_internals(text: str) -> bool:
    return bool(_INTERNAL_MARKERS.search(text))


# ------------------------------------------------------------------- inbound
RULE_MIN_LENGTH = 3
RULE_MAX_LENGTH = 400

#: The agent splits MEMORY.md on this character's delimiter, and a rule that
#: contained it could forge a second entry.
_ENTRY_SEPARATOR = "§"

#: Instruction-shaped text, not business facts. Ordinary uses such as "Ignore
#: orders without payment" stay allowed: the verb alone is never the trigger.
_INJECTION_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier"
        r"|system|your|all|these|those|initial|original)\b.{0,30}"
        r"\b(instructions?|rules?|prompts?|messages?|guidelines?|directives?|polic(y|ies))\b",
        r"\b(system|developer|hidden|initial)\s+(prompt|message|instructions?)\b",
        r"\bguardrails?\b|\bjail\s?break",
        r"\byou\s+(are|must)\s+now\b|\bfrom\s+now\s+on\s+you\b",
        r"\b(act|behave|respond|pretend)\s+(as|like)\s+(if\s+)?(you|an?\s+)",
        r"\bnew\s+(instructions?|persona|role)\b",
        r"\b(reveal|print|show|output|repeat|leak|dump|expose|share)\b.{0,40}"
        r"\b(prompt|instructions?|config(uration)?|secrets?|credentials?|api\s*keys?"
        r"|tokens?|passwords?|environment)\b",
        r"(send|post|upload|transmit|forward|exfiltrate)\b.{0,120}\b(to|at)\s+https?://",
        r"\b(curl|wget|bash|powershell|sudo|chmod|rm\s+-rf|nc\s+-|authorized_keys)\b",
        r"\b(SOUL|AGENTS|CLAUDE|MEMORY|USER|SKILL)\.md\b|\bconfig\.yaml\b|(?<![\w.])\.env\b",
        r"\b(hermes|nous\s*research|openrouter|docker)\b",
        # Chat-template and role markers.
        r"<\|[^|]*\|>|\[/?(INST|SYS|SYSTEM)\]|<<\s*/?SYS\s*>>",
        r"^\s*(system|assistant|developer|user|human|ai)\s*:",
        r"(?:api[_-]?key|token|secret|password)\s*[=:]",
    )
)

#: Markup that restructures the file, or that renders as something else later.
_MARKUP = re.compile(r"[<>`]|^\s*(#{1,6}\s|-{3,}|={3,}|>)")


def _rejected(detail: str) -> PortalError:
    return PortalError(
        422, "memory_rule_rejected", detail
    )


def validate_business_rule(text: str) -> str:
    """Normalise a rule to one clean line, or raise a :class:`PortalError`.

    The rejection message never names the pattern that matched, which would be a
    guide to rephrasing around it.
    """
    # NFKC first: fullwidth letters and similar forms would otherwise slip past
    # every pattern below while reading identically to the agent's tokenizer.
    normalised = unicodedata.normalize("NFKC", text)
    for char in normalised:
        # Cf covers zero-width characters and bidi overrides; Cc covers control
        # characters. Newlines are collapsed below rather than rejected here.
        if char not in "\r\n\t" and unicodedata.category(char) in {"Cc", "Cf"}:
            raise _rejected("That rule contains characters that cannot be saved.")

    cleaned = " ".join(normalised.split())
    if len(cleaned) < RULE_MIN_LENGTH:
        raise _rejected("Write the rule as a short sentence.")
    if len(cleaned) > RULE_MAX_LENGTH:
        raise _rejected(f"Keep each rule under {RULE_MAX_LENGTH} characters.")
    if _ENTRY_SEPARATOR in cleaned:
        raise _rejected(f"Rules cannot contain the {_ENTRY_SEPARATOR} character.")
    if _MARKUP.search(cleaned):
        raise _rejected("Rules are plain text. Remove any formatting or angle brackets.")
    if any(pattern.search(cleaned) for pattern in _INJECTION_PATTERNS):
        raise _rejected(
            "That reads like an instruction to the Coordinator rather than a fact "
            "about your business. Describe the policy, price or procedure instead."
        )
    return cleaned


def validate_business_field(text: str, *, label: str, max_length: int) -> str:
    """Like :func:`validate_business_rule`, for a named form field that may be empty.

    The business setup form is compiled into ``SOUL.md`` and ``MEMORY.md``, so each
    field gets the same screening as a memory rule, with its own length cap and a
    message that names the field the owner is looking at.
    """
    normalised = unicodedata.normalize("NFKC", text)
    for char in normalised:
        if char not in "\r\n\t" and unicodedata.category(char) in {"Cc", "Cf"}:
            raise PortalError(422, "business_field_rejected", f"{label} contains characters that cannot be saved.")
    cleaned = " ".join(normalised.split())
    if not cleaned:
        return ""
    if len(cleaned) > max_length:
        raise PortalError(422, "business_field_rejected", f"Keep {label} under {max_length} characters.")
    if _ENTRY_SEPARATOR in cleaned:
        raise PortalError(
            422, "business_field_rejected", f"{label} cannot contain the {_ENTRY_SEPARATOR} character."
        )
    if _MARKUP.search(cleaned):
        raise PortalError(
            422, "business_field_rejected", f"{label} is plain text. Remove any formatting or angle brackets."
        )
    if any(pattern.search(cleaned) for pattern in _INJECTION_PATTERNS):
        raise PortalError(
            422,
            "business_field_rejected",
            f"{label} reads like an instruction to the Coordinator rather than a fact about "
            "your business. Describe the policy, price or procedure instead.",
        )
    return cleaned
