"""The owner's growth views: ROI, approvals, guardrails and the daily workspace.

Same tenant resolution as ``portal_router``. Anything an agent drafted passes
through :func:`.sanitize.scrub` on the way out, because the white-label boundary
applies to it as much as to anything read from the tenant's files.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Path, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.permissions import ROLE_PERMISSIONS, Permission
from ..clients import service as client_service
from ..clients.models import AuditStatus, Client
from ..config.database import get_session
from ..config.settings import Settings, get_settings
from ..ops import approvals as approval_service
from ..ops import guardrails as guardrail_service
from ..ops import social as social_service
from ..ops.models import ApprovalItem, ApprovalStatus, WorkspaceRecord
from ..ops.reports import roi_report
from ..ops.schemas import (
    PERIOD_PATTERN,
    GuardrailRead,
    GuardrailUpdate,
    OwnerDecision,
    PortalApproval,
    PortalProfile,
    RoiReport,
    WorkspaceRecordRead,
    WorkspaceView,
)
from . import knowledge, records as record_store
from .errors import forbidden
from .portal_router import PortalActor, require_actor, require_tenant, require_writable
from .sanitize import scrub

router = APIRouter(prefix="/portal/{subdomain}", tags=["portal"])

#: Statuses an owner has any reason to see. Drafts in QA are the team's business.
_OWNER_VISIBLE = (
    ApprovalStatus.PENDING_OWNER,
    ApprovalStatus.APPROVED,
    ApprovalStatus.CHANGES_REQUESTED,
    ApprovalStatus.REJECTED,
)


def _require_owner_authority(actor: PortalActor) -> None:
    """Whether this caller may speak for the owner.

    An access link or an owner's session can. Staff may look at a client's portal,
    but only a role granted PORTAL_DECIDE may decide on the owner's behalf.
    """
    user = actor.user
    if user is None or user.client_id == actor.client.id:
        return
    if Permission.PORTAL_DECIDE not in ROLE_PERMISSIONS[user.role]:
        raise forbidden()


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [_clean(item) for item in value]
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items()}
    return value


def _portal_approval(item: ApprovalItem) -> PortalApproval:
    return PortalApproval(
        id=item.id,
        kind=item.kind,
        status=item.status,
        title=scrub(item.title),
        summary=scrub(item.summary),
        preview=_clean(item.preview or {}),
        note=scrub(item.note) if item.note else None,
        decided_at=item.decided_at,
        created_at=item.created_at,
        decided_automatically=item.decided_by == approval_service.AUTOMATIC_ACTOR,
    )


@router.get("/profile", response_model=PortalProfile, summary="This business's plan and region")
async def profile(
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> PortalProfile:
    pending = (
        await session.execute(
            select(func.count())
            .select_from(ApprovalItem)
            .where(
                ApprovalItem.client_id == client.id,
                ApprovalItem.status == ApprovalStatus.PENDING_OWNER,
            )
        )
    ).scalar_one()
    return PortalProfile(
        company_name=client.company_name,
        business_mode=client.business_mode.value,
        niche_template=client.niche_template.value,
        package_tier=client.package_tier.value,
        region_preset=client.region_preset.value,
        currency=client.currency,
        onboarding_stage=client.onboarding_stage,
        pending_approvals=pending,
        is_demo=(client.config or {}).get("demo_seed") is True,
    )


@router.get("/roi", response_model=RoiReport, summary="ROI and lead conversion funnel")
async def roi(
    period: str | None = Query(default=None, pattern=PERIOD_PATTERN),
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> RoiReport:
    return await roi_report(session, client, period)


@router.get("/approvals", response_model=list[PortalApproval], summary="The approval center")
async def approvals(
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> list[PortalApproval]:
    items = await approval_service.list_for_client(session, client.id)
    return [_portal_approval(item) for item in items if item.status in _OWNER_VISIBLE]


@router.post(
    "/approvals/{item_id}/decide",
    response_model=PortalApproval,
    summary="Approve, ask for an edit, or hold an item",
)
async def decide(
    item_id: uuid.UUID,
    payload: OwnerDecision,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> PortalApproval:
    _require_owner_authority(actor)
    item = await approval_service.decide_as_owner(
        session, client, item_id,
        decision=payload.decision, actor=actor.label, note=payload.note,
    )
    # An approved social post is published now; a rejected one is dropped.
    await social_service.on_owner_decision(session, settings, client, item)
    return _portal_approval(item)


@router.get("/guardrails", response_model=list[GuardrailRead], summary="The three lanes")
async def guardrails(client: Client = Depends(require_tenant)) -> list[GuardrailRead]:
    return [GuardrailRead(**item) for item in guardrail_service.lanes_for(client)]


@router.put(
    "/guardrails/{key}",
    response_model=list[GuardrailRead],
    summary="Move a routine item between Owner Approves and Automatic",
)
async def set_guardrail(
    key: str,
    payload: GuardrailUpdate,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
) -> list[GuardrailRead]:
    _require_owner_authority(actor)
    guardrail_service.set_lane(client, key, payload.lane)
    await client_service.record_audit(
        session, client, "portal.guardrail.update", AuditStatus.SUCCEEDED,
        f"{actor.label} moved {key} to {payload.lane}.",
        payload={"key": key, "lane": payload.lane, "actor": actor.label},
    )
    return [GuardrailRead(**item) for item in guardrail_service.lanes_for(client)]


@router.get("/workspace", response_model=WorkspaceView, summary="The owner's daily workspace")
async def workspace(
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
) -> WorkspaceView:
    result = await session.execute(
        select(WorkspaceRecord)
        .where(WorkspaceRecord.client_id == client.id)
        .order_by(WorkspaceRecord.created_at.desc())
        .limit(300)
    )
    return WorkspaceView(
        business_mode=client.business_mode.value,
        records=[WorkspaceRecordRead.model_validate(row) for row in result.scalars()],
    )


# ------------------------------------------------------------------ leads and orders
@router.get(
    "/records",
    response_model=record_store.RecordsView,
    summary="Captured leads, appointments and orders",
)
async def list_records(
    kind: Literal["lead", "order"] | None = Query(default=None),
    client: Client = Depends(require_tenant),
    settings: Settings = Depends(get_settings),
) -> record_store.RecordsView:
    files = knowledge.files_for(settings, client)
    return record_store.RecordsView(records=await asyncio.to_thread(record_store.list_records, files, kind))


@router.post(
    "/records",
    response_model=record_store.RecordRead,
    status_code=status.HTTP_201_CREATED,
    summary="Add a lead, appointment or order by hand",
)
async def create_record(
    payload: record_store.RecordCreate,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> record_store.RecordRead:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    record = await asyncio.to_thread(record_store.create_record, files, payload)
    # The reference and the kind, never the customer's details.
    await client_service.record_audit(
        session, client, "portal.record.create", AuditStatus.SUCCEEDED,
        f"{actor.label} added {record.ref}.", payload={"actor": actor.label, "ref": record.ref},
    )
    return record


@router.patch(
    "/records/{record_id}",
    response_model=record_store.RecordRead,
    summary="Update a record, move it along, or dispatch an order",
)
async def update_record(
    record_id: str = Path(pattern=r"^[0-9a-f]{16}$"),
    payload: record_store.RecordUpdate = Body(),
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> record_store.RecordRead:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    record = await asyncio.to_thread(record_store.update_record, files, record_id, payload)
    await client_service.record_audit(
        session, client, "portal.record.update", AuditStatus.SUCCEEDED,
        f"{actor.label} updated {record.ref}.",
        payload={"actor": actor.label, "ref": record.ref, "status": record.status},
    )
    return record
