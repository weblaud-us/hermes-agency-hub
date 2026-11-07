"""Channel credentials, the AI preset, connection tests and the monthly usage estimate.

Credentials live in the tenant's ``.env`` and nowhere else: the hub's database never
holds one, and no response carries one. A stored secret is reported as a mask and a
``configured`` flag. Every value is held to a strict pattern before it is written
because it lands on a line of ``.env``, and a newline in it would let a caller set any
variable in the tenant's environment.

The blocking parts run through ``asyncio.to_thread``; the connection tests are async.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
import yaml
from fastapi import status

from ..clients.models import Client
from . import readers, tenant_api
from .errors import PortalError
from .knowledge_schemas import (
    AiPresetView,
    IntegrationsUpdate,
    IntegrationsView,
    IntegrationTarget,
    IntegrationTestResult,
    MetaView,
    SecretStatus,
    TelegramView,
    UsagePricing,
    UsageSummary,
    WhatsAppView,
)
from .tenant_files import TenantFiles

logger = logging.getLogger(__name__)

GRAPH_API = "https://graph.facebook.com/v21.0"

ENV_TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN"
ENV_TELEGRAM_USERS = "TELEGRAM_ALLOWED_USERS"
ENV_WA_TOKEN = "WHATSAPP_ACCESS_TOKEN"
ENV_WA_PHONE_ID = "WHATSAPP_PHONE_NUMBER_ID"
ENV_WA_VERIFY = "WHATSAPP_VERIFY_TOKEN"
ENV_META_PAGE = "META_PAGE_ID"
ENV_META_IG = "META_IG_USER_ID"
ENV_META_TOKEN = "META_PAGE_ACCESS_TOKEN"

_TELEGRAM_TOKEN = re.compile(r"\d{6,12}:[A-Za-z0-9_-]{30,50}")
_TELEGRAM_ID = re.compile(r"[0-9]{5,20}")
_GRAPH_TOKEN = re.compile(r"[A-Za-z0-9_.-]{20,700}")
_NUMERIC_ID = re.compile(r"[0-9]{5,25}")
_PHONE_NUMBER_ID = re.compile(r"[0-9]{8,20}")
_VERIFY_TOKEN = re.compile(r"[A-Za-z0-9_-]{8,64}")


# ==================================================================== AI presets
@dataclass(frozen=True)
class AiPreset:
    key: str
    label: str
    summary: str
    #: The model the Coordinator is pointed at. Never sent to the owner.
    model: str
    image_engine: str
    video_engine: str
    pricing: UsagePricing


#: A reel is a short slideshow of this many generated frames, stitched by FFmpeg at no charge.
FRAMES_PER_REEL = 4


def _pricing(input_per_mtok: float, output_per_mtok: float, per_image: float) -> UsagePricing:
    return UsagePricing(
        input_per_mtok=input_per_mtok,
        output_per_mtok=output_per_mtok,
        per_image=per_image,
        per_reel=round(FRAMES_PER_REEL * per_image, 4),
    )


#: US dollars, list prices at the time of writing. Providers change them, so every figure
#: here is an estimate and is labelled as one wherever it is shown.
PRESETS: tuple[AiPreset, ...] = (
    AiPreset(
        "ultra_low_cost",
        "Ultra low cost",
        "Quick, economical replies and simple branded visuals. Best for steady, everyday volume.",
        "deepseek/deepseek-chat",
        "flux-schnell",
        "FFmpeg slideshow",
        _pricing(0.27, 1.10, 0.003),
    ),
    AiPreset(
        "balanced",
        "Balanced",
        "Stronger writing and instruction following at a modest price. The sensible default.",
        "openai/gpt-4o-mini",
        "gpt-image-1",
        "FFmpeg slideshow",
        _pricing(0.15, 0.60, 0.04),
    ),
    AiPreset(
        "premium_reasoning",
        "Premium reasoning",
        "The most careful answers for complicated sales and support conversations.",
        "anthropic/claude-3.5-sonnet",
        "flux-pro",
        "FFmpeg slideshow",
        _pricing(3.00, 15.00, 0.05),
    ),
)
PRESET_BY_KEY = {preset.key: preset for preset in PRESETS}
DEFAULT_PRESET = "balanced"

#: One typical month for a small business, used for the "about $X a month" label and as
#: the calculator's starting point.
TYPICAL = {
    "messages_per_day": 40,
    "image_posts_per_month": 12,
    "reels_per_month": 4,
    "input_tokens_per_message": 1500,
    "output_tokens_per_message": 400,
}


def estimate_month(pricing: UsagePricing, scenario: dict[str, int] = TYPICAL) -> float:
    messages = scenario["messages_per_day"] * 30
    text = (
        messages * scenario["input_tokens_per_message"] / 1_000_000 * pricing.input_per_mtok
        + messages * scenario["output_tokens_per_message"] / 1_000_000 * pricing.output_per_mtok
    )
    return (
        text
        + scenario["image_posts_per_month"] * pricing.per_image
        + scenario["reels_per_month"] * pricing.per_reel
    )


def preset_of(client: Client) -> tuple[AiPreset, bool]:
    """The tenant's preset, and whether the owner actually chose one."""
    chosen = (client.config or {}).get("ai_preset")
    if isinstance(chosen, str) and chosen in PRESET_BY_KEY:
        return PRESET_BY_KEY[chosen], True
    return PRESET_BY_KEY[DEFAULT_PRESET], False


