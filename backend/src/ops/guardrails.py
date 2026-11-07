"""The three lanes: what the agent may do alone, with a tap, or never.

The catalog is code rather than data because "never automatic" has to mean never:
no override stored on a client can move an item that is not ``promotable``, and
``set_lane`` is the only writer of those overrides.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ..clients.models import BusinessMode, Client
from .models import ApprovalKind

Lane = Literal["automatic", "owner", "never"]


@dataclass(frozen=True)
class GuardrailItem:
    key: str
    label: str
    lane: Lane
    #: Whether the owner may move this between "owner" and "automatic".
    promotable: bool = False
    mode: BusinessMode | None = None
    kind: ApprovalKind | None = None


CATALOG: tuple[GuardrailItem, ...] = (
    # Automatic: answers and bookkeeping that commit the business to nothing new.
    GuardrailItem("faq_replies", "Answer common questions", "automatic"),
    GuardrailItem("lead_capture", "Capture and qualify new leads", "automatic"),
    GuardrailItem("appointment_reminders", "Send appointment reminders", "automatic", mode=BusinessMode.GENERAL),
    GuardrailItem("order_status_replies", "Reply with order status", "automatic", mode=BusinessMode.ECOMMERCE),
    GuardrailItem("stock_sync", "Sync stock and SKU counts", "automatic", mode=BusinessMode.ECOMMERCE),
    GuardrailItem("weekly_report", "Send the weekly report", "automatic"),
    # Owner approves: goes out under the business's name, so a person looks first.
    GuardrailItem("social_posts", "Publish social posts", "owner", promotable=True, kind=ApprovalKind.SOCIAL_POST),
    GuardrailItem("reels", "Publish reels", "owner", promotable=True, kind=ApprovalKind.REEL),
    GuardrailItem("partner_emails", "Send partner emails", "owner", promotable=True, kind=ApprovalKind.PARTNER_EMAIL),
    GuardrailItem("website_updates", "Update website packages", "owner", promotable=True, kind=ApprovalKind.WEBSITE_UPDATE),
    GuardrailItem(
        "courier_dispatch", "Book courier parcels", "owner", promotable=True,
        mode=BusinessMode.ECOMMERCE, kind=ApprovalKind.COURIER_DISPATCH,
    ),
    # Spends money, so it keeps a person in the loop however routine it gets.
    GuardrailItem("ad_boosts", "Raise ad budgets", "owner", kind=ApprovalKind.AD_BOOST),
    # Commits the business to a price a customer will hold it to. Always the owner's call.
    GuardrailItem("discount_offers", "Send discount offers to customers", "owner", kind=ApprovalKind.DISCOUNT_OFFER),
    # Never automatic: money, legal exposure, or something that cannot be undone.
    GuardrailItem("refunds", "Issue refunds", "never"),
    GuardrailItem("price_changes", "Change list prices", "never"),
    GuardrailItem("legal_commitments", "Sign contracts or make legal commitments", "never"),
    GuardrailItem("payment_settings", "Change payment or payout details", "never"),
    GuardrailItem("customer_data_export", "Share or export customer data", "never"),
)
_BY_KEY = {item.key: item for item in CATALOG}
_BY_KIND = {item.kind: item for item in CATALOG if item.kind is not None}


class GuardrailNotFoundError(LookupError):
    pass


class GuardrailLockedError(ValueError):
    pass


#: The one lane that is a client setting in its own right: ``Client.autopilot_social``.
#: On is the zero-touch autopilot, off is one-tap approval. Reading the flag here, and
#: writing it in ``set_lane``, keeps the toggle and the lane from ever disagreeing.
SOCIAL_LANE_KEY = "social_posts"


def lane_of(client: Client, item: GuardrailItem) -> Lane:
    if not item.promotable:
        return item.lane
    if item.key == SOCIAL_LANE_KEY:
        return "automatic" if getattr(client, "autopilot_social", True) else "owner"
    override = (getattr(client, "guardrails_json", None) or {}).get(item.key)
    return override if override in {"automatic", "owner"} else item.lane


def lane_for_kind(client: Client, kind: ApprovalKind) -> Lane:
    item = _BY_KIND.get(kind)
    # An unmapped kind is treated as the safest thing it could be.
    return lane_of(client, item) if item else "owner"


def lanes_for(client: Client) -> list[dict[str, Any]]:
    """Every item that applies to this client's business model, with its lane."""
    return [
        {
            "key": item.key,
            "label": item.label,
            "lane": lane_of(client, item),
            "default_lane": item.lane,
            "promotable": item.promotable,
        }
        for item in CATALOG
        if item.mode is None or item.mode == client.business_mode
    ]


def set_lane(client: Client, key: str, lane: Literal["automatic", "owner"]) -> None:
    item = _BY_KEY.get(key)
    if item is None or (item.mode is not None and item.mode != client.business_mode):
        raise GuardrailNotFoundError(key)
    if not item.promotable:
        raise GuardrailLockedError(key)
    if key == SOCIAL_LANE_KEY:
        client.autopilot_social = lane == "automatic"
        return
    # Reassigned because SQLAlchemy cannot see in-place changes to a JSON column.
    client.guardrails_json = {**(client.guardrails_json or {}), key: lane}
