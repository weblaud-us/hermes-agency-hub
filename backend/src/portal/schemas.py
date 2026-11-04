"""Response and request shapes for the tenant portal.

A field here is a promise to a business owner's browser, so nothing below may
hold a raw model string, port, path, container name or vendor name. Telemetry
that has no real source is ``None``; the portal shows a dash rather than a
fabricated figure.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

AgentStatus = Literal["online", "degraded", "offline"]
ChannelName = Literal["whatsapp", "telegram", "slack", "web_widget"]
ChannelStatus = Literal[
    "connected", "connecting", "action_needed", "disconnected", "not_configured"
]
ReportStatus = Literal["success", "failed", "no_action"]
JobStatus = Literal["scheduled", "paused", "running", "error"]
ReconnectState = Literal["refreshing", "qr_pending", "qr_ready", "connected", "failed"]


class _Strict(BaseModel):
    """Request bodies: an unexpected field is a client bug, not something to drop."""

    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------ overview
class PortalOverview(BaseModel):
    company_name: str
    agent_status: AgentStatus
    #: Estimated over the last 30 days from the most recent outage Docker
    #: recorded. ``None`` when the tenant has never been provisioned.
    uptime_percentage: float | None
    tasks_completed_30d: int | None
    #: Actions in the prior 30 days, compared with the current 30.
    tasks_trend_pct: float | None
    #: Daily action counts, oldest first, for the sparkline.
    tasks_daily: list[int]
    estimated_hours_saved: float | None
    avg_response_seconds: float | None
    learned_skill_count: int
    active_model_tier: str
    connected_channels: int
    scheduled_briefings: int


# ------------------------------------------------------------------ channels
class AllowlistEntry(BaseModel):
    #: Opaque handle for removal, so the full number never needs to round-trip.
    id: str
    display: str


class PortalChannel(BaseModel):
    channel: ChannelName
    status: ChannelStatus
    session_verified: bool
    masked_handle: str | None
    last_message_at: datetime | None
    messages_24h: int | None
    allowlist: list[AllowlistEntry]
    #: True when the channel answers anyone, which the portal warns about.
    allow_all: bool
    voice_transcription: bool | None = None
    #: Plain-language next step when ``status`` is ``action_needed``.
    attention: str | None = None


class ChannelList(BaseModel):
    channels: list[PortalChannel]


class AllowlistUpdate(_Strict):
    add: list[Annotated[str, Field(max_length=32)]] = Field(default_factory=list, max_length=20)
    remove_ids: list[Annotated[str, Field(max_length=32)]] = Field(
        default_factory=list, max_length=50
    )


class ChannelTestResult(BaseModel):
    channel: ChannelName
    ok: bool
    #: Only true when a message really went out. A passing connection check
    #: alone leaves this false, and the portal words its result accordingly.
    message_delivered: bool
    latency_ms: float | None
    detail: str


class ReconnectResult(BaseModel):
    channel: ChannelName
    state: ReconnectState
    #: PNG of the WhatsApp pairing QR, base64-encoded, while ``state`` is ``qr_ready``.
    qr_png_base64: str | None = None
    #: Seconds until this QR is replaced by a newer one.
    qr_refresh_seconds: int | None = None
    detail: str


# ------------------------------------------------------------------- reports
class ReportMetric(BaseModel):
    label: str
    value: int


class CronReport(BaseModel):
    id: str
    job_id: str
    job_name: str
    schedule_human: str
    executed_at: datetime
    duration_ms: int | None
    status: ReportStatus
    summary_markdown: str
    metrics_json: list[ReportMetric]


class CronJobSummary(BaseModel):
    id: str
    job_name: str
    schedule_human: str
    status: JobStatus
    next_run_at: datetime | None
    last_run_at: datetime | None


class CronReportFeed(BaseModel):
    jobs: list[CronJobSummary]
    reports: list[CronReport]


class TriggerResult(BaseModel):
    job_id: str
    queued: bool
    detail: str


# -------------------------------------------------------- skills and memory
class AgencySkill(BaseModel):
    id: str
    title: str
    category: str
    description: str
    active: bool


class LearnedSkill(BaseModel):
    id: str
    title: str
    category: str
    description: str
    trigger_conditions: str
    workflow_markdown: str
    last_used: datetime | None
    use_count: int
    enabled: bool


class MemoryFact(BaseModel):
    id: str
    text: str
    category: str


class BusinessMemory(BaseModel):
    facts: list[MemoryFact]
    #: The agent refuses to grow its memory past this, so the portal must too.
    used_chars: int
    limit_chars: int


class SkillsAndMemory(BaseModel):
    agency_verified_skills: list[AgencySkill]
    learned_skills: list[LearnedSkill]
    business_memory: BusinessMemory


class SkillToggle(_Strict):
    enabled: bool


class MemoryPatch(_Strict):
    op: Literal["append", "remove", "replace"]
    text: str | None = Field(default=None, max_length=2000)
    id: str | None = Field(default=None, max_length=32)


# ---------------------------------------------------------------------- chat
class ChatMessage(_Strict):
    #: No "system": a caller must never be able to supply its own instructions.
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(_Strict):
    messages: list[ChatMessage] = Field(min_length=1, max_length=30)


class ChatReply(BaseModel):
    reply: str
    duration_ms: int


# --------------------------------------------------------------- admin issue
class PortalTokenRequest(_Strict):
    ttl_days: int | None = Field(default=None, ge=1, le=365)
    #: Invalidate every token already issued for this tenant before minting.
    revoke_existing: bool = False


class PortalTokenResponse(BaseModel):
    token: str
    expires_at: datetime
    #: The link to send. The token sits in the fragment, which browsers do not
    #: send to servers, so it stays out of access logs and referrers.
    portal_url: str
