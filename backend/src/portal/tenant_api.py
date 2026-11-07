"""Calls from the hub to a tenant's own API, and outward on its behalf.

The upstream address comes from ``Settings.probe_targets_for``, never a literal
``127.0.0.1``: published ports live on the host's loopback, which a containerized
hub cannot reach (see the README). Nothing from an upstream response is passed
along raw, because its health body names the vendor, its chat body names the
model, and its error text is written for operators.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..clients.models import Client
from ..config.settings import Settings
from .errors import coordinator_unavailable

logger = logging.getLogger(__name__)

#: The seam tests replace, so no test reaches the network.
_transport: httpx.AsyncBaseTransport | None = None

TELEGRAM_API = "https://api.telegram.org"
WHATSAPP_API = "https://graph.facebook.com/v21.0"


async def call(
    settings: Settings,
    client: Client,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> httpx.Response:
    host, _, api_port = settings.probe_targets_for(client)
    if not api_port:
        raise coordinator_unavailable()
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=_transport) as http:
            return await http.request(
                method,
                f"http://{host}:{api_port}{path}",
                headers={"Authorization": f"Bearer {client.api_key}"},
                json=json,
            )
    except httpx.HTTPError as exc:
        logger.warning("Tenant API call failed for %s: %s", client.slug, type(exc).__name__)
        raise coordinator_unavailable() from exc


async def send_telegram_message(bot_token: str, chat_id: str, text: str) -> bool:
    """Send one real message through the tenant's own bot.

    Failures are reported as ``False`` and logged by type only: httpx puts the
    request URL in its error text, and this URL contains the bot token.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0, transport=_transport) as http:
            response = await http.post(
                f"{TELEGRAM_API}/bot{bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": text},
            )
    except httpx.HTTPError as exc:
        logger.warning("Telegram test message failed: %s", type(exc).__name__)
        return False
    return response.status_code == 200


async def send_whatsapp_text(access_token: str, phone_number_id: str, to: str, text: str) -> bool:
    """Send one text through the tenant's own WhatsApp Cloud API number.

    Reported as ``False`` and logged by type only, for the same reason as Telegram: the
    request carries the access token.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0, transport=_transport) as http:
            response = await http.post(
                f"{WHATSAPP_API}/{phone_number_id}/messages",
                headers={"Authorization": f"Bearer {access_token}"},
                json={
                    "messaging_product": "whatsapp",
                    "to": to,
                    "type": "text",
                    "text": {"body": text[:4000], "preview_url": False},
                },
            )
    except httpx.HTTPError as exc:
        logger.warning("WhatsApp send failed: %s", type(exc).__name__)
        return False
    return response.status_code == 200
