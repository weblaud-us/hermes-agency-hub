"""Request and response shapes for agency operations and the portal's growth views."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from ..clients.schemas import BaselineMetrics, BrandKit
from .models import ApprovalKind, ApprovalStatus, AuditProgress, ProspectStage, WorkspaceKind

_PERIOD = r"^\d{4}-(0[1-9]|1[0-2])$"
_DAY = r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------- approvals
class ApprovalCreate(_Strict):
    kind: ApprovalKind
    title: str = Field(min_length=2, max_length=200)
    summary: str = Field(default="", max_length=4000)
    preview: dict[str, Any] = Field(default_factory=dict)
    source_skill: str | None = Field(default=None, max_length=64)


class ApprovalRead(BaseModel):
    """As the agency sees it, including which skill drafted it."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_id: uuid.UUID
    kind: ApprovalKind
    status: ApprovalStatus
    title: str
    summary: str
    preview: dict[str, Any]
    source_skill: str | None
    escalated: bool
    note: str | None
    decided_by: str | None
    decided_at: datetime | None
    created_at: datetime | None
    updated_at: datetime | None


class QaQueueItem(ApprovalRead):
    company_name: str
    client_slug: str
    onboarding_stage: int


class QaDecision(_Strict):
    decision: Literal["forward", "return", "escalate"]
    note: str | None = Field(default=None, max_length=2000)


class ApprovalRevise(_Strict):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    summary: str | None = Field(default=None, max_length=4000)
    preview: dict[str, Any] | None = None


class PortalApproval(BaseModel):
    """As an owner sees it. Text passes through the portal's scrub on the way out."""

    id: uuid.UUID
    kind: ApprovalKind
    status: ApprovalStatus
    title: str
    summary: str
    preview: dict[str, Any]
    note: str | None
    decided_at: datetime | None
    created_at: datetime | None
    decided_automatically: bool


class OwnerDecision(_Strict):
    decision: Literal["approve", "edit", "reject"]
    note: str | None = Field(default=None, max_length=2000)


class GuardrailRead(BaseModel):
    key: str
    label: str
    lane: Literal["automatic", "owner", "never"]
    default_lane: Literal["automatic", "owner", "never"]
    promotable: bool


class GuardrailUpdate(_Strict):
    lane: Literal["automatic", "owner"]


# ------------------------------------------------------------------------- ROI
class RoiEntry(_Strict):
    total_inquiries: int = Field(ge=0, le=10_000_000)
    qualified_leads: int = Field(ge=0, le=10_000_000)
    confirmed_outcomes: int = Field(ge=0, le=10_000_000)
    avg_order_or_profit_value: float | None = Field(default=None, ge=0)
    ad_spend: float = Field(default=0, ge=0)
    retainer: float | None = Field(default=None, ge=0)


class RoiFunnel(BaseModel):
    total_inquiries: int
    qualified_leads: int
    confirmed_outcomes: int
    #: Percent of inquiries confirmed. ``None`` with no inquiries to divide by.
    conversion_rate: float | None


class RoiResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    baseline_outcomes: float
    current_outcomes: int
    value_per_outcome: float
    baseline_gross_profit: float
    current_gross_profit: float
    incremental_gross_profit: float
    retainer: float
    ad_spend: float
    total_investment: float
    net_value: float
    roi_percent: float | None


class RoiReport(BaseModel):
    period: str
    currency: str
    business_mode: str
    baseline: BaselineMetrics | None
    funnel: RoiFunnel | None
    #: ``None`` until both a baseline and this month's figures exist. The portal
    #: says what is missing rather than showing an invented number.
    result: RoiResultRead | None
    available_periods: list[str]


# ------------------------------------------------------------------- workspace
class WorkspaceRecordCreate(_Strict):
    kind: WorkspaceKind
    title: str = Field(min_length=2, max_length=200)
    status: str = Field(default="open", max_length=32)
    detail: dict[str, Any] = Field(default_factory=dict)
    due_at: datetime | None = None


class WorkspaceRecordUpdate(_Strict):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    status: str | None = Field(default=None, max_length=32)
    detail: dict[str, Any] | None = None
    due_at: datetime | None = None


class WorkspaceRecordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: WorkspaceKind
    title: str
    status: str
    detail: dict[str, Any]
    due_at: datetime | None
    updated_at: datetime | None


class WorkspaceView(BaseModel):
    business_mode: str
    records: list[WorkspaceRecordRead]


class PortalProfile(BaseModel):
    company_name: str
    business_mode: str
    niche_template: str
    package_tier: str
    region_preset: str
    currency: str
    onboarding_stage: int
    pending_approvals: int
    #: A seeded demo tenant. The portal labels its figures as samples.
    is_demo: bool


# ------------------------------------------------------------------------- CRM
class ProspectBase(BaseModel):
    business_name: str = Field(min_length=2, max_length=200)
    contact_name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = None
    niche: str | None = Field(default=None, max_length=64)
    stage: ProspectStage = ProspectStage.NEW
    no_website: bool = False
    irregular_social: bool = False
    slow_reply: bool = False
    repeat_high_value_sales: bool = False
    accessible_owner: bool = False
    assignee: str | None = Field(default=None, max_length=32)
    audit_progress: AuditProgress = AuditProgress.NOT_STARTED
    audit_url: str | None = Field(default=None, max_length=500, pattern=r"^https?://")
    next_follow_up: str | None = Field(default=None, pattern=_DAY)
    notes: str = Field(default="", max_length=4000)


