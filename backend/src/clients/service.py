"""Data access and bookkeeping for clients. No Docker, no HTTP."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from slugify import slugify
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config.security import new_internal_token
from ..config.settings import Settings
from .models import (
    PLAN_FOR_TIER,
    TIER_FOR_PLAN,
    AuditLog,
    AuditStatus,
    Client,
    ClientPlan,
    RegionPreset,
    SubscriptionStatus,
)
from .schemas import ClientCreate, ClientUpdate

#: Currencies each region preset may bill in, default first.
REGION_CURRENCIES = {
    RegionPreset.BD: ("BDT",),
    RegionPreset.GLOBAL: ("USD", "EUR", "GBP"),
}

logger = logging.getLogger(__name__)

#: Subdomains the agency keeps for itself. A tenant claiming one of these would
#: shadow the hub's own routes.
RESERVED_SLUGS = {
    "www",
    "api",
    "admin",
    "app",
    "hub",
    "traefik",
    "static",
    "mail",
    "dashboard",
    "status",
}


class ClientNotFoundError(LookupError):
    pass


class ClientConflictError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------- reads
async def get_client(session: AsyncSession, client_id: uuid.UUID) -> Client:
    client = await session.get(Client, client_id)
    if client is None:
        raise ClientNotFoundError(f"No client with id {client_id}")
    return client


async def get_by_slug(session: AsyncSession, slug: str) -> Client | None:
    result = await session.execute(select(Client).where(Client.slug == slug))
    return result.scalar_one_or_none()


async def get_by_api_key(session: AsyncSession, api_key: str) -> Client | None:
    """Resolve a tenant from its bearer token."""
    result = await session.execute(select(Client).where(Client.api_key == api_key))
    return result.scalar_one_or_none()


async def get_by_stripe(
    session: AsyncSession,
    *,
    customer_id: str | None = None,
    subscription_id: str | None = None,
) -> Client | None:
    """Look a client up from a Stripe webhook payload."""
    conditions = []
    if subscription_id:
        conditions.append(Client.stripe_subscription_id == subscription_id)
    if customer_id:
        conditions.append(Client.stripe_customer_id == customer_id)
    if not conditions:
        return None
    result = await session.execute(select(Client).where(or_(*conditions)))
    return result.scalars().first()


async def find_by_channel(
    session: AsyncSession, channel: str, identifier: str
) -> Client | None:
    """Resolve an inbound message to its client via ``channels`` metadata.

    ``channels`` looks like ``{"whatsapp": "+15551234567", "instagram": "17841..."}``.
    JSON containment would be faster, but the client count here is small and
    this keeps the column backend-agnostic.
    """
    result = await session.execute(
        select(Client).where(Client.subscription_status != SubscriptionStatus.ARCHIVED)
    )
    wanted = identifier.strip().lstrip("+").lower()
    for client in result.scalars():
        value = (client.channels or {}).get(channel)
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if candidate and str(candidate).strip().lstrip("+").lower() == wanted:
                return client
    return None


async def list_clients(
    session: AsyncSession,
    *,
    status: SubscriptionStatus | None = None,
    plan: ClientPlan | None = None,
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Client], int]:
    stmt = select(Client)
    count_stmt = select(func.count()).select_from(Client)

    if status is not None:
        stmt = stmt.where(Client.subscription_status == status)
        count_stmt = count_stmt.where(Client.subscription_status == status)
    if plan is not None:
        stmt = stmt.where(Client.plan == plan)
        count_stmt = count_stmt.where(Client.plan == plan)
    if query:
        pattern = f"%{query.lower()}%"
        condition = or_(
            func.lower(Client.company_name).like(pattern),
            func.lower(Client.slug).like(pattern),
            func.lower(Client.contact_email).like(pattern),
        )
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)

    stmt = stmt.order_by(Client.created_at.desc()).limit(limit).offset(offset)

    items = list((await session.execute(stmt)).scalars())
    total = (await session.execute(count_stmt)).scalar_one()
    return items, total


async def list_audit_logs(
    session: AsyncSession, client_id: uuid.UUID, limit: int = 100
) -> list[AuditLog]:
    result = await session.execute(
        select(AuditLog)
        .where(AuditLog.client_id == client_id)
        .order_by(AuditLog.timestamp.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def used_ports(session: AsyncSession) -> set[int]:
    """Every host port the hub has recorded against a client.

    Both port columns in one set: the allocator validates that the two ranges
    do not overlap, so a single set cannot cause a false collision, and the
    union is what callers actually need.
    """
    result = await session.execute(
        select(Client.container_port_dash, Client.container_port_api)
    )
    ports: set[int] = set()
    for dash, api in result.all():
        if dash:
            ports.add(dash)
        if api:
            ports.add(api)
    return ports


async def stats(session: AsyncSession) -> dict[str, Any]:
    total = (await session.execute(select(func.count()).select_from(Client))).scalar_one()
    by_status = {
        status.value: count
        for status, count in (
            await session.execute(
                select(Client.subscription_status, func.count()).group_by(
                    Client.subscription_status
                )
            )
        ).all()
    }
    by_plan = {
        plan.value: count
        for plan, count in (
            await session.execute(select(Client.plan, func.count()).group_by(Client.plan))
        ).all()
    }
    return {"total": total, "by_status": by_status, "by_plan": by_plan}


# -------------------------------------------------------------------- writes
def derive_slug(settings: Settings, payload: ClientCreate) -> str:
    """Resolve the DNS label for a new client, or explain why it can't be."""
    # Trim after the cut: truncating can land on a hyphen, and a label ending in
    # one is not valid DNS.
    slug = payload.slug or slugify(payload.company_name)[:63].rstrip("-")
    if not slug:
        raise ClientConflictError(
            "Could not derive a subdomain from the company name; supply one "
            "explicitly."
        )
    if slug in RESERVED_SLUGS:
        raise ClientConflictError(f"Subdomain '{slug}' is reserved.")
    return slug


