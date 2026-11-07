"""Reusable industry starter kits, and a read of the agency skill library."""

from __future__ import annotations

import asyncio
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.skills import ECOMMERCE_SKILLS, ROUTER_SKILL, SKILL_MANIFEST
from ..config.settings import Settings
from .models import StarterKitOverride

_CORE = ["ai-employee-orchestrator", "social-media-autopilot", "designer-brand-studio", "roi-weekly-reporter"]

DEFAULT_KITS: dict[str, dict[str, Any]] = {
    "dental_clinic": {
        "name": "Dental Clinic",
        "business_mode": "general",
        "description": "Appointment booking, treatment enquiries and recall reminders.",
        "skills": [*_CORE, "sales-rep-inbox", "email-outreach-assistant"],
        "knowledge_checklist": ["Treatment list and price ranges", "Doctor schedule", "Clinic location and parking", "Emergency policy"],
    },
    "beauty_salon": {
        "name": "Beauty Salon",
        "business_mode": "general",
        "description": "Service bookings, packages and before-and-after social content.",
        "skills": [*_CORE, "video-reel-editor", "sales-rep-inbox"],
        "knowledge_checklist": ["Service menu and durations", "Stylist availability", "Package offers", "Cancellation policy"],
    },
    "restaurant": {
        "name": "Restaurant",
        "business_mode": "general",
        "description": "Table reservations, menu questions and daily specials.",
        "skills": [*_CORE, "video-reel-editor", "web-seo-manager"],
        "knowledge_checklist": ["Menu with allergens", "Opening hours", "Reservation rules", "Delivery areas"],
    },
    "travel_agency": {
        "name": "Travel Agency",
        "business_mode": "general",
        "description": "Trip enquiries, itinerary quotes, booking follow-ups and seasonal offers.",
        "skills": [*_CORE, "video-reel-editor", "sales-rep-inbox", "email-outreach-assistant", "web-seo-manager"],
        "knowledge_checklist": ["Destinations and package list", "Supplier and airline contacts", "Payment and cancellation terms", "Visa and travel-document guidance"],
    },
    "ecommerce_store": {
        "name": "E-Commerce Brand",
        "business_mode": "ecommerce",
        "description": "Catalog answers, COD confirmation, courier booking and stock alerts.",
        "skills": [*_CORE, "video-reel-editor", "ads-growth-manager", "sales-rep-inbox", "order-desk-ecommerce", "catalog-keeper-ecommerce"],
        "knowledge_checklist": ["Product catalog with sizes", "Delivery charges by area", "Courier accounts", "Return and exchange policy"],
    },
}
_EDITABLE = ("description", "skills", "knowledge_checklist")


class KitNotFoundError(LookupError):
    pass


async def list_kits(session: AsyncSession) -> list[dict[str, Any]]:
    overrides = {
        row.key: row.data for row in (await session.execute(select(StarterKitOverride))).scalars()
    }
    return [
        {"key": key, **kit, **overrides.get(key, {}), "customised": key in overrides}
        for key, kit in DEFAULT_KITS.items()
    ]


async def update_kit(session: AsyncSession, key: str, changes: dict[str, Any]) -> None:
    if key not in DEFAULT_KITS:
        raise KitNotFoundError(key)
    row = await session.get(StarterKitOverride, key)
    filtered = {field: changes[field] for field in _EDITABLE if field in changes}
    if row is None:
        session.add(StarterKitOverride(key=key, data=filtered))
    else:
        row.data = {**row.data, **filtered}
    await session.flush()


async def reset_kit(session: AsyncSession, key: str) -> None:
    if key not in DEFAULT_KITS:
        raise KitNotFoundError(key)
    row = await session.get(StarterKitOverride, key)
    if row is not None:
        await session.delete(row)
        await session.flush()


def _read_skill(settings: Settings, name: str) -> dict[str, Any]:
    text = (settings.shared_skills_dir / name / SKILL_MANIFEST).read_text(encoding="utf-8")
    meta: dict[str, Any] = {}
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            try:
                loaded = yaml.safe_load(parts[1])
                meta = loaded if isinstance(loaded, dict) else {}
            except yaml.YAMLError:
                meta = {}
    group = (
        "router" if name == ROUTER_SKILL
        else "ecommerce" if name in ECOMMERCE_SKILLS
        else "core"
    )
    return {
        "id": name,
        "description": str(meta.get("description") or ""),
        "group": group,
        "markdown": text,
    }


async def read_skill_library(settings: Settings) -> list[dict[str, Any]]:
    from ..clients.skills import available_skills

    def _read_all() -> list[dict[str, Any]]:
        return [_read_skill(settings, name) for name in available_skills(settings)]

    return await asyncio.to_thread(_read_all)
