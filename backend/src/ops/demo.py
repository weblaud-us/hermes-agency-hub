"""The demo tenant behind owner@suvana.com. Every figure here is invented.

Seeded on local installs only, and flagged ``demo_seed`` in the client's config so
the portal can say these are sample figures. Provisioning ``suvana`` for real
clears the samples; see ``clients.service._prepare_retry``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients import service as client_service
from ..clients.models import (
    BusinessMode,
    Client,
    ClientPlan,
    NicheTemplate,
    PackageTier,
    RegionPreset,
    SubscriptionStatus,
    ONBOARDING_AUTONOMOUS,
    ONBOARDING_SHADOW_WEEK,
)
from ..config.security import new_internal_token
from ..config.settings import Settings
from .models import (
    ApprovalItem,
    ApprovalKind,
    ApprovalStatus,
    AuditProgress,
    Prospect,
    ProspectStage,
    RoiSnapshot,
    SocialComment,
    SocialPost,
    SocialPostStatus,
    WorkspaceKind,
    WorkspaceRecord,
)
from .roi import current_period

DEMO_BASELINE = {
    "monthly_inquiries": 420,
    "conversion_rate": 8.0,
    "avg_order_or_profit_value": 650.0,
    "monthly_retainer_investment": 25000.0,
}


async def seed_demo_tenant(session: AsyncSession, settings: Settings) -> Client:
    existing = await client_service.get_by_slug(session, "suvana")
    if existing is not None:
        return existing

    client = Client(
        company_name="Suvana",
        slug="suvana",
        subdomain=settings.subdomain_for("suvana"),
        contact_email="owner@suvana.com",
        plan=ClientPlan.GROWTH,
        subscription_status=SubscriptionStatus.PENDING,
        status_detail="Demo tenant with sample figures. Not provisioned.",
        business_mode=BusinessMode.ECOMMERCE,
        niche_template=NicheTemplate.ECOMMERCE_STORE,
        package_tier=PackageTier.GROWTH,
        region_preset=RegionPreset.BD,
        currency="BDT",
        onboarding_stage=ONBOARDING_SHADOW_WEEK,
        baseline_metrics_json=dict(DEMO_BASELINE),
        guardrails_json={},
        image=settings.client_image,
        container_name=settings.container_name_for("suvana"),
        cpu_limit=settings.cpus_for("growth"),
        memory_limit=settings.memory_for("growth"),
        internal_token=new_internal_token(),
        api_key="",
        dashboard_password_hash="",
        dashboard_secret="",
        config={"demo_seed": True},
        channels={},
        synced_skills=[],
    )
    session.add(client)
    await session.flush()

    session.add(
        RoiSnapshot(
            client_id=client.id,
            period=current_period(),
            total_inquiries=610,
            qualified_leads=214,
            confirmed_outcomes=118,
            ad_spend=18000,
            entered_by="demo-seed",
        )
    )
    session.add_all(
        ApprovalItem(client_id=client.id, escalated=False, **fields)
        for fields in (
            {
                "kind": ApprovalKind.SOCIAL_POST,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "Eid collection carousel",
                "summary": "Five-slide carousel for the new panjabi line.",
                "preview": {"body": "নতুন ঈদ কালেকশন এসে গেছে। সীমিত স্টক, আজই অর্ডার করুন।", "channel": "instagram"},
                "source_skill": "social-media-autopilot",
            },
            {
                "kind": ApprovalKind.AD_BOOST,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "Boost best-seller reel",
                "summary": "Raise the daily budget while the reel is converting.",
                "preview": {"amount": 1500, "per": "day", "duration_days": 5},
                "source_skill": "ads-growth-manager",
            },
            {
                "kind": ApprovalKind.COURIER_DISPATCH,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "Dispatch 12 confirmed COD parcels",
                "summary": "All twelve customers confirmed by WhatsApp this morning.",
                "preview": {"courier": "Steadfast", "parcels": 12, "cod_total": 18450},
                "source_skill": "order-desk-ecommerce",
            },
            {
                "kind": ApprovalKind.REEL,
                "status": ApprovalStatus.QA_REVIEW,
                "title": "Behind the stitching reel",
                "summary": "First cut of the workshop reel, awaiting a QA pass.",
                "preview": {"body": "Hook: 'One panjabi, forty hours of hands.'", "duration_seconds": 28},
                "source_skill": "video-reel-editor",
            },
            {
                "kind": ApprovalKind.PARTNER_EMAIL,
                "status": ApprovalStatus.QA_REVIEW,
                "title": "Wholesale enquiry reply",
                "summary": "Draft reply to a boutique asking about bulk pricing.",
                "preview": {"body": "Thank you for reaching out. We would be glad to share our wholesale terms."},
                "source_skill": "email-outreach-assistant",
            },
        )
    )
    now = datetime.now(timezone.utc)
    session.add_all(
        WorkspaceRecord(client_id=client.id, **fields)
        for fields in (
            {
                "kind": WorkspaceKind.ORDER,
                "title": "Order #4821, navy panjabi (M)",
                "status": "awaiting_cod_confirmation",
                "detail": {"customer": "R. Hasan", "cod_amount": 1650, "courier": "Pathao"},
            },
            {
                "kind": WorkspaceKind.ORDER,
                "title": "Order #4817, cotton saree",
                "status": "in_transit",
                "detail": {"customer": "N. Akter", "cod_amount": 2450, "courier": "Steadfast", "tracking": "SF-20418837"},
            },
            {
                "kind": WorkspaceKind.ORDER,
                "title": "Order #4809, kids kurta set",
                "status": "delivered",
                "detail": {"customer": "T. Rahman", "cod_amount": 980, "courier": "RedX", "tracking": "RX-77120"},
            },
            {
                "kind": WorkspaceKind.STOCK_ALERT,
                "title": "Navy panjabi, size L",
                "status": "low",
                "detail": {"sku": "PNJ-NAVY-L", "stock": 3, "reorder_at": 10},
            },
            {
                "kind": WorkspaceKind.STOCK_ALERT,
                "title": "Cotton saree, olive",
                "status": "low",
                "detail": {"sku": "SAR-OLV", "stock": 1, "reorder_at": 5},
            },
            {
                "kind": WorkspaceKind.FOLLOW_UP,
                "title": "Boutique wholesale enquiry",
                "status": "open",
                "detail": {"contact": "M. Sultana"},
                "due_at": now + timedelta(days=1),
            },
        )
    )
    session.add_all(
        Prospect(**fields)
        for fields in (
            {
                "business_name": "Smile Care Dental",
                "niche": "dental_clinic",
                "stage": ProspectStage.VIDEO_AUDIT_SENT,
                "no_website": True,
                "slow_reply": True,
                "accessible_owner": True,
                "assignee": "sakib",
                "audit_progress": AuditProgress.SENT,
                "notes": "Sample prospect.",
            },
            {
                "business_name": "Glow Beauty Lounge",
                "niche": "beauty_salon",
                "stage": ProspectStage.QUALIFIED,
                "irregular_social": True,
                "repeat_high_value_sales": True,
                "accessible_owner": True,
                "assignee": "jubayed",
                "audit_progress": AuditProgress.NOT_STARTED,
                "notes": "Sample prospect.",
            },
            {
                "business_name": "Kacchi House",
                "niche": "restaurant",
                "stage": ProspectStage.NEW,
                "no_website": True,
                "irregular_social": True,
                "assignee": "jubayed",
                "audit_progress": AuditProgress.NOT_STARTED,
                "notes": "Sample prospect.",
            },
            {
                "business_name": "Nokshi Threads",
                "niche": "ecommerce_store",
                "stage": ProspectStage.PROPOSAL,
                "no_website": True,
                "irregular_social": True,
                "slow_reply": True,
                "repeat_high_value_sales": True,
                "accessible_owner": True,
                "assignee": "ishtiaq",
                "audit_progress": AuditProgress.VIEWED,
                "notes": "Sample prospect.",
            },
        )
    )
    _add_sample_social(session, client, handoff="order-desk-ecommerce", samples=SUVANA_SOCIAL)
    await session.flush()
    return client


async def clear_demo_rows(session: AsyncSession, client: Client) -> None:
    # Comments go with their posts (ON DELETE CASCADE), but say so rather than rely on it.
    for table in (SocialComment, SocialPost, ApprovalItem, RoiSnapshot, WorkspaceRecord):
        await session.execute(delete(table).where(table.client_id == client.id))
    client.baseline_metrics_json = None
    client.onboarding_stage = 1
    client.status_detail = None


# ---------------------------------------------------------------- social samples
SUVANA_SOCIAL = (
    {
        "headline": "New arrivals, just landed",
        "subtext": "Limited stock, order by message",
        "caption": "The new drop is here and the popular sizes go first. Message us the item and your size.",
        "hashtags": ["#newarrivals", "#shopsmall", "#ootd"],
        "reach": 4820,
        "comments": (
            ("Alex P.", "Do you have Size L in stock?",
             "Good question! We have just sent you a private message with the answer."),
            ("Imani C.", "Can I pay on delivery?",
             "Yes you can. We have sent you the details by private message."),
        ),
    },
    {
        "headline": "Back in stock: the one you asked for",
        "subtext": "Restocked today, selling fast",
        "caption": "You asked, we restocked. Send us a message with your size and we will hold one for you.",
        "hashtags": ["#restock", "#backinstock", "#shopnow"],
        "reach": 3110,
        "comments": (
            ("Jordan F.", "Is the navy one back in medium?",
             "It is! We have just sent you a private message to reserve yours."),
        ),
    },
)

APEX_SOCIAL = (
    {
        "headline": "Brighter smiles start here",
        "subtext": "Ask about our whitening package",
        "caption": "A confident smile changes everything. Message us to see this week's openings.",
        "hashtags": ["#dentist", "#teethwhitening", "#smile"],
        "reach": 2960,
        "comments": (
            ("Maya R.", "How much is the Teeth Whitening package?",
             "Thanks for asking! We have just sent you the details in a private message."),
            ("Daniel K.", "Do you have anything open on Saturday?",
             "Thanks for asking! We have just sent you the details in a private message."),
        ),
    },
    {
        "headline": "Fear of the dentist? Same.",
        "subtext": "Gentle check-ups, no pressure",
        "caption": "Most of our patients were nervous once. Book a gentle first visit by sending us a message.",
        "hashtags": ["#dentist", "#anxietyfree", "#checkup"],
        "reach": 1840,
        "comments": (
            ("Priya S.", "Do you take kids for first visits?",
             "We do! We have just sent you a private message with the next steps."),
        ),
    },
)


def _add_sample_social(
    session: AsyncSession, client: Client, *, handoff: str, samples: tuple[dict, ...]
) -> None:
    """Invented posts and conversations, flagged so the portal calls them samples."""
    now = datetime.now(timezone.utc)
    for index, sample in enumerate(samples):
        when = now - timedelta(days=index + 1, hours=3)
        post = SocialPost(
            id=uuid.uuid4(),
            client_id=client.id,
            status=SocialPostStatus.PUBLISHED,
            headline=sample["headline"],
            subtext=sample["subtext"],
            caption=sample["caption"],
            hashtags=list(sample["hashtags"]),
            platforms=["facebook", "instagram"],
            image_filename=None,
            visual_engine="studio_canvas_overlay",
            publish_mode="sandbox",
            reach=sample["reach"],
            demo=True,
            published_at=when,
            created_at=when,
        )
        session.add(post)
        for author, text, reply in sample["comments"]:
            session.add(
                SocialComment(
                    client_id=client.id,
                    post_id=post.id,
                    author=author,
                    text=text,
                    public_reply=reply,
                    handoff_skill=handoff,
                    dm_text="Hi! Thanks for your comment. Here is what you asked about. Reply and we will take it from there.",
                    reply_status="replied_simulated",
                    sample=True,
                    created_at=when + timedelta(minutes=4),
                )
            )


# --------------------------------------------------------------------- apex dental
APEX_BASELINE = {
    "monthly_inquiries": 50,
    "conversion_rate": 10.0,
    "avg_order_or_profit_value": 150.0,
    "monthly_retainer_investment": 599.0,
}
APEX_BRAND_KIT = {
    "primary_color": "#00F5D4",
    "accent_color": "#6366F1",
    "logo_text": "APEX DENTAL",
    "contact_cta": "Book via WhatsApp or DM",
    "website_url": None,
}


async def seed_apex_dental(session: AsyncSession, settings: Settings) -> Client:
    """A second demo business: a general-service dental clinic, already Autonomous Live."""
    existing = await client_service.get_by_slug(session, "apex-dental")
    if existing is not None:
        return existing

    client = Client(
        company_name="Apex Dental",
        slug="apex-dental",
        subdomain=settings.subdomain_for("apex-dental"),
        contact_email="owner@apex-dental.com",
        plan=ClientPlan.GROWTH,
        subscription_status=SubscriptionStatus.PENDING,
        status_detail="Demo tenant with sample figures. Not provisioned.",
        business_mode=BusinessMode.GENERAL,
        niche_template=NicheTemplate.DENTAL_CLINIC,
        package_tier=PackageTier.GROWTH,
        region_preset=RegionPreset.GLOBAL,
        currency="USD",
        onboarding_stage=ONBOARDING_AUTONOMOUS,
        autopilot_social=True,
        brand_kit_json=dict(APEX_BRAND_KIT),
        baseline_metrics_json=dict(APEX_BASELINE),
        guardrails_json={},
        image=settings.client_image,
        container_name=settings.container_name_for("apex-dental"),
        cpu_limit=settings.cpus_for("growth"),
        memory_limit=settings.memory_for("growth"),
        internal_token=new_internal_token(),
        api_key="",
        dashboard_password_hash="",
        dashboard_secret="",
        config={"demo_seed": True},
        channels={},
        synced_skills=[],
    )
    session.add(client)
    await session.flush()

    session.add(
        RoiSnapshot(
            client_id=client.id,
            period=current_period(),
            total_inquiries=140,
            qualified_leads=82,
            confirmed_outcomes=31,
            ad_spend=250,
            entered_by="demo-seed",
        )
    )
    session.add_all(
        ApprovalItem(client_id=client.id, escalated=False, **fields)
        for fields in (
            {
                "kind": ApprovalKind.AD_BOOST,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "Raise whitening campaign budget",
                "summary": "Cost per lead is 38% under target. Add budget while it holds.",
                "preview": {"amount": 20, "per": "day", "duration_days": 7},
                "source_skill": "ads-growth-manager",
            },
            {
                "kind": ApprovalKind.DISCOUNT_OFFER,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "New-patient whitening offer",
                "summary": "A limited offer for first-time patients, to fill quiet weekday slots.",
                "preview": {"body": "10% off whitening for new patients who book before the end of the month."},
                "source_skill": "sales-rep-inbox",
            },
            {
                "kind": ApprovalKind.PARTNER_EMAIL,
                "status": ApprovalStatus.PENDING_OWNER,
                "title": "Reply to dental supplier quote",
                "summary": "Draft reply accepting the revised whitening kit pricing.",
                "preview": {"body": "Thank you for the revised quote. We are happy to proceed on those terms."},
                "source_skill": "email-outreach-assistant",
            },
        )
    )
    now = datetime.now(timezone.utc)
    session.add_all(
        WorkspaceRecord(client_id=client.id, **fields)
        for fields in (
            {
                "kind": WorkspaceKind.APPOINTMENT,
                "title": "Whitening consult, Maya R.",
                "status": "confirmed",
                "detail": {"channel": "instagram"},
                "due_at": now + timedelta(days=1, hours=2),
            },
            {
                "kind": WorkspaceKind.LEAD,
                "title": "Check-up enquiry, Priya S.",
                "status": "qualified",
                "detail": {"channel": "facebook"},
            },
            {
                "kind": WorkspaceKind.FOLLOW_UP,
                "title": "Re-engage Daniel K. about Saturday",
                "status": "open",
                "detail": {"channel": "instagram"},
                "due_at": now + timedelta(hours=20),
            },
        )
    )
    _add_sample_social(session, client, handoff="sales-rep-inbox", samples=APEX_SOCIAL)
    await session.flush()
    return client


async def seed_demo_tenants(session: AsyncSession, settings: Settings) -> dict[str, Client]:
    """Every demo business, keyed by slug."""
    suvana = await seed_demo_tenant(session, settings)
    apex = await seed_apex_dental(session, settings)
    return {suvana.slug: suvana, apex.slug: apex}