# ======================================================================== masking
def mask_secret(value: str | None) -> SecretStatus:
    if not value:
        return SecretStatus(configured=False)
    return SecretStatus(configured=True, masked=f"••••{value[-4:]}" if len(value) >= 12 else "••••")


# ======================================================================= the view
def _whatsapp_mode(env: dict[str, str], qr_linked: bool) -> str:
    if env.get(ENV_WA_TOKEN) and env.get(ENV_WA_PHONE_ID) and env.get(ENV_WA_VERIFY):
        return "cloud_api"
    return "qr" if qr_linked else "none"


def meta_values(env: dict[str, str]) -> tuple[str, str, str]:
    return env.get(ENV_META_PAGE, ""), env.get(ENV_META_TOKEN, ""), env.get(ENV_META_IG, "")


def build_view(files: TenantFiles, client: Client, *, staff: bool) -> IntegrationsView:
    env = readers.read_env(files)
    page_id, page_token, ig_id = meta_values(env)
    qr_linked = readers.whatsapp_is_linked(files)
    selected, chosen = preset_of(client)
    return IntegrationsView(
        telegram=TelegramView(
            bot_token=mask_secret(env.get(ENV_TELEGRAM_TOKEN)),
            allowed_users=readers._split_allowlist(env.get(ENV_TELEGRAM_USERS)),
        ),
        whatsapp=WhatsAppView(
            mode=_whatsapp_mode(env, qr_linked),  # type: ignore[arg-type]
            qr_linked=qr_linked,
            access_token=mask_secret(env.get(ENV_WA_TOKEN)),
            verify_token=mask_secret(env.get(ENV_WA_VERIFY)),
            phone_number_id=env.get(ENV_WA_PHONE_ID) or None,
        ),
        meta=MetaView(
            page_id=page_id or None,
            ig_user_id=ig_id or None,
            page_access_token=mask_secret(page_token),
            publishes_live=bool(page_id and page_token),
        ),
        presets=[
            AiPresetView(
                key=preset.key,  # type: ignore[arg-type]
                label=preset.label,
                summary=preset.summary,
                est_monthly_usd=f"about ${estimate_month(preset.pricing):.0f} a month",
                selected=preset.key == selected.key and chosen,
                engines=(
                    {"model": preset.model, "images": preset.image_engine, "video": preset.video_engine}
                    if staff
                    else None
                ),
            )
            for preset in PRESETS
        ],
        preset_selected=chosen,
    )


