"""Sync the agency's master skill library into a client's skill directory.

``shared-skills/`` is the single source of truth. Each client gets a plain copy
on disk, bind-mounted read-only into its container, filtered by the skills the
client's plan includes.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path, PurePosixPath

from ..config.settings import Settings

logger = logging.getLogger(__name__)

SKILL_MANIFEST = "SKILL.md"
ROUTER_SKILL = "ai-employee-orchestrator"
#: Exclusive to e-commerce clients, whichever package they are on.
ECOMMERCE_SKILLS = frozenset({"order-desk-ecommerce", "catalog-keeper-ecommerce"})


def available_skills(settings: Settings) -> list[str]:
    """Every skill directory in the shared library, sorted by name."""
    root = settings.shared_skills_dir
    if not root.is_dir():
        return []
    return sorted(
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() and (entry / SKILL_MANIFEST).is_file()
    )


def skills_for_plan(settings: Settings, plan: str) -> list[str]:
    """Resolve the skill set a plan is entitled to, against what exists."""
    everything = available_skills(settings)
    allowed = settings.plan_for(plan).skills
    if not allowed:
        return everything
    missing = [name for name in allowed if name not in everything]
    if missing:
        logger.warning("Plan %s references unknown skills: %s", plan, missing)
    return [name for name in everything if name in allowed]


def skills_for_client(
    settings: Settings,
    plan: str,
    business_mode: str = "general",
    requested: list[str] | None = None,
) -> list[str]:
    """The plan's skills, adjusted for the business model and the starter kit.

    E-commerce skills belong to the business model rather than to a package, so
    they are added on every plan and removed from general businesses on every
    plan. ``requested`` narrows the result to a kit's selection, but cannot grant
    a skill the plan excludes. The router always stays: without it nothing routes.
    """
    everything = available_skills(settings)
    entitled = set(skills_for_plan(settings, plan))
    if business_mode == "ecommerce":
        entitled |= ECOMMERCE_SKILLS & set(everything)
    else:
        entitled -= ECOMMERCE_SKILLS
    if requested:
        entitled &= set(requested) | {ROUTER_SKILL}
    return [name for name in everything if name in entitled]


def _sync_sync(
    source_root: Path,
    target_root: Path,
    skills: list[str],
    protected: frozenset[str] = frozenset(),
) -> list[str]:
    """Blocking half of the sync; runs in a worker thread.

    ``protected`` names are never pruned. The shared agency library is
    bind-mounted read-only *inside* this directory, so its mount point looks
    like an unentitled skill to the prune pass below — deleting it would be
    both wrong and (while the container runs) impossible.
    """
    target_root.mkdir(parents=True, exist_ok=True)

    # Drop skills the client is no longer entitled to before copying.
    for existing in target_root.iterdir():
        if (
            existing.is_dir()
            and existing.name not in skills
            and existing.name not in protected
        ):
            shutil.rmtree(existing, ignore_errors=True)

    synced: list[str] = []
    for name in skills:
        source = source_root / name
        if not source.is_dir():
            continue
        destination = target_root / name
        shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        synced.append(name)
    return synced


async def sync_skills(
    settings: Settings,
    subdomain: str,
    plan: str,
    business_mode: str = "general",
    requested: list[str] | None = None,
) -> list[str]:
    """Mirror the client's skills into the tenant's skill dir; report what landed.

    This is the per-tenant *writable* copy, filtered by plan and business model.
    It is distinct from the shared agency library, which is bind-mounted read-only
    at ``settings.shared_skills_mount`` so every tenant sees the same canonical
    skills without being able to modify them.
    """
    skills = skills_for_client(settings, plan, business_mode, requested)
    target = settings.tenant_dir_for(subdomain) / "skills"
    # The read-only shared library mounts at <mount>/agency_core, which lands
    # inside this same directory; keep its mount point out of the prune pass.
    protected = frozenset({PurePosixPath(settings.shared_skills_mount).name})
    synced = await asyncio.to_thread(
        _sync_sync, settings.shared_skills_dir, target, skills, protected
    )
    logger.info("Synced %d skill(s) to %s: %s", len(synced), subdomain, synced)
    return synced
