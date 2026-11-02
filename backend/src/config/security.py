"""Admin authentication for the agency dashboard API."""

from __future__ import annotations

import secrets

from fastapi import Depends, Header, HTTPException, status

from .settings import Settings, get_settings


async def require_admin(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    settings: Settings = Depends(get_settings),
) -> None:
    """Guard admin routes with a constant-time comparison on the shared key."""
    if not x_api_key or not secrets.compare_digest(x_api_key, settings.admin_api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key.",
            headers={"WWW-Authenticate": "ApiKey"},
        )


def new_internal_token() -> str:
    """Shared secret the hub and one client container use to talk to each other."""
    return secrets.token_urlsafe(32)
