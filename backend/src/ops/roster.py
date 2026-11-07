"""The specialist agents a business has, as the owner sees them.

Keys are short and stable on purpose. The skill directory names stay on this side of
the white-label boundary, in line with ``portal.sanitize``.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..clients.models import BusinessMode, Client
from ..clients.skills import skills_for_client
from ..config.settings import Settings


@dataclass(frozen=True)
class Specialist:
    key: str
    name: str
    role: str
    skill: str
    ecommerce_only: bool = False


ROSTER: tuple[Specialist, ...] = (
    Specialist("orchestrator", "AI Employee Orchestrator", "Front desk: routes every request, remembers the business, sends your daily summary.", "ai-employee-orchestrator"),
    Specialist("social", "Social Media Autopilot", "Plans, designs, publishes and answers comments, with nothing for you to do.", "social-media-autopilot"),
    Specialist("sales", "Sales Rep", "Answers WhatsApp, Messenger and Instagram enquiries day and night and captures bookings.", "sales-rep-inbox"),
    Specialist("designer", "Designer", "On-brand graphics, offer banners and story cards.", "designer-brand-studio"),
    Specialist("video", "Video Editor", "Short vertical reels with captions and shot guides.", "video-reel-editor"),
    Specialist("ads", "Ads Manager", "Proposes Meta and Google campaigns and watches cost per lead. You approve spend.", "ads-growth-manager"),
    Specialist("email", "Email Assistant", "Drafts partner, supplier and customer email for your approval.", "email-outreach-assistant"),
    Specialist("web", "Web Manager", "Keeps your site current, publishes local SEO articles, checks uptime.", "web-seo-manager"),
    Specialist("reporter", "Reporter", "Weekly funnel and ROI report, with what to do next.", "roi-weekly-reporter"),
    Specialist("order_desk", "Order Desk", "Turns messages into orders, confirms payment or COD, books couriers.", "order-desk-ecommerce", True),
    Specialist("catalog", "Catalog Keeper", "Keeps SKUs and stock accurate and warns before anything sells out.", "catalog-keeper-ecommerce", True),
)


def roster_for(mode: BusinessMode) -> list[Specialist]:
    return [s for s in ROSTER if mode is BusinessMode.ECOMMERCE or not s.ecommerce_only]


def active_skills(settings: Settings, client: Client) -> set[str]:
    """What the tenant actually has. A tenant not yet provisioned gets its entitlement."""
    if client.synced_skills:
        return set(client.synced_skills)
    return set(skills_for_client(settings, client.plan.value, client.business_mode.value))