# ======================================================================= the save
def _invalid(detail: str) -> PortalError:
    return PortalError(422, "integration_invalid", detail)


def _checked(value: str, pattern: re.Pattern[str], detail: str) -> str:
    value = value.strip()
    if not pattern.fullmatch(value):
        raise _invalid(detail)
    return value


def plan_env_changes(payload: IntegrationsUpdate, env: dict[str, str]) -> tuple[dict[str, str | None], list[str]]:
    """The ``.env`` edits a payload asks for, validated, plus a plain-English list of
    what is changing. ``None`` as a value removes the line."""
    updates: dict[str, str | None] = {}
    changed: list[str] = []

    def put(key: str, raw: str | None, pattern: re.Pattern[str], label: str, hint: str) -> None:
        if raw is None:
            return
        raw = raw.strip()
        updates[key] = _checked(raw, pattern, hint) if raw else None
        changed.append(label)

    if payload.telegram is not None:
        telegram = payload.telegram
        put(
            ENV_TELEGRAM_TOKEN, telegram.bot_token, _TELEGRAM_TOKEN, "Telegram bot token",
            "That does not look like a Telegram bot token. Copy the whole token from BotFather.",
        )
        if telegram.allowed_users is not None:
            current = readers._split_allowlist(env.get(ENV_TELEGRAM_USERS))
            if "*" in current:
                raise PortalError(
                    status.HTTP_409_CONFLICT,
                    "allowlist_open",
                    "This channel currently answers everyone. Ask your account manager to "
                    "restrict it before managing an approved list.",
                )
            ids = list(
                dict.fromkeys(
                    _checked(item, _TELEGRAM_ID, "A Telegram ID is a number of 5 to 20 digits.")
                    for item in telegram.allowed_users
                )
            )
            if not ids:
                # An empty list could mean "nobody" or "everybody" to the agent.
                raise _invalid("Add at least one Telegram ID, or leave this field unchanged.")
            updates[ENV_TELEGRAM_USERS] = ",".join(ids)
            changed.append("Telegram approved users")

    if payload.whatsapp_cloud is not None:
        cloud = payload.whatsapp_cloud
        put(ENV_WA_TOKEN, cloud.access_token, _GRAPH_TOKEN, "WhatsApp access token",
            "That does not look like a WhatsApp access token.")
        put(ENV_WA_PHONE_ID, cloud.phone_number_id, _PHONE_NUMBER_ID, "WhatsApp phone number ID",
            "The phone number ID is 8 to 20 digits, shown in the Meta developer dashboard.")
        put(ENV_WA_VERIFY, cloud.verify_token, _VERIFY_TOKEN, "WhatsApp verify token",
            "The verify token is 8 to 64 letters, numbers, dashes or underscores.")

    if payload.meta is not None:
        meta = payload.meta
        put(ENV_META_PAGE, meta.page_id, _NUMERIC_ID, "Facebook Page ID",
            "The Page ID is a number of 5 to 25 digits.")
        put(ENV_META_IG, meta.ig_user_id, _NUMERIC_ID, "Instagram account ID",
            "The Instagram account ID is a number of 5 to 25 digits.")
        put(ENV_META_TOKEN, meta.page_access_token, _GRAPH_TOKEN, "Page access token",
            "That does not look like a Page access token.")
    return updates, changed


def write_env_values(files: TenantFiles, updates: dict[str, str | None]) -> None:
    """Apply several ``.env`` edits in one locked write, keeping every other line byte for byte."""
    if not updates:
        return
    with files.locked(".env"):
        text = files.read_text(".env")
        if text is None:
            raise PortalError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "portal_data_unavailable",
                "This setting cannot be changed right now. Please try again shortly.",
            )
        for key, value in updates.items():
            pattern = re.compile(rf"^{re.escape(key)}=.*(?:\r?\n|$)", re.MULTILINE)
            if value is None:
                text = pattern.sub("", text)
                continue
            line = f"{key}={value}"
            if pattern.search(text):
                text = pattern.sub(lambda _: line + "\n", text, count=1)
            else:
                text += ("" if text.endswith("\n") or not text else "\n") + line + "\n"
        files.write_atomic(text, ".env")


