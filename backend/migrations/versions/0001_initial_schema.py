"""Initial schema: clients and audit_logs.

Revision ID: 0001_initial
Revises:
Create Date: 2026-11-02
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Enums are stored as VARCHAR with a CHECK constraint (native_enum=False in
# the models) rather than as Postgres ENUM types. Adding a value to a native
# ENUM requires ALTER TYPE and cannot run inside a transaction on older
# servers; a VARCHAR + CHECK is a plain constraint swap.
_SUBSCRIPTION_STATUS = sa.Enum(
    "pending", "provisioning", "active", "suspended", "failed", "archived",
    name="subscription_status", native_enum=False,
)
_CLIENT_PLAN = sa.Enum(
    "starter", "growth", "scale", name="client_plan", native_enum=False
)
_AUDIT_STATUS = sa.Enum(
    "started", "succeeded", "failed", name="audit_status", native_enum=False
)


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_name", sa.String(length=200), nullable=False),
        sa.Column("slug", sa.String(length=63), nullable=False),
        sa.Column("subdomain", sa.String(length=255), nullable=False),
        sa.Column("contact_email", sa.String(length=320), nullable=False),
        sa.Column("plan", _CLIENT_PLAN, nullable=False),
        sa.Column("subscription_status", _SUBSCRIPTION_STATUS, nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("stripe_customer_id", sa.String(length=64), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(length=64), nullable=True),
        sa.Column("image", sa.String(length=300), nullable=False),
        sa.Column("container_id", sa.String(length=64), nullable=True),
        sa.Column("container_name", sa.String(length=128), nullable=True),
        sa.Column("container_port_dash", sa.Integer(), nullable=True),
        sa.Column("container_port_api", sa.Integer(), nullable=True),
        sa.Column("cpu_limit", sa.Float(), nullable=False),
        sa.Column("memory_limit", sa.String(length=16), nullable=False),
        sa.Column("database_name", sa.String(length=80), nullable=True),
        sa.Column("internal_token", sa.String(length=64), nullable=False),
        sa.Column("api_key", sa.String(length=128), nullable=False),
        sa.Column("dashboard_username", sa.String(length=64), nullable=False),
        sa.Column("dashboard_password_hash", sa.String(length=256), nullable=False),
        sa.Column("dashboard_secret", sa.String(length=128), nullable=False),
        sa.Column("openrouter_key_last4", sa.String(length=8), nullable=True),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("channels", sa.JSON(), nullable=False),
        sa.Column("synced_skills", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("provisioned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # A host port may only be handed to one tenant. The allocator checks
        # Docker and the database before choosing, but the constraint is what
        # makes a race impossible rather than merely unlikely.
        sa.UniqueConstraint("container_port_dash", name="uq_clients_port_dash"),
        sa.UniqueConstraint("container_port_api", name="uq_clients_port_api"),
    )
    op.create_index("ix_clients_slug", "clients", ["slug"], unique=True)
    op.create_index("ix_clients_subdomain", "clients", ["subdomain"], unique=True)
    op.create_index(
        "ix_clients_subscription_status", "clients", ["subscription_status"]
    )
    op.create_index("ix_clients_api_key", "clients", ["api_key"])
    op.create_index(
        "ix_clients_stripe_customer_id", "clients", ["stripe_customer_id"]
    )
    op.create_index(
        "ix_clients_stripe_subscription_id", "clients", ["stripe_subscription_id"]
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("status", _AUDIT_STATUS, nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "timestamp",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_logs_client_id", "audit_logs", ["client_id"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_status", "audit_logs", ["status"])
    op.create_index("ix_audit_logs_timestamp", "audit_logs", ["timestamp"])


def downgrade() -> None:
    op.drop_table("audit_logs")
    op.drop_table("clients")
