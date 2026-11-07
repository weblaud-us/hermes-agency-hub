"""What the agent knows about the business: profile, policies, FAQs and price list.

Three files under the tenant's data directory carry it:

=====================  ==========================================================
``business_profile.json``  the owner's structured setup, exactly as saved
``catalog.json``           products or services with prices; read by the agent and
                           by the social autopilot
``SOUL.md``                the agent's persona. A marked block is compiled from the
                           profile; everything outside the markers is left alone
``memories/MEMORY.md``     compact ``Business profile:`` lines, replaced on each save
=====================  ==========================================================

Memory is capped (2,200 characters unless the tenant's config says otherwise), so only
the lines that matter in every conversation go there. The full policies and every FAQ
live in the ``SOUL.md`` block, which has no cap.

All of this blocks, so callers run it through ``asyncio.to_thread``.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import status
from pydantic import ValidationError

from ..clients.models import Client
from ..config.settings import Settings
from ..ops.social import effective_brand_kit
from . import readers
from .errors import PortalError
from .knowledge_schemas import (
    MAX_CATALOG_ITEMS,
    BrandKitSetup,
    BusinessSetup,
    BusinessSetupView,
    CatalogImport,
    CatalogImportResult,
    CatalogItem,
    CatalogItemInput,
    CatalogView,
    Faq,
)
from .sanitize import validate_business_field
from .tenant_files import MAX_FILE_BYTES, TenantFiles

logger = logging.getLogger(__name__)

PROFILE_FILE = "business_profile.json"
CATALOG_FILE = "catalog.json"
SOUL_FILE = "SOUL.md"
SOUL_START = "<!-- BEGIN business profile: written by the client portal, rewritten on every save -->"
SOUL_END = "<!-- END business profile -->"
MEMORY_PREFIX = "Business profile:"
#: One memory line is a fact, not a document.
_MEMORY_LINE_MAX = 420
#: These files hold no secrets and the agent runs as another user, so group-readable.
_DATA_MODE = 0o644


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def files_for(settings: Settings, client: Client) -> TenantFiles:
    return readers.files_for(settings, client)


# ================================================================= business setup
def default_setup(client: Client) -> BusinessSetup:
    """What the form shows before the owner has saved anything."""
    kit = effective_brand_kit(client)
    return BusinessSetup(
        company_name=client.company_name,
        business_mode=client.business_mode.value,  # type: ignore[arg-type]
        website_url=kit.get("website_url"),
        brand_kit=BrandKitSetup(
            primary_color=kit["primary_color"],
            accent_color=kit["accent_color"],
            logo_text=kit["logo_text"],
            default_cta=kit["contact_cta"],
        ),
    )


def _load_profile(files: TenantFiles) -> tuple[dict[str, Any] | None, str | None]:
    data = files.read_json(PROFILE_FILE)
    if not isinstance(data, dict):
        return None, None
    updated_at = data.get("updated_at") if isinstance(data.get("updated_at"), str) else None
    body = {key: value for key, value in data.items() if key not in {"updated_at", "schema"}}
    return body, updated_at


def read_setup(files: TenantFiles, client: Client) -> BusinessSetupView:
    body, updated_at = _load_profile(files)
    base = default_setup(client)
    if body is not None:
        try:
            base = BusinessSetup.model_validate(body)
        except ValidationError:
            # Edited by hand or by the agent into something this form cannot show.
            # Showing the defaults is safer than failing the whole tab.
            logger.warning("Ignoring unreadable business profile for %s", client.slug)
    return BusinessSetupView(**base.model_dump(), updated_at=updated_at)


def _clean_setup(setup: BusinessSetup) -> BusinessSetup:
    """Screen every free-text field the way a memory rule is screened."""
    field_labels = {
        "company_name": ("Company name", 120),
        "industry": ("Industry", 120),
        "tagline": ("Tagline", 160),
        "business_hours": ("Business hours", 300),
        "location_address": ("Location", 300),
        "delivery_and_shipping_policy": ("The delivery and shipping policy", 600),
        "return_and_refund_policy": ("The return and refund policy", 600),
        "tone_of_voice": ("Tone of voice", 300),
    }
    values: dict[str, Any] = {}
    for name, (label, limit) in field_labels.items():
        values[name] = validate_business_field(getattr(setup, name), label=label, max_length=limit)
    if not values["company_name"]:
        raise PortalError(422, "business_field_rejected", "Enter your company name.")

    kit = setup.brand_kit
    values["brand_kit"] = kit.model_copy(
        update={
            "logo_text": validate_business_field(kit.logo_text, label="Logo text", max_length=24),
            "default_cta": validate_business_field(kit.default_cta, label="The call to action", max_length=80)
            or BrandKitSetup().default_cta,
        }
    )
    faqs: list[Faq] = []
    for index, faq in enumerate(setup.faqs, start=1):
        question = validate_business_field(faq.question, label=f"Question {index}", max_length=200)
        answer = validate_business_field(faq.answer, label=f"The answer to question {index}", max_length=600)
        if question and answer:
            faqs.append(Faq(question=question, answer=answer))
    values["faqs"] = faqs
    return setup.model_copy(update=values)


# ------------------------------------------------------------------- compilation
def _soul_block(setup: BusinessSetup) -> str:
    lines = [SOUL_START, "## Business profile", ""]

    def add(label: str, value: str | None) -> None:
        if value:
            lines.append(f"- {label}: {value}")

    add("Business", setup.company_name)
    add("Type", "online store" if setup.business_mode == "ecommerce" else "service business")
    add("Industry", setup.industry)
    add("Tagline", setup.tagline)
    add("Website", setup.website_url)
    add("Phone", setup.support_phone)
    add("Opening hours", setup.business_hours)
    add("Location", setup.location_address)
    add("Delivery and shipping", setup.delivery_and_shipping_policy)
    add("Returns and refunds", setup.return_and_refund_policy)
    add("Tone of voice", setup.tone_of_voice)
    add("Default call to action", setup.brand_kit.default_cta)

    if setup.faqs:
        lines += ["", "## Customer questions and the approved answers", ""]
        for faq in setup.faqs:
            lines += [f"Q: {faq.question}", f"A: {faq.answer}", ""]
        lines.append("Use these answers as written when a customer asks the same thing.")

    lines += [
        "",
        "## Reference data",
        "",
        f"The price list is in {CATALOG_FILE} and the full profile in {PROFILE_FILE}, both in "
        "your data directory. Read them for exact prices, stock and booking rules before you "
        "quote anything. If an item is not listed, say you will check rather than guessing.",
        SOUL_END,
    ]
    return "\n".join(lines)


_SOUL_BLOCK = re.compile(re.escape(SOUL_START) + r".*?" + re.escape(SOUL_END), re.DOTALL)


def _sync_soul(files: TenantFiles, setup: BusinessSetup) -> None:
    block = _soul_block(setup)
    with files.locked(SOUL_FILE):
        existing = files.read_text(SOUL_FILE)
        if existing is None:
            text = f"You are the AI operations Coordinator for {setup.company_name}.\n\n{block}\n"
        elif _SOUL_BLOCK.search(existing):
            text = _SOUL_BLOCK.sub(lambda _: block, existing, count=1)
        else:
            separator = "" if existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
            text = f"{existing}{separator}{block}\n"
        files.write_atomic(text, SOUL_FILE, default_mode=_DATA_MODE)


def _clip(text: str) -> str:
    return text if len(text) <= _MEMORY_LINE_MAX else text[: _MEMORY_LINE_MAX - 1].rstrip() + "…"


def _memory_lines(setup: BusinessSetup) -> list[str]:
    """Most important first: a full memory drops from the end."""
    lines: list[str] = []
    identity = setup.company_name
    if setup.industry:
        identity += f", {setup.industry}"
    if setup.tagline:
        identity += f". {setup.tagline}"
    lines.append(f"{MEMORY_PREFIX} {identity}")

    contact = [
        f"Hours: {setup.business_hours}" if setup.business_hours else "",
        f"Location: {setup.location_address}" if setup.location_address else "",
        f"Phone: {setup.support_phone}" if setup.support_phone else "",
        f"Website: {setup.website_url}" if setup.website_url else "",
    ]
    if any(contact):
        lines.append(f"{MEMORY_PREFIX} " + ". ".join(part for part in contact if part))
    if setup.delivery_and_shipping_policy:
        lines.append(f"{MEMORY_PREFIX} Delivery and shipping: {setup.delivery_and_shipping_policy}")
    if setup.return_and_refund_policy:
        lines.append(f"{MEMORY_PREFIX} Returns and refunds: {setup.return_and_refund_policy}")
    if setup.tone_of_voice:
        lines.append(f"{MEMORY_PREFIX} Tone of voice: {setup.tone_of_voice}")
    return [_clip(line) for line in lines]


def _sync_memory(files: TenantFiles, setup: BusinessSetup) -> tuple[bool, int]:
    """Replace this setup's memory lines. Returns ``(all lines fit, lines dropped)``."""
    limit = readers._memory_limit(readers.read_config(files))
    managed = _memory_lines(setup)
    with files.locked(*readers.MEMORY_PARTS):
        entries = readers._parse_memory(files.read_text(*readers.MEMORY_PARTS) or "")
        kept = [entry for entry in entries if not entry.startswith(MEMORY_PREFIX)]
        result = list(kept)
        skipped = 0
        for line in managed:
            if len(readers.MEMORY_DELIMITER.join([*result, line])) <= limit:
                result.append(line)
            else:
                skipped += 1
        files.write_atomic(readers.MEMORY_DELIMITER.join(result), *readers.MEMORY_PARTS)
    return skipped == 0, skipped