def write_model_config(files: TenantFiles, preset: AiPreset) -> None:
    """Point ``config.yaml`` at the preset's model, keeping the rest of the file."""
    with files.locked("config.yaml"):
        raw = files.read_text("config.yaml") or ""
        try:
            config = yaml.safe_load(raw) if raw else {}
        except yaml.YAMLError as exc:
            raise PortalError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "portal_data_unavailable",
                "This setting cannot be changed right now. Please try again shortly.",
            ) from exc
        config = config if isinstance(config, dict) else {}
        section = config.get("model")
        if isinstance(section, dict):
            section = dict(section)
        elif isinstance(section, str) and section:
            section = {"default": section}
        else:
            section = {}
        section["default"] = preset.model
        section.setdefault("provider", "openrouter")
        config["model"] = section
        files.write_atomic(
            readers._leading_comments(raw) + yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
            "config.yaml",
        )


def record_channels(client: Client, env: dict[str, str]) -> None:
    """Mark a channel as set up so the portal reports it as *disconnected* until it comes
    up, rather than *not configured*. Reassigned because SQLAlchemy cannot see in-place
    changes to a JSON column."""
    recorded = dict(client.channels) if isinstance(client.channels, dict) else {}
    if env.get(ENV_TELEGRAM_TOKEN):
        recorded.setdefault("telegram", {"configured": True})
    else:
        recorded.pop("telegram", None)
    if _whatsapp_mode(env, False) == "cloud_api":
        recorded.setdefault("whatsapp", {"configured": True})
    client.channels = recorded


# ================================================================ connection tests
async def _get(url: str, *, token: str | None = None, params: dict[str, str] | None = None) -> httpx.Response | None:
    headers = {"Authorization": f"Bearer {token}"} if token else None
    try:
        async with httpx.AsyncClient(timeout=10.0, transport=tenant_api._transport) as http:
            return await http.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        # httpx puts the request URL in its error text, and a Telegram URL holds the token.
        logger.warning("Integration test could not connect: %s", type(exc).__name__)
        return None


async def probe_integration(target: IntegrationTarget, env: dict[str, str]) -> IntegrationTestResult:
    def result(ok: bool, detail: str) -> IntegrationTestResult:
        return IntegrationTestResult(target=target, ok=ok, detail=detail)

    unreachable = "We could not reach the service to check. Please try again in a moment."

    if target == "telegram":
        token = env.get(ENV_TELEGRAM_TOKEN)
        if not token:
            return result(False, "Save your bot token first.")
        response = await _get(f"{tenant_api.TELEGRAM_API}/bot{token}/getMe")
        if response is None:
            return result(False, unreachable)
        body = _json(response)
        if response.status_code == 200 and body.get("ok") is True:
            name = (body.get("result") or {}).get("username")
            return result(True, f"Telegram accepted the token for @{name}." if name else "Telegram accepted the token.")
        return result(False, "Telegram did not accept this token. Copy it again from BotFather.")

    if target == "whatsapp_cloud":
        token, phone_id = env.get(ENV_WA_TOKEN), env.get(ENV_WA_PHONE_ID)
        if not (token and phone_id and env.get(ENV_WA_VERIFY)):
            return result(False, "Save the access token, phone number ID and verify token first.")
        response = await _get(
            f"{GRAPH_API}/{phone_id}", token=token, params={"fields": "display_phone_number,verified_name"}
        )
        if response is None:
            return result(False, unreachable)
        if response.status_code == 200:
            number = _json(response).get("display_phone_number")
            return result(True, f"WhatsApp Cloud API accepted these credentials for {number}." if number
                          else "WhatsApp Cloud API accepted these credentials.")
        return result(False, "WhatsApp did not accept these credentials. Check the token and phone number ID.")

    page_id, token, ig_id = meta_values(env)
    if not (page_id and token):
        return result(False, "Save the Page ID and Page access token first.")
    page = await _get(f"{GRAPH_API}/{page_id}", token=token, params={"fields": "name"})
    if page is None:
        return result(False, unreachable)
    if page.status_code != 200:
        return result(False, "Facebook did not accept these credentials. Check the Page ID and token.")
    name = _json(page).get("name")
    if ig_id:
        instagram = await _get(f"{GRAPH_API}/{ig_id}", token=token, params={"fields": "username"})
        if instagram is None:
            return result(False, unreachable)
        if instagram.status_code != 200:
            return result(
                False,
                "The Facebook Page is connected, but Instagram did not accept the account ID or token.",
            )
        return result(True, f"Connected to the Facebook Page {name} and its Instagram account." if name
                      else "Connected to the Facebook Page and its Instagram account.")
    return result(True, f"Connected to the Facebook Page {name}." if name else "Connected to the Facebook Page.")


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


