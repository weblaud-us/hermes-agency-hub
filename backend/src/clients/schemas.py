"""Request/response shapes for the client management API."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from slugify import slugify

from .models import AuditStatus, ClientPlan, SubscriptionStatus

#: A single DNS label: lowercase alphanumerics and inner hyphens, 1-63 chars.
#: Enforced here because an invalid label would only fail much later, when
#: nginx refuses the generated server_name.
SUBDOMAIN_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"


class OnboardRequest(BaseModel):
    """Everything needed to stand up a new tenant."""

    company_name: str = Field(min_length=2, max_length=200)
    #: The DNS label the tenant is reachable at, e.g. "acme" for
    #: acme.<base_domain>. Defaults to a slug of the company name.
    subdomain: str | None = Field(default=None, max_length=63)
    #: Per-tenant model provider credential. Written only into the tenant's
    #: 0600 .env on disk — never stored in the hub database.
    openrouter_api_key: str = Field(min_length=8, repr=False)
    contact_email: EmailStr
    plan: ClientPlan = ClientPlan.STARTER
    image: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    channels: dict[str, Any] = Field(default_factory=dict)

    @field_validator("subdomain")
    @classmethod
    def _normalise(cls, value: str | None) -> str | None:
        if not value:
            return None
        slug = slugify(value)
        # max_length above only bounds the raw input, and transliteration can
        # lengthen it ("ß" becomes "ss").
        if slug and not re.fullmatch(SUBDOMAIN_PATTERN, slug):
            raise ValueError(f"'{slug}' is not a valid DNS label.")
        return slug


class ClientCreate(BaseModel):
    """Internal creation payload (no container, no credentials)."""

    company_name: str = Field(min_length=2, max_length=200)
    contact_email: EmailStr
    plan: ClientPlan = ClientPlan.STARTER
    #: Defaults to a slug of ``company_name``; also becomes the subdomain label.
    slug: str | None = Field(default=None, max_length=63)
    image: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    channels: dict[str, Any] = Field(default_factory=dict)
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None

    @field_validator("slug")
    @classmethod
    def _normalise_slug(cls, value: str | None) -> str | None:
        return slugify(value) if value else None


class ClientUpdate(BaseModel):
    company_name: str | None = Field(default=None, min_length=2, max_length=200)
    contact_email: EmailStr | None = None
    plan: ClientPlan | None = None
    image: str | None = None
    config: dict[str, Any] | None = None
    channels: dict[str, Any] | None = None
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    action: str
    status: AuditStatus
    message: str
    payload: dict[str, Any]
    timestamp: datetime


class ClientRead(BaseModel):
    """A client as the agency dashboard sees it. Carries no secrets."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    company_name: str
    slug: str
    subdomain: str
    contact_email: str
    url: str = ""
    plan: ClientPlan
    subscription_status: SubscriptionStatus
    status_detail: str | None
    image: str
    container_id: str | None
    container_name: str | None
    container_port_dash: int | None
    container_port_api: int | None
    cpu_limit: float
    memory_limit: str
    database_name: str | None
    dashboard_username: str
    #: Trailing fragment of the tenant's provider key, for support triage.
    openrouter_key_last4: str | None
    config: dict[str, Any]
    channels: dict[str, Any]
    synced_skills: list[str]
    stripe_customer_id: str | None
    stripe_subscription_id: str | None
    created_at: datetime
    updated_at: datetime
    provisioned_at: datetime | None
    suspended_at: datetime | None


class ClientList(BaseModel):
    items: list[ClientRead]
    total: int
    limit: int
    offset: int


class OnboardResponse(BaseModel):
    """Result of a successful onboarding.

    ``dashboard_password`` is returned **exactly once**. The hub stores only
    its scrypt hash, so it cannot be recovered or re-displayed — reissuing it
    means generating a new one. Capture it before discarding this response.
    """

    client_id: uuid.UUID
    company_name: str
    subdomain: str
    status: SubscriptionStatus
    dashboard_url: str
    dashboard_username: str
    dashboard_password: str
    api_base_url: str
    api_key: str
    container_name: str | None
    container_port_dash: int | None
    container_port_api: int | None
    synced_skills: list[str]
    #: Set when the container came up but failed its health probe, so the
    #: caller learns the credentials are valid while the tenant is not ready.
    warning: str | None = None


class TeardownResponse(BaseModel):
    client_id: uuid.UUID
    subdomain: str
    status: SubscriptionStatus
    container_removed: bool
    proxy_removed: bool
    #: Where the tenant's data was moved, or ``None`` when it was deleted.
    archive_path: str | None


class PortProbe(BaseModel):
    """Result of one HTTP health probe against a tenant service."""

    url: str
    reachable: bool
    status: int | None = None
    latency_ms: float | None = None
    error: str | None = None


class ClientHealth(BaseModel):
    client_id: uuid.UUID
    slug: str
    subdomain: str
    subscription_status: SubscriptionStatus
    #: Docker's view: running / exited / absent / ...
    container_state: str
    container_id: str | None = None
    container_health: str | None = None
    started_at: str | None = None
    restart_count: int = 0
    dashboard: PortProbe | None = None
    api: PortProbe | None = None
    #: True only when the container runs and both services answer.
    healthy: bool = False


class ContainerLogs(BaseModel):
    client_id: uuid.UUID
    slug: str
    lines: list[str]


class SkillSyncResult(BaseModel):
    client_id: uuid.UUID
    slug: str
    skills: list[str]
    restarted: bool


class HubStats(BaseModel):
    total: int
    by_status: dict[str, int]
    by_plan: dict[str, int]
    running_containers: int