async def create_client(
    session: AsyncSession, settings: Settings, payload: ClientCreate
) -> Client:
    """Insert a client row in PENDING. Allocates no ports and no credentials.

    Ports and credentials belong to provisioning: they are only meaningful
    once a container exists, and minting them here would leak a credential
    for every abandoned signup.

    A resubmission for a client whose provisioning failed outright reuses that
    row instead of conflicting with it; see :func:`_is_retry_of`.
    """
    slug = derive_slug(settings, payload)
    currency = resolve_currency(payload.region_preset, payload.currency)
    existing = await get_by_slug(session, slug)
    if existing is not None:
        if not _is_retry_of(existing, payload):
            raise ClientConflictError(f"Subdomain '{slug}' is already taken.")
        return await _prepare_retry(session, settings, existing, payload)

    resolved_plan = _plan_of(payload)
    plan = settings.plan_for(resolved_plan.value)
    client = Client(
        company_name=payload.company_name,
        slug=slug,
        subdomain=settings.subdomain_for(slug),
        contact_email=str(payload.contact_email),
        plan=resolved_plan,
        business_mode=payload.business_mode,
        niche_template=payload.niche_template,
        package_tier=TIER_FOR_PLAN[resolved_plan],
        region_preset=payload.region_preset,
        currency=currency,
        onboarding_stage=1,
        baseline_metrics_json=(
            payload.baseline_metrics.model_dump() if payload.baseline_metrics else None
        ),
        autopilot_social=payload.autopilot_social,
        brand_kit_json=payload.brand_kit.model_dump() if payload.brand_kit else None,
        guardrails_json={},
        subscription_status=SubscriptionStatus.PENDING,
        image=payload.image or settings.client_image,
        container_name=settings.container_name_for(slug),
        cpu_limit=settings.cpus_for(resolved_plan.value),
        memory_limit=settings.memory_for(resolved_plan.value),
        database_name=(
            settings.client_database_name(slug)
            if settings.provision_client_databases
            else None
        ),
        internal_token=new_internal_token(),
        api_key="",
        dashboard_password_hash="",
        dashboard_secret="",
        config=payload.config,
        channels=payload.channels,
        synced_skills=[],
        stripe_customer_id=payload.stripe_customer_id,
        stripe_subscription_id=payload.stripe_subscription_id,
    )
    # Unused but kept so the plan envelope is visible at creation time.
    _ = plan
    session.add(client)
    await session.flush()
    await record_audit(
        session,
        client,
        "created",
        AuditStatus.SUCCEEDED,
        f"Client {slug} registered.",
    )
    logger.info("Created client %s (%s)", slug, client.id)
    return client


def resolve_currency(region: RegionPreset, requested: str | None) -> str:
    """The currency a client bills in, or explain why ``requested`` cannot be."""
    allowed = REGION_CURRENCIES[region]
    if requested is None:
        return allowed[0]
    currency = requested.upper()
    if currency not in allowed:
        raise ClientConflictError(
            f"{currency} is not available for the {region.value} region; "
            f"choose one of {', '.join(allowed)}."
        )
    return currency


def _plan_of(payload: ClientCreate) -> ClientPlan:
    return PLAN_FOR_TIER[payload.package_tier] if payload.package_tier else payload.plan


def _is_retry_of(client: Client, payload: ClientCreate) -> bool:
    """Whether ``payload`` is the same onboarding, tried again.

    A failed run keeps its row so the failure stays on record, but a capacity
    or daemon error must not burn the subdomain. Both conditions are needed:

    * No container: an unhealthy tenant is also FAILED, but its container is
      kept for diagnosis and its credentials are live, so resubmitting must not
      replace it.
    * Same contact: the retry reuses this tenant's data directory, so a
      different customer asking for the same subdomain has to stay a conflict.

    A seeded demo tenant counts too: it holds the subdomain but has never been
    provisioned, and provisioning it for real should simply replace the samples.
    """
    return (
        (
            client.subscription_status is SubscriptionStatus.FAILED
            or (client.config or {}).get("demo_seed") is True
        )
        and client.container_id is None
        and client.contact_email.lower() == str(payload.contact_email).lower()
    )


