"""Weblaud: users and login codes, client business profile, and operations tables.

Revision ID: 0002_weblaud_operations
Revises: 0001_initial
Create Date: 2026-11-04
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_weblaud_operations"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _enum(name: str, *values: str) -> sa.Enum:
    # Member names, as the models store them. See the note in 0001.
    return sa.Enum(*values, name=name, native_enum=False)


_NOW = sa.text("now()")


def upgrade() -> None:
    # -- clients: existing rows take the defaults, and the package follows the plan.
    op.add_column(
        "clients",
        sa.Column("business_mode", _enum("business_mode", "GENERAL", "ECOMMERCE"), nullable=False, server_default="GENERAL"),
    )
    op.add_column(
        "clients",
        sa.Column(
            "niche_template",
            _enum("niche_template", "DENTAL_CLINIC", "BEAUTY_SALON", "RESTAURANT", "TRAVEL_AGENCY", "CLOTHING_ECOMMERCE", "CUSTOM"),
            nullable=False,
            server_default="CUSTOM",
        ),
    )
    op.add_column(
        "clients",
        sa.Column("package_tier", _enum("package_tier", "PRESENCE", "GROWTH", "SCALE"), nullable=False, server_default="PRESENCE"),
    )
    op.add_column(
        "clients",
        sa.Column("region_preset", _enum("region_preset", "BD", "GLOBAL"), nullable=False, server_default="GLOBAL"),
    )
    op.add_column("clients", sa.Column("currency", sa.String(length=3), nullable=False, server_default="USD"))
    op.add_column("clients", sa.Column("onboarding_stage", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("clients", sa.Column("baseline_metrics_json", sa.JSON(), nullable=True))
    op.add_column("clients", sa.Column("guardrails_json", sa.JSON(), nullable=False, server_default="{}"))
    op.execute("UPDATE clients SET package_tier = 'GROWTH' WHERE plan = 'GROWTH'")
    op.execute("UPDATE clients SET package_tier = 'SCALE' WHERE plan = 'SCALE'")
    # A tenant already running is past "Instance Live", whatever step it has
    # reached in a process that did not exist when it was provisioned.
    op.execute("UPDATE clients SET onboarding_stage = 5 WHERE subscription_status = 'ACTIVE'")

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("full_name", sa.String(length=200), nullable=False),
        sa.Column("phone", sa.String(length=20), nullable=True),
        sa.Column("password_hash", sa.String(length=256), nullable=True),
        sa.Column("role", _enum("user_role", "SUPER_ADMIN", "GROWTH_OPS", "SALES_OPS", "CLIENT_OWNER"), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("token_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_phone", "users", ["phone"], unique=True)
    op.create_index("ix_users_role", "users", ["role"])
    op.create_index("ix_users_client_id", "users", ["client_id"])

    op.create_table(
        "login_otps",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_login_otps_user_id", "login_otps", ["user_id"])

    op.create_table(
        "approval_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column(
            "kind",
            _enum("approval_kind", "SOCIAL_POST", "REEL", "AD_BOOST", "PARTNER_EMAIL", "WEBSITE_UPDATE", "COURIER_DISPATCH"),
            nullable=False,
        ),
        sa.Column(
            "status",
            _enum("approval_status", "QA_REVIEW", "QA_RETURNED", "PENDING_OWNER", "APPROVED", "CHANGES_REQUESTED", "REJECTED"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("preview", sa.JSON(), nullable=False),
        sa.Column("source_skill", sa.String(length=64), nullable=True),
        sa.Column("escalated", sa.Boolean(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.String(length=320), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_approval_items_client_id", "approval_items", ["client_id"])
    op.create_index("ix_approval_items_status", "approval_items", ["status"])
    op.create_index("ix_approval_items_created_at", "approval_items", ["created_at"])

    op.create_table(
        "roi_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("total_inquiries", sa.Integer(), nullable=False),
        sa.Column("qualified_leads", sa.Integer(), nullable=False),
        sa.Column("confirmed_outcomes", sa.Integer(), nullable=False),
        sa.Column("avg_order_or_profit_value", sa.Float(), nullable=True),
        sa.Column("ad_spend", sa.Float(), nullable=False),
        sa.Column("retainer", sa.Float(), nullable=True),
        sa.Column("entered_by", sa.String(length=320), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("client_id", "period", name="uq_roi_client_period"),
    )
    op.create_index("ix_roi_snapshots_client_id", "roi_snapshots", ["client_id"])
    op.create_index("ix_roi_snapshots_period", "roi_snapshots", ["period"])

    op.create_table(
        "workspace_records",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("kind", _enum("workspace_kind", "APPOINTMENT", "LEAD", "FOLLOW_UP", "ORDER", "STOCK_ALERT"), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workspace_records_client_id", "workspace_records", ["client_id"])
    op.create_index("ix_workspace_records_kind", "workspace_records", ["kind"])

    op.create_table(
        "prospects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("business_name", sa.String(length=200), nullable=False),
        sa.Column("contact_name", sa.String(length=200), nullable=True),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("niche", sa.String(length=64), nullable=True),
        sa.Column(
            "stage",
            _enum("prospect_stage", "NEW", "QUALIFIED", "CONTACTED", "VIDEO_AUDIT_SENT", "MEETING", "PROPOSAL", "WON"),
            nullable=False,
        ),
        sa.Column("no_website", sa.Boolean(), nullable=False),
        sa.Column("irregular_social", sa.Boolean(), nullable=False),
        sa.Column("slow_reply", sa.Boolean(), nullable=False),
        sa.Column("repeat_high_value_sales", sa.Boolean(), nullable=False),
        sa.Column("accessible_owner", sa.Boolean(), nullable=False),
        sa.Column("assignee", sa.String(length=32), nullable=True),
        sa.Column("audit_progress", _enum("audit_progress", "NOT_STARTED", "RECORDING", "SENT", "VIEWED"), nullable=False),
        sa.Column("audit_url", sa.String(length=500), nullable=True),
        sa.Column("next_follow_up", sa.String(length=10), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("onboarding_draft", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_prospects_stage", "prospects", ["stage"])
    op.create_index("ix_prospects_created_at", "prospects", ["created_at"])

    op.create_table(
        "standup_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("day", sa.String(length=10), nullable=False),
        sa.Column("member", sa.String(length=32), nullable=False),
        sa.Column("metric", sa.String(length=32), nullable=False),
        sa.Column("done", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("day", "member", "metric", name="uq_standup_day_metric"),
    )
    op.create_index("ix_standup_entries_day", "standup_entries", ["day"])

    op.create_table(
        "starter_kit_overrides",
        sa.Column("key", sa.String(length=32), nullable=False),
        sa.Column("data", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("starter_kit_overrides")
    op.drop_table("standup_entries")
    op.drop_table("prospects")
    op.drop_table("workspace_records")
    op.drop_table("roi_snapshots")
    op.drop_table("approval_items")
    op.drop_table("login_otps")
    op.drop_table("users")
    for column in (
        "guardrails_json",
        "baseline_metrics_json",
        "onboarding_stage",
        "currency",
        "region_preset",
        "package_tier",
        "niche_template",
        "business_mode",
    ):
        op.drop_column("clients", column)