def save_setup(files: TenantFiles, setup: BusinessSetup) -> BusinessSetupView:
    """Validate, store and compile one save. The profile file is written first, so a
    failure while compiling leaves the owner's words saved and the error visible."""
    cleaned = _clean_setup(setup)
    updated_at = _now()
    document = {"schema": 1, "updated_at": updated_at, **cleaned.model_dump()}
    with files.locked(PROFILE_FILE):
        files.write_atomic(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n", PROFILE_FILE, default_mode=_DATA_MODE
        )
    _sync_soul(files, cleaned)
    synced, skipped = _sync_memory(files, cleaned)
    return BusinessSetupView(
        **cleaned.model_dump(), updated_at=updated_at, memory_synced=synced, memory_lines_skipped=skipped
    )


def brand_kit_record(setup: BusinessSetup) -> dict[str, Any]:
    """The subset the hub's own brand kit column holds, so the autopilot and the
    business profile never disagree about a colour."""
    kit = setup.brand_kit
    return {
        "primary_color": kit.primary_color,
        "accent_color": kit.accent_color,
        "logo_text": kit.logo_text,
        "contact_cta": kit.default_cta,
        "website_url": setup.website_url,
    }


# ====================================================================== catalog
def _read_items(files: TenantFiles) -> tuple[list[CatalogItem], str | None]:
    data = files.read_json(CATALOG_FILE)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return [], None
    items: list[CatalogItem] = []
    for raw in data["items"]:
        try:
            items.append(CatalogItem.model_validate(raw))
        except ValidationError:
            logger.warning("Skipping an unreadable catalog entry")
    updated_at = data.get("updated_at") if isinstance(data.get("updated_at"), str) else None
    return items, updated_at


