"""Persistence model for agency clients and their lifecycle audit trail."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..config.database import Base


class SubscriptionStatus(str, enum.Enum):
    """Where a client sits in the provisioning / billing lifecycle."""

    PENDING = "pending"          # row created, container not yet built
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    SUSPENDED = "suspended"      # billing lapsed or manually paused
    FAILED = "failed"            # provisioning blew up; safe to retry
    ARCHIVED = "archived"        # container and routes torn down


class ClientPlan(str, enum.Enum):
    STARTER = "starter"
    GROWTH = "growth"
    SCALE = "scale"


class AuditStatus(str, enum.Enum):
    """Outcome of one audited action.

    A single action normally writes two rows: ``STARTED`` when it begins and
    ``SUCCEEDED``/``FAILED`` when it resolves. A lone ``STARTED`` row therefore
    means the hub died mid-operation — useful for reconciliation.
    """

    STARTED = "started"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    company_name: Mapped[str] = mapped_column(String(200))
    #: DNS label derived from the company name. Doubles as the container-name
    #: suffix and the nginx site filename, so it is kept alongside the full
    #: ``subdomain`` rather than re-derived at each use site.
    slug: Mapped[str] = mapped_column(String(63), unique=True, index=True)
    subdomain: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    contact_email: Mapped[str] = mapped_column(String(320))

    plan: Mapped[ClientPlan] = mapped_column(
        SAEnum(ClientPlan, name="client_plan", native_enum=False),
        default=ClientPlan.STARTER,
    )
    subscription_status: Mapped[SubscriptionStatus] = mapped_column(
        SAEnum(SubscriptionStatus, name="subscription_status", native_enum=False),
        default=SubscriptionStatus.PENDING,
        index=True,
    )
    status_detail: Mapped[str | None] = mapped_column(Text, default=None)

    # --- billing -------------------------------------------------------
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(64), index=True)

    # --- runtime -------------------------------------------------------
    image: Mapped[str] = mapped_column(String(300))
    container_id: Mapped[str | None] = mapped_column(String(64))
    container_name: Mapped[str | None] = mapped_column(String(128))
    #: Host ports published on the loopback interface, one per service the
    #: container supervises (dashboard on 9119, OpenAI-compatible API on 8642).
    container_port_dash: Mapped[int | None] = mapped_column(Integer, unique=True)
    container_port_api: Mapped[int | None] = mapped_column(Integer, unique=True)
    cpu_limit: Mapped[float] = mapped_column(Float, default=1.0)
    memory_limit: Mapped[str] = mapped_column(String(16), default="2g")
    database_name: Mapped[str | None] = mapped_column(String(80))
    internal_token: Mapped[str] = mapped_column(String(64))

    # --- tenant credentials --------------------------------------------
    #: Bearer token for the tenant's OpenAI-compatible endpoint, injected as
    #: ``API_SERVER_KEY``. Shaped ``sk-{subdomain}-...``.
    api_key: Mapped[str] = mapped_column(String(128), index=True)
    dashboard_username: Mapped[str] = mapped_column(String(64), default="admin")
    #: ``scrypt$n$r$p$<salt_b64>$<dk_b64>`` — the format the agent's bundled
    #: basic-auth provider verifies. The plaintext password is returned to the
    #: operator once at onboarding and is never stored anywhere.
    dashboard_password_hash: Mapped[str] = mapped_column(String(256), default="")
    #: Signing key for the dashboard's stateless session tokens. Without a
    #: stable value, every container restart invalidates all logins.
    dashboard_secret: Mapped[str] = mapped_column(String(128), default="")
    #: Last 4 characters of the tenant's OpenRouter key, for support triage.
    #: The key itself lives only in the tenant's 0600 .env on disk.
    openrouter_key_last4: Mapped[str | None] = mapped_column(String(8))

    # --- agent configuration -------------------------------------------
    #: Free-form per-client agent settings rendered into config.yaml.
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: Channel identifiers (phone numbers, page ids) used to route webhooks.
    channels: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    synced_skills: Mapped[list[str]] = mapped_column(JSON, default=list)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    provisioned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    audit_logs: Mapped[list["AuditLog"]] = relationship(
        back_populates="client",
        cascade="all, delete-orphan",
        order_by="AuditLog.timestamp.desc()",
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Client {self.slug} {self.subscription_status.value}>"


class AuditLog(Base):
    """Append-only audit trail: provisioning steps, billing, webhook routing."""

    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    action: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[AuditStatus] = mapped_column(
        SAEnum(AuditStatus, name="audit_status", native_enum=False),
        default=AuditStatus.STARTED,
        index=True,
    )
    message: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    client: Mapped[Client] = relationship(back_populates="audit_logs")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<AuditLog {self.action} {self.status.value}>"