# ====================================================================== usage
def month_start(now: datetime | None = None) -> datetime:
    current = now or datetime.now(timezone.utc)
    return current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def read_token_usage(files: TenantFiles, since: datetime) -> tuple[int | None, int | None]:
    """Tokens the Coordinator spent since ``since``, from its own session database.

    ``(None, None)`` when the database or its token columns are absent: the portal shows
    that as "not recorded" rather than as zero.
    """
    with files.readonly_uri("state.db") as uri:
        if uri is None:
            return None, None
        try:
            connection = sqlite3.connect(uri, uri=True, timeout=1.0)
        except (OSError, sqlite3.Error, ValueError):
            return None, None
        try:
            connection.execute("PRAGMA query_only = ON")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
            if not {"input_tokens", "output_tokens", "started_at"} <= columns:
                return None, None
            row = connection.execute(
                "SELECT SUM(input_tokens), SUM(output_tokens) FROM sessions WHERE started_at >= ?",
                (since.timestamp(),),
            ).fetchone()
            return int((row or (0, 0))[0] or 0), int((row or (0, 0))[1] or 0)
        except sqlite3.Error as exc:
            logger.warning("Could not read token usage for %s: %s", files.root.name, exc)
            return None, None
        finally:
            connection.close()


def build_usage(
    client: Client,
    *,
    tokens: tuple[int | None, int | None],
    images: int,
    staff: bool,
    now: datetime | None = None,
) -> UsageSummary:
    preset, chosen = preset_of(client)
    pricing = preset.pricing
    input_tokens, output_tokens = tokens
    text_cost = (
        round(input_tokens / 1_000_000 * pricing.input_per_mtok + output_tokens / 1_000_000 * pricing.output_per_mtok, 4)
        if input_tokens is not None and output_tokens is not None
        else None
    )
    image_cost = round(images * pricing.per_image, 4)
    return UsageSummary(
        period=month_start(now).strftime("%Y-%m"),
        preset=preset.key,  # type: ignore[arg-type]
        preset_label=preset.label,
        preset_selected=chosen,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        images_generated=images,
        # Nothing records a finished reel yet, so this is unknown rather than zero.
        reels_generated=None,
        cost_text_usd=text_cost,
        cost_images_usd=image_cost,
        cost_reels_usd=None,
        cost_total_usd=round(text_cost + image_cost, 4) if text_cost is not None else None,
        pricing={item.key: item.pricing for item in PRESETS},
        engines=(
            {"model": preset.model, "images": preset.image_engine, "video": preset.video_engine} if staff else None
        ),
        calculator=dict(TYPICAL),
        assumptions=[
            "Prices are list prices per provider and are estimates. Your invoice is the source of truth.",
            "Text cost uses the tokens your Coordinator recorded this month, counted from when each conversation started.",
            f"A reel is a short slideshow of {FRAMES_PER_REEL} generated frames stitched together at no extra charge.",
            "Branded images are counted from posts made by the Social Autopilot. Reels are not counted yet.",
        ],
    )
