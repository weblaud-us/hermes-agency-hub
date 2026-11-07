"""Wire shapes for business setup, the catalog, channel credentials and usage.

Inbound models are strict (``extra="forbid"``) because every field lands in a file the
agent reads or on a line of its ``.env``. Outbound models never carry a secret: a stored
credential is reported as a mask and a ``configured`` flag, nothing more.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..clients.schemas import HEX_COLOR_PATTERN

BusinessModeName = Literal["general", "ecommerce"]
CatalogKind = Literal["product", "service"]
AiPresetKey = Literal["ultra_low_cost", "balanced", "premium_reasoning"]
IntegrationTarget = Literal["telegram", "whatsapp_cloud", "meta"]

MAX_FAQS = 40
MAX_CATALOG_ITEMS = 500


def _http_url(value: str | None) -> str | None:
    """Rendered as a link or fetched by a person's browser, so never a ``javascript:`` URL."""
    value = (value or "").strip()
    if not value:
        return None
    if not re.match(r"^https?://[^\s<>\"']+$", value, re.IGNORECASE):
        raise ValueError("must be a web address starting with http:// or https://")
    return value


# ------------------------------------------------------------------ business setup
class BrandKitSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary_color: str = Field(default="#00F5D4", pattern=HEX_COLOR_PATTERN)
    accent_color: str = Field(default="#6366F1", pattern=HEX_COLOR_PATTERN)
    #: Printed on every visual. Short, because the badge is small.
    logo_text: str = Field(default="", max_length=24)
    #: Stored for the business's own use. The hub never fetches it.
    logo_url: str | None = Field(default=None, max_length=300)
    default_cta: str = Field(default="Message us to book or order now", min_length=1, max_length=80)

    @field_validator("logo_url")
    @classmethod
    def _logo_url(cls, value: str | None) -> str | None:
        return _http_url(value)


class Faq(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=3, max_length=200)
    answer: str = Field(min_length=1, max_length=600)


class BusinessSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    company_name: str = Field(min_length=1, max_length=120)
    business_mode: BusinessModeName = "general"
    industry: str = Field(default="", max_length=120)
    tagline: str = Field(default="", max_length=160)
    website_url: str | None = Field(default=None, max_length=300)
    support_phone: str = Field(default="", max_length=40)
    business_hours: str = Field(default="", max_length=300)
    location_address: str = Field(default="", max_length=300)
    delivery_and_shipping_policy: str = Field(default="", max_length=600)
    return_and_refund_policy: str = Field(default="", max_length=600)
    tone_of_voice: str = Field(default="", max_length=300)
    brand_kit: BrandKitSetup = Field(default_factory=BrandKitSetup)
    faqs: list[Faq] = Field(default_factory=list, max_length=MAX_FAQS)

    @field_validator("website_url")
    @classmethod
    def _website(cls, value: str | None) -> str | None:
        return _http_url(value)

    @field_validator("support_phone")
    @classmethod
    def _phone(cls, value: str) -> str:
        value = value.strip()
        if value and not re.fullmatch(r"\+?[0-9][0-9 ()\-.]{4,38}", value):
            raise ValueError("enter a phone number such as +1 555 010 0199")
        return value


class BusinessSetupView(BusinessSetup):
    """The saved setup plus what the last save did to the agent's files."""

    #: ``None`` until the owner saves for the first time.
    updated_at: str | None = None
    #: Whether the agent's business memory carries this setup. A full memory drops the
    #: lowest-priority lines; the rest of the setup always reaches the persona file.
    memory_synced: bool = False
    memory_lines_skipped: int = 0


# ------------------------------------------------------------------------- catalog
class CatalogItemInput(BaseModel):
    """One product or service. Fields that do not apply to a kind are ignored."""

    model_config = ConfigDict(extra="forbid")

    kind: CatalogKind = "service"
    name: str = Field(min_length=1, max_length=120)
    price_usd: float = Field(ge=0, le=10_000_000)
    description: str = Field(default="", max_length=400)
    # products
    sku: str = Field(default="", max_length=64)
    sizes_or_variants: list[str] = Field(default_factory=list, max_length=30)
    stock_qty: int | None = Field(default=None, ge=0, le=10_000_000)
    image_url: str | None = Field(default=None, max_length=300)
    # services
    duration: str = Field(default="", max_length=60)
    booking_rules: str = Field(default="", max_length=300)

    @field_validator("image_url")
    @classmethod
    def _image_url(cls, value: str | None) -> str | None:
        return _http_url(value)

    @field_validator("sku")
    @classmethod
    def _sku(cls, value: str) -> str:
        value = value.strip()
        if value and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}", value):
            raise ValueError("use letters, numbers and - _ . / only")
        return value

    @field_validator("sizes_or_variants")
    @classmethod
    def _variants(cls, value: list[str]) -> list[str]:
        cleaned = [" ".join(item.split()) for item in value]
        if any(not item or len(item) > 40 for item in cleaned):
            raise ValueError("each size or variant must be 1 to 40 characters")
        return cleaned


