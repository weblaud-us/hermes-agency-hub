"""HTTP surface for the agency's daily work: QA, ROI entry, CRM, stand-up and kits."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import Principal, get_principal, require_any_permission, require_permission
from ..auth.permissions import Permission
from ..clients import service as client_service
from ..clients.skills import available_skills
from ..config.database import get_session
from ..config.settings import Settings, get_settings
from ..ops import approvals as approval_service
from ..ops import crm as crm_service
from ..ops import kits as kit_service
from ..ops.models import Prospect, ProspectStage, RoiSnapshot, WorkspaceRecord
from ..ops.reports import roi_report
from ..ops.roi import agency_now
from ..ops.schemas import (
    DAY_PATTERN,
    PERIOD_PATTERN,
    ApprovalCreate,
    ApprovalRead,
    ApprovalRevise,
    OnboardingDraft,
    ProspectCreate,
    ProspectPipeline,
    ProspectRead,
    ProspectUpdate,
    QaDecision,
    QaQueueItem,
    RoiEntry,
    RoiReport,
    SkillRead,
    StandupMemberRead,
    StandupUpdate,
    StandupView,
    StarterKit,
    StarterKitUpdate,
    WorkspaceRecordCreate,
    WorkspaceRecordRead,
    WorkspaceRecordUpdate,
)

router = APIRouter(dependencies=[Depends(get_principal)])


# -------------------------------------------------------------------- QA queue
@router.get(
    "/qa/queue",
    response_model=list[QaQueueItem],
    tags=["qa"],
    summary="Drafts the team still has to act on",
    dependencies=[Depends(require_permission(Permission.QA_QUEUE))],
)
async def qa_queue(session: AsyncSession = Depends(get_session)) -> list[QaQueueItem]:
    return [
        QaQueueItem(
            **ApprovalRead.model_validate(item).model_dump(),
            company_name=client.company_name,
            client_slug=client.slug,
            onboarding_stage=client.onboarding_stage,
        )
        for item, client in await approval_service.qa_queue(session)
    ]


@router.post(
    "/clients/{client_id}/approvals",
    response_model=ApprovalRead,
    status_code=status.HTTP_201_CREATED,
    tags=["qa"],
    summary="Queue a draft for review",
    dependencies=[Depends(require_permission(Permission.QA_QUEUE))],
)
async def create_approval(
    client_id: uuid.UUID,
    payload: ApprovalCreate,
    session: AsyncSession = Depends(get_session),
) -> ApprovalRead:
    client = await client_service.get_client(session, client_id)
    item = await approval_service.create_item(
        session,
        client,
        kind=payload.kind,
        title=payload.title,
        summary=payload.summary,
        preview=payload.preview,
        source_skill=payload.source_skill,
    )
    await session.refresh(item)
    return ApprovalRead.model_validate(item)


@router.post(
    "/clients/{client_id}/approvals/{item_id}/qa",
    response_model=ApprovalRead,
    tags=["qa"],
    summary="Forward, return or escalate a draft",
    dependencies=[Depends(require_permission(Permission.QA_QUEUE))],
)
async def decide_qa(
    client_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: QaDecision,
    principal: Principal = Depends(get_principal),
    session: AsyncSession = Depends(get_session),
) -> ApprovalRead:
    client = await client_service.get_client(session, client_id)
    item = await approval_service.decide_as_qa(
        session, client, item_id,
        decision=payload.decision, actor=principal.label, note=payload.note,
    )
    return ApprovalRead.model_validate(item)


@router.post(
    "/clients/{client_id}/approvals/{item_id}/revise",
    response_model=ApprovalRead,
    tags=["qa"],
    summary="Send a corrected draft back through the queue",
    dependencies=[Depends(require_permission(Permission.QA_QUEUE))],
)
async def revise_approval(
    client_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: ApprovalRevise,
    principal: Principal = Depends(get_principal),
    session: AsyncSession = Depends(get_session),
) -> ApprovalRead:
    client = await client_service.get_client(session, client_id)
    item = await approval_service.revise(
        session, client, item_id,
        actor=principal.label,
        title=payload.title,
        summary=payload.summary,
        preview=payload.preview,
    )
    return ApprovalRead.model_validate(item)


# ------------------------------------------------------------------------- ROI
@router.get(
    "/clients/{client_id}/roi",
    response_model=RoiReport,
    tags=["roi"],
    summary="A client's ROI report",
    dependencies=[Depends(require_permission(Permission.ROI_READ))],
)
async def client_roi(
    client_id: uuid.UUID,
    period: str | None = Query(default=None, pattern=PERIOD_PATTERN),
    session: AsyncSession = Depends(get_session),
) -> RoiReport:
    client = await client_service.get_client(session, client_id)
    return await roi_report(session, client, period)


@router.put(
    "/clients/{client_id}/roi/{period}",
    response_model=RoiReport,
    tags=["roi"],
    summary="Record a month's results",
    dependencies=[Depends(require_permission(Permission.ROI_WRITE))],
)
async def put_roi(
    client_id: uuid.UUID,
    payload: RoiEntry,
    period: str = Path(pattern=PERIOD_PATTERN),
    principal: Principal = Depends(get_principal),
    session: AsyncSession = Depends(get_session),
) -> RoiReport:
    """Each funnel step is a subset of the one before, so it cannot be larger."""
    if not payload.confirmed_outcomes <= payload.qualified_leads <= payload.total_inquiries:
        raise HTTPException(
            422,
            detail="Confirmed cannot exceed qualified, and qualified cannot exceed inquiries.",
        )
    client = await client_service.get_client(session, client_id)
    result = await session.execute(
        select(RoiSnapshot).where(RoiSnapshot.client_id == client.id, RoiSnapshot.period == period)
    )
    snapshot = result.scalar_one_or_none()
    if snapshot is None:
        snapshot = RoiSnapshot(client_id=client.id, period=period)
        session.add(snapshot)
    for field, value in payload.model_dump().items():
        setattr(snapshot, field, value)
    snapshot.entered_by = principal.label
    await session.flush()
    return await roi_report(session, client, period)


# ------------------------------------------------------------------- workspace
@router.post(
    "/clients/{client_id}/workspace-records",
    response_model=WorkspaceRecordRead,
    status_code=status.HTTP_201_CREATED,
    tags=["workspace"],
    summary="Add a row to the owner's workspace",
    dependencies=[Depends(require_permission(Permission.CLIENTS_WRITE))],
)
async def create_workspace_record(
    client_id: uuid.UUID,
    payload: WorkspaceRecordCreate,
    session: AsyncSession = Depends(get_session),
) -> WorkspaceRecordRead:
    client = await client_service.get_client(session, client_id)
    record = WorkspaceRecord(client_id=client.id, **payload.model_dump())
    session.add(record)
    await session.flush()
    await session.refresh(record)
    return WorkspaceRecordRead.model_validate(record)


@router.patch(
    "/clients/{client_id}/workspace-records/{record_id}",
    response_model=WorkspaceRecordRead,
    tags=["workspace"],
    summary="Update a workspace row",
    dependencies=[Depends(require_permission(Permission.CLIENTS_WRITE))],
)
async def update_workspace_record(
    client_id: uuid.UUID,
    record_id: uuid.UUID,
    payload: WorkspaceRecordUpdate,
    session: AsyncSession = Depends(get_session),
) -> WorkspaceRecordRead:
    record = await session.get(WorkspaceRecord, record_id)
    if record is None or record.client_id != client_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such record.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, field, value)
    await session.flush()
    await session.refresh(record)
    return WorkspaceRecordRead.model_validate(record)


# ------------------------------------------------------------------------- CRM
def _prospect_read(prospect: Prospect) -> ProspectRead:
    return ProspectRead(
        **{
            field: getattr(prospect, field)
            for field in ProspectRead.model_fields
            if field != "priority_score"
        },
        priority_score=crm_service.priority_score(prospect),
    )


async def _get_prospect(session: AsyncSession, prospect_id: uuid.UUID) -> Prospect:
    prospect = await session.get(Prospect, prospect_id)
    if prospect is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such prospect.")
    return prospect


def _check_assignee(assignee: str | None) -> None:
    if assignee is not None and assignee not in crm_service.TEAM_KEYS:
        raise HTTPException(422, detail="Unknown team member.")


@router.get(
    "/crm/prospects",
    response_model=ProspectPipeline,
    tags=["crm"],
    summary="The prospect pipeline",
    dependencies=[Depends(require_any_permission(Permission.CRM, Permission.AUDIT_TRACKER))],
)
async def list_prospects(
    stage: ProspectStage | None = None,
    session: AsyncSession = Depends(get_session),
) -> ProspectPipeline:
    statement = select(Prospect).order_by(Prospect.created_at.desc()).limit(1000)
    if stage is not None:
        statement = statement.where(Prospect.stage == stage)
    items = [_prospect_read(row) for row in (await session.execute(statement)).scalars()]
    items.sort(key=lambda row: -row.priority_score)
    return ProspectPipeline(target=crm_service.PIPELINE_TARGET, items=items)


@router.post(
    "/crm/prospects",
    response_model=ProspectRead,
    status_code=status.HTTP_201_CREATED,
    tags=["crm"],
    summary="Add a prospect",
    dependencies=[Depends(require_permission(Permission.CRM))],
)
async def create_prospect(
    payload: ProspectCreate, session: AsyncSession = Depends(get_session)
) -> ProspectRead:
    _check_assignee(payload.assignee)
    data = payload.model_dump()
    data["email"] = str(data["email"]) if data["email"] else None
    prospect = Prospect(**data)
    session.add(prospect)
    await session.flush()
    await session.refresh(prospect)
    return _prospect_read(prospect)


@router.patch(
    "/crm/prospects/{prospect_id}",
    response_model=ProspectRead,
    tags=["crm"],
    summary="Update a prospect",
    dependencies=[Depends(require_permission(Permission.CRM))],
)
async def update_prospect(
    prospect_id: uuid.UUID, payload: ProspectUpdate, session: AsyncSession = Depends(get_session)
) -> ProspectRead:
    prospect = await _get_prospect(session, prospect_id)
    data = payload.model_dump(exclude_unset=True)
    _check_assignee(data.get("assignee"))
    if data.get("email"):
        data["email"] = str(data["email"])
    for field, value in data.items():
        setattr(prospect, field, value)
    await session.flush()
    await session.refresh(prospect)
    return _prospect_read(prospect)


@router.delete(
    "/crm/prospects/{prospect_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    tags=["crm"],
    summary="Remove a prospect",
    dependencies=[Depends(require_permission(Permission.CRM))],
)
async def delete_prospect(prospect_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> None:
    await session.delete(await _get_prospect(session, prospect_id))


@router.put(
    "/crm/prospects/{prospect_id}/draft",
    response_model=ProspectRead,
    tags=["crm"],
    summary="Save a client onboarding draft",
    dependencies=[Depends(require_permission(Permission.ONBOARDING_DRAFTS))],
)
async def put_onboarding_draft(
    prospect_id: uuid.UUID, payload: OnboardingDraft, session: AsyncSession = Depends(get_session)
) -> ProspectRead:
    client_service.resolve_currency(_region(payload.region_preset), payload.currency)
    prospect = await _get_prospect(session, prospect_id)
    prospect.onboarding_draft = payload.model_dump(mode="json")
    await session.flush()
    await session.refresh(prospect)
    return _prospect_read(prospect)


def _region(value: str):
    from ..clients.models import RegionPreset

    return RegionPreset(value)


@router.get(
    "/crm/drafts",
    response_model=list[ProspectRead],
    tags=["crm"],
    summary="Prospects with an onboarding draft ready to provision",
    dependencies=[Depends(require_permission(Permission.ONBOARDING_DRAFTS))],
)
async def list_drafts(session: AsyncSession = Depends(get_session)) -> list[ProspectRead]:
    result = await session.execute(select(Prospect).order_by(Prospect.updated_at.desc()).limit(200))
    return [_prospect_read(row) for row in result.scalars() if row.onboarding_draft]


@router.get(
    "/crm/standup",
    response_model=StandupView,
    tags=["crm"],
    summary="The team's stand-up for one day",
    dependencies=[Depends(require_permission(Permission.STANDUP))],
)
async def get_standup(
    day: str | None = Query(default=None, pattern=DAY_PATTERN),
    session: AsyncSession = Depends(get_session),
) -> StandupView:
    resolved = day or agency_now().strftime("%Y-%m-%d")
    members = await crm_service.standup_day(session, resolved)
    return StandupView(day=resolved, members=[StandupMemberRead(**member) for member in members])


@router.put(
    "/crm/standup/{day}/{member}/{metric}",
    response_model=StandupView,
    tags=["crm"],
    summary="Record progress against a stand-up target",
    dependencies=[Depends(require_permission(Permission.STANDUP))],
)
async def put_standup(
    member: str,
    metric: str,
    payload: StandupUpdate,
    day: str = Path(pattern=DAY_PATTERN),
    session: AsyncSession = Depends(get_session),
) -> StandupView:
    if not crm_service.is_known_metric(member, metric):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such stand-up target.")
    await crm_service.set_standup(session, day, member, metric, payload.done)
    members = await crm_service.standup_day(session, day)
    return StandupView(day=day, members=[StandupMemberRead(**row) for row in members])


# ----------------------------------------------------------------- kits, skills
@router.get(
    "/kits",
    response_model=list[StarterKit],
    tags=["kits"],
    summary="Industry starter kits",
    dependencies=[
        Depends(require_any_permission(Permission.SKILLS_READ, Permission.ONBOARDING_DRAFTS))
    ],
)
async def list_kits(session: AsyncSession = Depends(get_session)) -> list[StarterKit]:
    return [StarterKit(**kit) for kit in await kit_service.list_kits(session)]


@router.patch(
    "/kits/{key}",
    response_model=list[StarterKit],
    tags=["kits"],
    summary="Edit a starter kit",
    dependencies=[Depends(require_permission(Permission.KITS_WRITE))],
)
async def update_kit(
    key: str,
    payload: StarterKitUpdate,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> list[StarterKit]:
    changes = payload.model_dump(exclude_none=True)
    unknown = set(changes.get("skills", [])) - set(available_skills(settings))
    if unknown:
        raise HTTPException(
            422,
            detail=f"Not in the skill library: {', '.join(sorted(unknown))}.",
        )
    await kit_service.update_kit(session, key, changes)
    return [StarterKit(**kit) for kit in await kit_service.list_kits(session)]


@router.delete(
    "/kits/{key}/customisation",
    response_model=list[StarterKit],
    tags=["kits"],
    summary="Restore a starter kit's defaults",
    dependencies=[Depends(require_permission(Permission.KITS_WRITE))],
)
async def reset_kit(key: str, session: AsyncSession = Depends(get_session)) -> list[StarterKit]:
    await kit_service.reset_kit(session, key)
    return [StarterKit(**kit) for kit in await kit_service.list_kits(session)]


@router.get(
    "/skills",
    response_model=list[SkillRead],
    tags=["kits"],
    summary="The agency skill library, with full SKILL.md text",
    dependencies=[Depends(require_permission(Permission.SKILLS_READ))],
)
async def list_skills(settings: Settings = Depends(get_settings)) -> list[SkillRead]:
    return [SkillRead(**skill) for skill in await kit_service.read_skill_library(settings)]
