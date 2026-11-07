"""Tables behind Weblaud's daily operations: approvals, ROI, workspace and CRM."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..config.database import Base


# ------------------------------------------------------------------- approvals
class ApprovalKind(str, enum.Enum):
    SOCIAL_POST = "social_post"
    REEL = "reel"
    AD_BOOST = "ad_boost"
    PARTNER_EMAIL = "partner_email"
    WEBSITE_UPDATE = "website_update"
    COURIER_DISPATCH = "courier_dispatch"
    DISCOUNT_OFFER = "discount_offer"


class ApprovalStatus(str, enum.Enum):
    """See ``ops.approvals`` for the legal moves between these."""

    QA_REVIEW = "qa_review"
    QA_RETURNED = "qa_returned"
    PENDING_OWNER = "pending_owner"
    APPROVED = "approved"
    CHANGES_REQUESTED = "changes_requested"
    REJECTED = "rejected"


class ApprovalItem(Base):
    __tablename__ = "approval_items"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[ApprovalKind] = mapped_column(
        SAEnum(ApprovalKind, name="approval_kind", native_enum=False)
    )
    status: Mapped[ApprovalStatus] = mapped_column(
        SAEnum(ApprovalStatus, name="approval_status", native_enum=False), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    #: What the owner sees: post text, an amount, a courier, a tracking number.
    preview: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source_skill: Mapped[str | None] = mapped_column(String(64))
    escalated: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Latest note from QA or the owner, shown to whoever acts next.
    note: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[str | None] = mapped_column(String(320))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ------------------------------------------------------------------------- ROI
class RoiSnapshot(Base):
    """One month's results for a client. Nothing is estimated into these columns."""

    __tablename__ = "roi_snapshots"
    __table_args__ = (UniqueConstraint("client_id", "period", name="uq_roi_client_period"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    #: ``YYYY-MM``.
    period: Mapped[str] = mapped_column(String(7), index=True)
    total_inquiries: Mapped[int] = mapped_column(Integer, default=0)
    qualified_leads: Mapped[int] = mapped_column(Integer, default=0)
    #: Confirmed bookings, or delivered orders for an e-commerce client.
    confirmed_outcomes: Mapped[int] = mapped_column(Integer, default=0)
    #: Null falls back to the baseline's value.
    avg_order_or_profit_value: Mapped[float | None] = mapped_column(Float)
    ad_spend: Mapped[float] = mapped_column(Float, default=0)
    #: Null falls back to the baseline's retainer.
    retainer: Mapped[float | None] = mapped_column(Float)
    entered_by: Mapped[str | None] = mapped_column(String(320))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ------------------------------------------------------------------- workspace
class WorkspaceKind(str, enum.Enum):
    APPOINTMENT = "appointment"
    LEAD = "lead"
    FOLLOW_UP = "follow_up"
    ORDER = "order"
    STOCK_ALERT = "stock_alert"


class WorkspaceRecord(Base):
    """A row in the owner's daily workspace, pushed by a skill or by the team."""

    __tablename__ = "workspace_records"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[WorkspaceKind] = mapped_column(
        SAEnum(WorkspaceKind, name="workspace_kind", native_enum=False), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(32), default="open")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ------------------------------------------------------------------------- CRM
class ProspectStage(str, enum.Enum):
    NEW = "new"
    QUALIFIED = "qualified"
    CONTACTED = "contacted"
    VIDEO_AUDIT_SENT = "video_audit_sent"
    MEETING = "meeting"
    PROPOSAL = "proposal"
    WON = "won"


class AuditProgress(str, enum.Enum):
    NOT_STARTED = "not_started"
    RECORDING = "recording"
    SENT = "sent"
    VIEWED = "viewed"


class Prospect(Base):
    __tablename__ = "prospects"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    business_name: Mapped[str] = mapped_column(String(200))
    contact_name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(320))
    niche: Mapped[str | None] = mapped_column(String(64))
    stage: Mapped[ProspectStage] = mapped_column(
        SAEnum(ProspectStage, name="prospect_stage", native_enum=False),
        default=ProspectStage.NEW,
        index=True,
    )
    # The five signals behind the priority score.
    no_website: Mapped[bool] = mapped_column(Boolean, default=False)
    irregular_social: Mapped[bool] = mapped_column(Boolean, default=False)
    slow_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    repeat_high_value_sales: Mapped[bool] = mapped_column(Boolean, default=False)
    accessible_owner: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Which team member this belongs to: a key from ``ops.crm.TEAM``.
    assignee: Mapped[str | None] = mapped_column(String(32))
    audit_progress: Mapped[AuditProgress] = mapped_column(
        SAEnum(AuditProgress, name="audit_progress", native_enum=False),
        default=AuditProgress.NOT_STARTED,
    )
    audit_url: Mapped[str | None] = mapped_column(String(500))
    next_follow_up: Mapped[str | None] = mapped_column(String(10))
    notes: Mapped[str] = mapped_column(Text, default="")
    #: A client onboarding draft, filled in by sales and provisioned by an admin.
    onboarding_draft: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StandupEntry(Base):
    __tablename__ = "standup_entries"
    __table_args__ = (UniqueConstraint("day", "member", "metric", name="uq_standup_day_metric"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    #: ``YYYY-MM-DD`` in the agency's own timezone.
    day: Mapped[str] = mapped_column(String(10), index=True)
    member: Mapped[str] = mapped_column(String(32))
    metric: Mapped[str] = mapped_column(String(32))
    done: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StarterKitOverride(Base):
    """The team's edits to a built-in starter kit. No row means the defaults."""

    __tablename__ = "starter_kit_overrides"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ---------------------------------------------------------------------- social
class SocialPostStatus(str, enum.Enum):
    #: Waiting on the Weblaud QA team (Shadow Week) or on the owner's one tap.
    AWAITING_APPROVAL = "awaiting_approval"
    PUBLISHED = "published"
    FAILED = "failed"
    REJECTED = "rejected"


class SocialPost(Base):
    """A post the autopilot made, and what became of it."""

    __tablename__ = "social_posts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[SocialPostStatus] = mapped_column(
        SAEnum(SocialPostStatus, name="social_post_status", native_enum=False), index=True
    )
    headline: Mapped[str] = mapped_column(String(200))
    subtext: Mapped[str] = mapped_column(String(200), default="")
    caption: Mapped[str] = mapped_column(Text, default="")
    hashtags: Mapped[list[str]] = mapped_column(JSON, default=list)
    platforms: Mapped[list[str]] = mapped_column(JSON, default=list)
    #: File name under ``<social_media_dir>/<slug>/``. Never a path.
    image_filename: Mapped[str | None] = mapped_column(String(80))
    #: Which renderer made the visual: ``studio_canvas_overlay``, ``svg_fallback``, ...
    visual_engine: Mapped[str | None] = mapped_column(String(48))
    #: ``live`` reached Meta; ``sandbox`` recorded what would have been posted.
    publish_mode: Mapped[str | None] = mapped_column(String(16))
    permalink: Mapped[str | None] = mapped_column(String(500))
    external_id: Mapped[str | None] = mapped_column(String(120))
    #: Null means unknown: nothing reads Meta's insights yet, so reach is never invented.
    reach: Mapped[int | None] = mapped_column(Integer)
    approval_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("approval_items.id", ondelete="SET NULL"))
    error: Mapped[str | None] = mapped_column(Text)
    #: A sample row from the demo seed, shown as such.
    demo: Mapped[bool] = mapped_column(Boolean, default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class SocialComment(Base):
    """A comment on one of the autopilot's posts, the reply it got, and the handoff."""

    __tablename__ = "social_comments"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    post_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("social_posts.id", ondelete="CASCADE"), index=True
    )
    author: Mapped[str] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text)
    public_reply: Mapped[str] = mapped_column(Text, default="")
    #: The specialist that picked the conversation up in the inbox.
    handoff_skill: Mapped[str | None] = mapped_column(String(64))
    dm_text: Mapped[str] = mapped_column(Text, default="")
    #: ``replied_live`` went through Meta; ``replied_simulated`` is the sandbox receipt.
    reply_status: Mapped[str] = mapped_column(String(24), default="replied_simulated")
    #: Sample conversation written by the sandbox, not a real customer.
    sample: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