class CatalogItem(CatalogItemInput):
    id: str


class CatalogImport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[CatalogItemInput] = Field(min_length=1, max_length=MAX_CATALOG_ITEMS)
    #: Replace the whole catalog, or add to it (matching SKUs and names are updated).
    replace: bool = False


class CatalogView(BaseModel):
    business_mode: BusinessModeName
    items: list[CatalogItem]
    updated_at: str | None = None
    limit: int = MAX_CATALOG_ITEMS


class CatalogImportResult(BaseModel):
    created: int
    updated: int
    catalog: CatalogView


# --------------------------------------------------------------------- integrations
class TelegramUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bot_token: str | None = Field(default=None, max_length=120)
    #: The owner's numeric Telegram ID. Replaces the approved list.
    allowed_users: list[str] | None = Field(default=None, max_length=20)


class WhatsAppCloudUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str | None = Field(default=None, max_length=700)
    phone_number_id: str | None = Field(default=None, max_length=30)
    verify_token: str | None = Field(default=None, max_length=80)


class MetaUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_id: str | None = Field(default=None, max_length=30)
    ig_user_id: str | None = Field(default=None, max_length=30)
    page_access_token: str | None = Field(default=None, max_length=700)


class IntegrationsUpdate(BaseModel):
    """Every section is optional. Within one, ``None`` leaves a value alone and an
    empty string removes it."""

    model_config = ConfigDict(extra="forbid")

    telegram: TelegramUpdate | None = None
    whatsapp_cloud: WhatsAppCloudUpdate | None = None
    meta: MetaUpdate | None = None
    ai_preset: AiPresetKey | None = None
    #: Restart the Coordinator afterwards so new credentials take effect.
    apply_now: bool = False


class SecretStatus(BaseModel):
    configured: bool
    #: ``••••1a2b``. Never the value.
    masked: str | None = None


class TelegramView(BaseModel):
    bot_token: SecretStatus
    allowed_users: list[str]


class WhatsAppView(BaseModel):
    #: ``cloud_api`` once all three Cloud API values are saved, ``qr`` when a phone is
    #: linked by QR, otherwise ``none``.
    mode: Literal["none", "qr", "cloud_api"]
    qr_linked: bool
    access_token: SecretStatus
    verify_token: SecretStatus
    phone_number_id: str | None


class MetaView(BaseModel):
    page_id: str | None
    ig_user_id: str | None
    page_access_token: SecretStatus
    #: Whether this business publishes to its own page. Without it posts are sandbox.
    publishes_live: bool


class AiPresetView(BaseModel):
    key: AiPresetKey
    label: str
    summary: str
    est_monthly_usd: str
    selected: bool
    #: Model and image engine names. Only sent to the agency team: the owner's portal
    #: never names a supplier.
    engines: dict[str, str] | None = None


class IntegrationsView(BaseModel):
    telegram: TelegramView
    whatsapp: WhatsAppView
    meta: MetaView
    presets: list[AiPresetView]
    preset_selected: bool


class IntegrationsSaveResult(BaseModel):
    integrations: IntegrationsView
    changed: list[str]
    #: ``applied`` when the Coordinator was restarted, ``pending`` when the new values
    #: wait for the next restart, ``unchanged`` when nothing needed it.
    restart: Literal["applied", "pending", "unchanged"]
    detail: str


class IntegrationTestResult(BaseModel):
    target: IntegrationTarget
    ok: bool
    detail: str


# ------------------------------------------------------------------------- usage
class UsagePricing(BaseModel):
    """USD per million tokens, per image and per reel, for one preset."""

    input_per_mtok: float
    output_per_mtok: float
    per_image: float
    per_reel: float


class UsageSummary(BaseModel):
    period: str
    preset: AiPresetKey
    preset_label: str
    #: False when the owner has not chosen one, so the figures use ``balanced``.
    preset_selected: bool
    #: ``None`` means the Coordinator does not record it, not zero.
    input_tokens: int | None
    output_tokens: int | None
    images_generated: int
    reels_generated: int | None
    cost_text_usd: float | None
    cost_images_usd: float
    cost_reels_usd: float | None
    cost_total_usd: float | None
    pricing: dict[str, UsagePricing]
    engines: dict[str, str] | None = None
    #: The calculator's starting point and the token sizes it assumes per message.
    calculator: dict[str, int]
    assumptions: list[str]