class ProspectCreate(ProspectBase):
    model_config = ConfigDict(extra="forbid")


class ProspectUpdate(_Strict):
    business_name: str | None = Field(default=None, min_length=2, max_length=200)
    contact_name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: EmailStr | None = None
    niche: str | None = Field(default=None, max_length=64)
    stage: ProspectStage | None = None
    no_website: bool | None = None
    irregular_social: bool | None = None
    slow_reply: bool | None = None
    repeat_high_value_sales: bool | None = None
    accessible_owner: bool | None = None
    assignee: str | None = Field(default=None, max_length=32)
    audit_progress: AuditProgress | None = None
    audit_url: str | None = Field(default=None, max_length=500, pattern=r"^https?://")
    next_follow_up: str | None = Field(default=None, pattern=_DAY)
    notes: str | None = Field(default=None, max_length=4000)


class OnboardingDraft(_Strict):
    company_name: str = Field(min_length=2, max_length=200)
    contact_email: EmailStr | None = None
    business_mode: Literal["general", "ecommerce"] = "general"
    niche_template: str = Field(default="custom", max_length=32)
    package_tier: Literal["presence", "growth", "scale"] = "presence"
    region_preset: Literal["bd", "global"] = "bd"
    currency: str | None = Field(default=None, max_length=3)
    baseline_metrics: BaselineMetrics | None = None
    notes: str = Field(default="", max_length=4000)


class ProspectRead(ProspectBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    priority_score: int
    onboarding_draft: dict[str, Any] | None
    created_at: datetime | None
    updated_at: datetime | None


class ProspectPipeline(BaseModel):
    target: int
    items: list[ProspectRead]


class StandupMetricRead(BaseModel):
    key: str
    label: str
    target: int
    done: int


class StandupMemberRead(BaseModel):
    key: str
    name: str
    focus: str
    metrics: list[StandupMetricRead]
    completion_percent: int


class StandupView(BaseModel):
    day: str
    members: list[StandupMemberRead]


class StandupUpdate(_Strict):
    done: int = Field(ge=0, le=1000)


# ------------------------------------------------------------------------ kits
class StarterKit(BaseModel):
    key: str
    name: str
    business_mode: str
    description: str
    skills: list[str]
    knowledge_checklist: list[str]
    customised: bool


class StarterKitUpdate(_Strict):
    description: str | None = Field(default=None, max_length=1000)
    skills: list[str] | None = Field(default=None, max_length=30)
    knowledge_checklist: list[str] | None = Field(default=None, max_length=40)


class SkillRead(BaseModel):
    id: str
    description: str
    group: Literal["router", "core", "ecommerce"]
    markdown: str


PERIOD_PATTERN = _PERIOD
DAY_PATTERN = _DAY


# ---------------------------------------------------------------------- social
class SocialSettingsUpdate(_Strict):
    autopilot_social: bool | None = None
    brand_kit: BrandKit | None = None


class SocialPostRead(BaseModel):
    id: uuid.UUID
    status: Literal["awaiting_approval", "published", "failed", "rejected"]
    headline: str
    subtext: str
    caption: str
    hashtags: list[str]
    platforms: list[str]
    has_image: bool
    visual_engine: str | None
    #: ``live`` reached Meta, ``sandbox`` is a recorded dry run, null if never published.
    publish_mode: Literal["live", "sandbox"] | None
    permalink: str | None
    #: Null when unknown. Nothing reads Meta's insights yet, so this is never a guess.
    reach: int | None
    comments_replied: int
    leads_captured: int
    #: Written for the owner. The operator detail stays in the hub.
    error: str | None
    demo: bool
    published_at: datetime | None
    created_at: datetime


class SocialCommentRead(BaseModel):
    id: uuid.UUID
    post_id: uuid.UUID
    author: str
    text: str
    public_reply: str
    #: Who took the conversation over in the inbox, e.g. "Sales Rep" or "Order Desk".
    handoff_to: str | None
    dm_text: str
    live: bool
    #: A sandbox example of what the autopilot does with a comment, not a customer.
    sample: bool
    created_at: datetime


class SocialAutopilotView(BaseModel):
    autopilot_social: bool
    brand_kit: BrandKit
    #: Whether publishing reaches Meta. False is sandbox mode.
    live_publishing: bool
    business_mode: str
    posts: list[SocialPostRead]
    comments: list[SocialCommentRead]


class GenerateNowResponse(BaseModel):
    outcome: Literal["published", "awaiting_owner", "in_qa_review", "failed"]
    message: str
    post: SocialPostRead
    comments: list[SocialCommentRead]


# ---------------------------------------------------------------------- roster
class RosterAgent(BaseModel):
    key: str
    name: str
    role: str
    #: Only the e-commerce roster has these two.
    ecommerce_only: bool
    active: bool


class RosterView(BaseModel):
    business_mode: Literal["general", "ecommerce"]
    #: Both rosters, so the owner can compare what each business model brings.
    rosters: dict[str, list[RosterAgent]]