def _view(client: Client, items: list[CatalogItem], updated_at: str | None) -> CatalogView:
    return CatalogView(
        business_mode=client.business_mode.value,  # type: ignore[arg-type]
        items=items,
        updated_at=updated_at,
    )


def read_catalog(files: TenantFiles, client: Client) -> CatalogView:
    items, updated_at = _read_items(files)
    return _view(client, items, updated_at)


def _clean_item(item: CatalogItemInput) -> CatalogItemInput:
    variants = [
        validate_business_field(value, label="A size or variant", max_length=40)
        for value in item.sizes_or_variants
    ]
    name = validate_business_field(item.name, label="The name", max_length=120)
    if not name:
        raise PortalError(422, "catalog_item_rejected", "Enter a name for this item.")
    return item.model_copy(
        update={
            "name": name,
            "price_usd": round(item.price_usd, 2),
            "description": validate_business_field(item.description, label="The description", max_length=400),
            "duration": validate_business_field(item.duration, label="The duration", max_length=60),
            "booking_rules": validate_business_field(
                item.booking_rules, label="The booking rules", max_length=300
            ),
            "sizes_or_variants": [value for value in variants if value],
        }
    )


def _write_items(files: TenantFiles, client: Client, items: list[CatalogItem]) -> str:
    updated_at = _now()
    text = (
        json.dumps(
            {
                "schema": 1,
                "business_mode": client.business_mode.value,
                "updated_at": updated_at,
                "items": [item.model_dump() for item in items],
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    # The portal and the agent both read this file with a size cap, so a file past the
    # cap would silently read as empty.
    if len(text.encode("utf-8")) > MAX_FILE_BYTES - 4096:
        raise PortalError(
            status.HTTP_409_CONFLICT,
            "catalog_too_large",
            "The catalog is too large to save. Remove some items or shorten the descriptions.",
        )
    files.write_atomic(text, CATALOG_FILE, default_mode=_DATA_MODE)
    return updated_at


def _full() -> PortalError:
    return PortalError(
        status.HTTP_409_CONFLICT,
        "catalog_full",
        f"The catalog holds up to {MAX_CATALOG_ITEMS} items. Remove one before adding another.",
    )


def _not_found() -> PortalError:
    return PortalError(
        status.HTTP_404_NOT_FOUND,
        "catalog_item_not_found",
        "That item has changed since this page loaded. Refresh and try again.",
    )


def _new_id(taken: set[str]) -> str:
    while True:
        candidate = secrets.token_hex(6)
        if candidate not in taken:
            return candidate


def add_item(files: TenantFiles, client: Client, payload: CatalogItemInput) -> CatalogItem:
    cleaned = _clean_item(payload)
    with files.locked(CATALOG_FILE):
        items, _ = _read_items(files)
        if len(items) >= MAX_CATALOG_ITEMS:
            raise _full()
        item = CatalogItem(id=_new_id({existing.id for existing in items}), **cleaned.model_dump())
        _write_items(files, client, [*items, item])
    return item


def update_item(files: TenantFiles, client: Client, item_id: str, payload: CatalogItemInput) -> CatalogItem:
    cleaned = _clean_item(payload)
    with files.locked(CATALOG_FILE):
        items, _ = _read_items(files)
        index = next((i for i, existing in enumerate(items) if existing.id == item_id), None)
        if index is None:
            raise _not_found()
        item = CatalogItem(id=item_id, **cleaned.model_dump())
        items[index] = item
        _write_items(files, client, items)
    return item


def delete_item(files: TenantFiles, client: Client, item_id: str) -> None:
    with files.locked(CATALOG_FILE):
        items, _ = _read_items(files)
        remaining = [item for item in items if item.id != item_id]
        if len(remaining) == len(items):
            raise _not_found()
        _write_items(files, client, remaining)


def _identity(item: CatalogItemInput) -> tuple[str, str]:
    """What makes two rows the same item on import: the SKU if there is one, else the name."""
    if item.sku:
        return ("sku", item.sku.lower())
    return ("name", f"{item.kind}:{item.name.strip().lower()}")


def import_items(files: TenantFiles, client: Client, payload: CatalogImport) -> CatalogImportResult:
    cleaned = [_clean_item(item) for item in payload.items]
    created = updated = 0
    with files.locked(CATALOG_FILE):
        existing, _ = _read_items(files)
        items: list[CatalogItem] = [] if payload.replace else list(existing)
        index = {_identity(item): position for position, item in enumerate(items)}
        taken = {item.id for item in items}
        for row in cleaned:
            key = _identity(row)
            if key in index:
                items[index[key]] = CatalogItem(id=items[index[key]].id, **row.model_dump())
                updated += 1
                continue
            if len(items) >= MAX_CATALOG_ITEMS:
                raise _full()
            new_id = _new_id(taken)
            taken.add(new_id)
            items.append(CatalogItem(id=new_id, **row.model_dump()))
            index[key] = len(items) - 1
            created += 1
        updated_at = _write_items(files, client, items)
    return CatalogImportResult(created=created, updated=updated, catalog=_view(client, items, updated_at))


# ============================================================== for the autopilot
def read_publishable_items(files: TenantFiles, client: Client) -> list[CatalogItem]:
    """Items worth a post: the kind this business sells, and nothing that is sold out."""
    wanted = "product" if client.business_mode.value == "ecommerce" else "service"
    items, _ = _read_items(files)
    of_kind = [item for item in items if item.kind == wanted] or items
    return [item for item in of_kind if item.stock_qty is None or item.stock_qty > 0]


def read_profile_for_posts(files: TenantFiles) -> BusinessSetup | None:
    body, _ = _load_profile(files)
    if body is None:
        return None
    try:
        return BusinessSetup.model_validate(body)
    except ValidationError:
        return None