async def _prepare_retry(
    session: AsyncSession, settings: Settings, client: Client, payload: ClientCreate
) -> Client:
    """Apply the resubmitted request; a bad image may be why the last run failed."""
    was_demo = (client.config or {}).get("demo_seed") is True
    plan = _plan_of(payload)
    client.company_name = payload.company_name
    client.plan = plan
    client.image = payload.image or settings.client_image
    client.cpu_limit = settings.cpus_for(plan.value)
    client.memory_limit = settings.memory_for(plan.value)
    client.config = payload.config
    client.channels = payload.channels
    client.business_mode = payload.business_mode
    client.niche_template = payload.niche_template
    client.package_tier = TIER_FOR_PLAN[plan]
    client.region_preset = payload.region_preset
    client.currency = resolve_currency(payload.region_preset, payload.currency)
    if payload.baseline_metrics:
        client.baseline_metrics_json = payload.baseline_metrics.model_dump()
    client.autopilot_social = payload.autopilot_social
    if payload.brand_kit:
        client.brand_kit_json = payload.brand_kit.model_dump()
    if was_demo:
        from ..ops.demo import clear_demo_rows  # avoids a clients <-> ops import cycle

        await clear_demo_rows(session, client)
    await session.flush()
    await record_audit(
        session,
        client,
        "retried",
        AuditStatus.SUCCEEDED,
        f"Client {client.slug} resubmitted after a failed provision.",
    )
    logger.info("Retrying failed client %s (%s)", client.slug, client.id)
    return client


async def update_client(
    session: AsyncSession, settings: Settings, client: Client, payload: ClientUpdate
) -> Client:
    data = payload.model_dump(exclude_unset=True)
    if "contact_email" in data and data["contact_email"] is not None:
        data["contact_email"] = str(data["contact_email"])

    # The package and the resource plan are two names for one choice.
    if (tier := data.get("package_tier")) is not None:
        data["plan"] = PLAN_FOR_TIER[tier]
    elif (plan := data.get("plan")) is not None:
        data["package_tier"] = TIER_FOR_PLAN[plan]

    if (plan := data.get("plan")) is not None:
        client.cpu_limit = settings.cpus_for(plan.value)
        client.memory_limit = settings.memory_for(plan.value)

    if data.get("region_preset") is not None or data.get("currency") is not None:
        region = data.get("region_preset") or client.region_preset
        keep = None if region is not client.region_preset else client.currency
        data["currency"] = resolve_currency(region, data.get("currency") or keep)

    if (baseline := data.pop("baseline_metrics", None)) is not None:
        # model_dump already turned this into a plain dict of the validated fields.
        data["baseline_metrics_json"] = baseline
    if (brand_kit := data.pop("brand_kit", None)) is not None:
        data["brand_kit_json"] = brand_kit

    for field, value in data.items():
        if value is not None:
            setattr(client, field, value)

    await session.flush()
    # ``updated_at`` is produced by the database (onupdate=func.now()), so the
    # flush above expires it rather than guessing a value. Reload it here while
    # we are still in async context: the caller serialises this object with
    # pydantic, whose attribute access is synchronous, and a lazy refresh
    # triggered from there raises MissingGreenlet — which surfaced as a 500 on
    # every successful PATCH.
    await session.refresh(client)
    await record_audit(
        session,
        client,
        "updated",
        AuditStatus.SUCCEEDED,
        "Client settings updated.",
        payload={key: str(value) for key, value in data.items()},
    )
    return client


async def set_status(
    session: AsyncSession,
    client: Client,
    status: SubscriptionStatus,
    detail: str | None = None,
) -> Client:
    client.subscription_status = status
    client.status_detail = detail
    if status == SubscriptionStatus.ACTIVE:
        client.provisioned_at = client.provisioned_at or _now()
        client.suspended_at = None
    elif status == SubscriptionStatus.SUSPENDED:
        client.suspended_at = _now()
    await session.flush()
    return client


async def record_audit(
    session: AsyncSession,
    client: Client,
    action: str,
    status: AuditStatus = AuditStatus.STARTED,
    message: str = "",
    payload: dict[str, Any] | None = None,
) -> AuditLog:
    """Append one row to the audit trail.

    Callers normally write a ``STARTED`` row before an operation and a
    ``SUCCEEDED``/``FAILED`` row after, so an interrupted run leaves a lone
    ``STARTED`` row that reconciliation can spot.
    """
    entry = AuditLog(
        client_id=client.id,
        action=action,
        status=status,
        message=message,
        payload=payload or {},
    )
    session.add(entry)
    await session.flush()
    return entry


async def apply_credentials(
    session: AsyncSession, client: Client, credentials: Any, *, key_last4: str = ""
) -> Client:
    """Persist a freshly minted credential set.

    Takes the ``TenantCredentials.as_persistable()`` subset, which deliberately
    omits the plaintext dashboard password — the hub stores only its hash.
    """
    for field, value in credentials.as_persistable().items():
        setattr(client, field, value)
    if key_last4:
        client.openrouter_key_last4 = key_last4
    await session.flush()
    return client


async def delete_client(session: AsyncSession, client: Client) -> None:
    await session.delete(client)
    await session.flush()
