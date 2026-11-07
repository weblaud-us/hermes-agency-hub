"""Social autopilot: the client's brand kit and autopilot switch, posts and comments.

Also renames the e-commerce starter kit from ``clothing_ecommerce`` to
``ecommerce_store``, which is what Weblaud sells to any online store.

Revision ID: 0003_social_autopilot
Revises: 0002_weblaud_operations
Create Date: 2026-11-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_social_autopilot"
down_revision: Union[str, None] = "0002_weblaud_operations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NOW = sa.text("now()")


def upgrade() -> None:
    op.add_column(
        "clients",
        sa.Column("autopilot_social", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    # New clients start on the zero-touch autopilot. A client that already exists was
    # promised "the owner approves social posts" and keeps it until the owner says otherwise.
    op.execute("UPDATE clients SET autopilot_social = false")
    op.add_column("clients", sa.Column("brand_kit_json", sa.JSON(), nullable=True))

    op.execute("UPDATE clients SET niche_template = 'ECOMMERCE_STORE' WHERE niche_template = 'CLOTHING_ECOMMERCE'")
    op.execute("UPDATE prospects SET niche = 'ecommerce_store' WHERE niche = 'clothing_ecommerce'")
    op.execute("UPDATE starter_kit_overrides SET key = 'ecommerce_store' WHERE key = 'clothing_ecommerce'")

    op.create_table(
        "social_posts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("AWAITING_APPROVAL", "PUBLISHED", "FAILED", "REJECTED", name="social_post_status", native_enum=False),
            nullable=False,
        ),
        sa.Column("headline", sa.String(length=200), nullable=False),
        sa.Column("subtext", sa.String(length=200), nullable=False),
        sa.Column("caption", sa.Text(), nullable=False),
        sa.Column("hashtags", sa.JSON(), nullable=False),
        sa.Column("platforms", sa.JSON(), nullable=False),
        sa.Column("image_filename", sa.String(length=80), nullable=True),
        sa.Column("visual_engine", sa.String(length=48), nullable=True),
        sa.Column("publish_mode", sa.String(length=16), nullable=True),
        sa.Column("permalink", sa.String(length=500), nullable=True),
        sa.Column("external_id", sa.String(length=120), nullable=True),
        sa.Column("reach", sa.Integer(), nullable=True),
        sa.Column("approval_id", sa.Uuid(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("demo", sa.Boolean(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["approval_id"], ["approval_items.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_social_posts_client_id", "social_posts", ["client_id"])
    op.create_index("ix_social_posts_status", "social_posts", ["status"])
    op.create_index("ix_social_posts_created_at", "social_posts", ["created_at"])

    op.create_table(
        "social_comments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("post_id", sa.Uuid(), nullable=False),
        sa.Column("author", sa.String(length=120), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("public_reply", sa.Text(), nullable=False),
        sa.Column("handoff_skill", sa.String(length=64), nullable=True),
        sa.Column("dm_text", sa.Text(), nullable=False),
        sa.Column("reply_status", sa.String(length=24), nullable=False),
        sa.Column("sample", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["post_id"], ["social_posts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_social_comments_client_id", "social_comments", ["client_id"])
    op.create_index("ix_social_comments_post_id", "social_comments", ["post_id"])
    op.create_index("ix_social_comments_created_at", "social_comments", ["created_at"])


def downgrade() -> None:
    op.drop_table("social_comments")
    op.drop_table("social_posts")
    op.execute("UPDATE starter_kit_overrides SET key = 'clothing_ecommerce' WHERE key = 'ecommerce_store'")
    op.execute("UPDATE prospects SET niche = 'clothing_ecommerce' WHERE niche = 'ecommerce_store'")
    op.execute("UPDATE clients SET niche_template = 'CLOTHING_ECOMMERCE' WHERE niche_template = 'ECOMMERCE_STORE'")
    op.drop_column("clients", "brand_kit_json")
    op.drop_column("clients", "autopilot_social")
