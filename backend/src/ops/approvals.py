"""The approval queue's state machine.

                 forward                approve
    qa_review ───────────▶ pending_owner ───────▶ approved
       ▲   │ return             │  │ reject
       │   ▼                    │  └─────────────▶ rejected
    revise  qa_returned         │ edit
       ▲                        ▼
       └──────────────── changes_requested

A new item enters ``qa_review`` until the client reaches Autonomous Live, so that
nothing reaches an owner during Shadow Week without the team having seen it. After
that it enters ``pending_owner``, or straight to ``approved`` if the owner promoted
that kind of item to the Automatic lane.

Every move is one conditional UPDATE, so two people tapping at once cannot both
win: the second finds the status already changed and gets a conflict.

Approving records the decision. It does not yet tell the tenant's agent to act,
because the agent has no route for receiving that instruction.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.models import ONBOARDING_AUTONOMOUS, AuditStatus, BusinessMode, Client
from ..clients.service import record_audit
from .guardrails import lane_for_kind
from .models import ApprovalItem, ApprovalKind, ApprovalStatus

AUTOMATIC_ACTOR = "guardrail:automatic"

OWNER_DECISIONS: dict[str, ApprovalStatus] = {
    "approve": ApprovalStatus.APPROVED,
    "edit": ApprovalStatus.CHANGES_REQUESTED,
    "reject": ApprovalStatus.REJECTED,
}
QA_DECISIONS: dict[str, ApprovalStatus] = {
    "forward": ApprovalStatus.PENDING_OWNER,
    "return": ApprovalStatus.QA_RETURNED,
    "escalate": ApprovalStatus.QA_REVIEW,
}
#: Decisions that mean nothing without saying why.
NOTE_REQUIRED = frozenset({"edit", "return", "escalate"})
REVISABLE = (ApprovalStatus.QA_RETURNED, ApprovalStatus.CHANGES_REQUESTED)


class ApprovalNotFoundError(LookupError):
    pass


class ApprovalTransitionError(ValueError):
    """The item is not in a state this decision can apply to."""


class ApprovalInputError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def entry_status(client: Client) -> ApprovalStatus:
    if client.onboarding_stage < ONBOARDING_AUTONOMOUS:
        return ApprovalStatus.QA_REVIEW
    return ApprovalStatus.PENDING_OWNER


async def create_item(
    session: AsyncSession,
    client: Client,
    *,
    kind: ApprovalKind,
    title: str,
    summary: str = "",
    preview: dict[str, Any] | None = None,
    source_skill: str | None = None,
) -> ApprovalItem:
    if kind is ApprovalKind.COURIER_DISPATCH and client.business_mode is not BusinessMode.ECOMMERCE:
        raise ApprovalInputError("Courier dispatch only applies to e-commerce clients.")

    status = entry_status(client)
    decided_by: str | None = None
    decided_at: datetime | None = None
    # The owner's promotion only applies once the team has stopped checking first.
    if status is ApprovalStatus.PENDING_OWNER and lane_for_kind(client, kind) == "automatic":
        status = ApprovalStatus.APPROVED
        decided_by = AUTOMATIC_ACTOR
        decided_at = _now()

    item = ApprovalItem(
        client_id=client.id,
        kind=kind,
        status=status,
        title=title,
        summary=summary,
        preview=preview or {},
        source_skill=source_skill,
        escalated=False,
        decided_by=decided_by,
        decided_at=decided_at,
    )
    session.add(item)
    await session.flush()
    await record_audit(
        session, client, "approval.created", AuditStatus.SUCCEEDED,
        f"Queued {kind.value}: {status.value}.",
        payload={"item_id": str(item.id), "kind": kind.value, "status": status.value},
    )
    return item


async def get_item(session: AsyncSession, client_id: uuid.UUID, item_id: uuid.UUID) -> ApprovalItem:
    # Scoped by client, so one tenant's id can never resolve under another's path.
    result = await session.execute(
        select(ApprovalItem).where(ApprovalItem.id == item_id, ApprovalItem.client_id == client_id)
    )
    item = result.scalar_one_or_none()
    if item is None:
        raise ApprovalNotFoundError(str(item_id))
    return item


async def _move(
    session: AsyncSession,
    item: ApprovalItem,
    *,
    allowed_from: tuple[ApprovalStatus, ...],
    values: dict[str, Any],
) -> None:
    """Apply one transition, or raise if another request got there first."""
    result = await session.execute(
        update(ApprovalItem)
        .where(ApprovalItem.id == item.id, ApprovalItem.status.in_(allowed_from))
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise ApprovalTransitionError(item.status.value)
    await session.refresh(item)


async def decide_as_owner(
    session: AsyncSession,
    client: Client,
    item_id: uuid.UUID,
    *,
    decision: str,
    actor: str,
    note: str | None = None,
) -> ApprovalItem:
    if decision not in OWNER_DECISIONS:
        raise ApprovalInputError("Unknown decision.")
    if decision in NOTE_REQUIRED and not (note or "").strip():
        raise ApprovalInputError("Tell the team what to change.")
    item = await get_item(session, client.id, item_id)
    await _move(
        session,
        item,
        allowed_from=(ApprovalStatus.PENDING_OWNER,),
        values={
            "status": OWNER_DECISIONS[decision],
            "note": (note or "").strip() or None,
            "decided_by": actor,
            "decided_at": _now(),
        },
    )
    await record_audit(
        session, client, f"approval.owner.{decision}", AuditStatus.SUCCEEDED,
        f"{actor} chose {decision} on {item.kind.value}.",
        payload={"item_id": str(item.id), "actor": actor, "status": item.status.value},
    )
    return item


async def decide_as_qa(
    session: AsyncSession,
    client: Client,
    item_id: uuid.UUID,
    *,
    decision: str,
    actor: str,
    note: str | None = None,
) -> ApprovalItem:
    if decision not in QA_DECISIONS:
        raise ApprovalInputError("Unknown decision.")
    if decision in NOTE_REQUIRED and not (note or "").strip():
        raise ApprovalInputError("Add a note for whoever picks this up.")
    item = await get_item(session, client.id, item_id)
    await _move(
        session,
        item,
        allowed_from=(ApprovalStatus.QA_REVIEW,),
        values={
            "status": QA_DECISIONS[decision],
            "note": (note or "").strip() or None,
            "escalated": decision == "escalate",
        },
    )
    await record_audit(
        session, client, f"approval.qa.{decision}", AuditStatus.SUCCEEDED,
        f"{actor} chose {decision} on {item.kind.value}.",
        payload={"item_id": str(item.id), "actor": actor, "status": item.status.value},
    )
    return item


async def revise(
    session: AsyncSession,
    client: Client,
    item_id: uuid.UUID,
    *,
    actor: str,
    title: str | None = None,
    summary: str | None = None,
    preview: dict[str, Any] | None = None,
) -> ApprovalItem:
    """Send a corrected draft back through the queue from the start."""
    item = await get_item(session, client.id, item_id)
    values: dict[str, Any] = {
        "status": entry_status(client),
        "escalated": False,
        "decided_by": None,
        "decided_at": None,
    }
    if title is not None:
        values["title"] = title
    if summary is not None:
        values["summary"] = summary
    if preview is not None:
        values["preview"] = preview
    await _move(session, item, allowed_from=REVISABLE, values=values)
    await record_audit(
        session, client, "approval.revised", AuditStatus.SUCCEEDED,
        f"{actor} revised a {item.kind.value}.",
        payload={"item_id": str(item.id), "actor": actor, "status": item.status.value},
    )
    return item


async def list_for_client(session: AsyncSession, client_id: uuid.UUID, limit: int = 100) -> list[ApprovalItem]:
    result = await session.execute(
        select(ApprovalItem)
        .where(ApprovalItem.client_id == client_id)
        .order_by(ApprovalItem.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def qa_queue(session: AsyncSession, limit: int = 200) -> list[tuple[ApprovalItem, Client]]:
    """Everything the team still has to act on, escalations first."""
    result = await session.execute(
        select(ApprovalItem, Client)
        .join(Client, Client.id == ApprovalItem.client_id)
        .where(
            ApprovalItem.status.in_(
                (ApprovalStatus.QA_REVIEW, ApprovalStatus.QA_RETURNED, ApprovalStatus.CHANGES_REQUESTED)
            )
        )
        .order_by(ApprovalItem.escalated.desc(), ApprovalItem.created_at)
        .limit(limit)
    )
    return [(item, client) for item, client in result.all()]
