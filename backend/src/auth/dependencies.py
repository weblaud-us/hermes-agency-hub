"""Who is calling, and whether they may.

Three credentials reach the hub:

* ``X-API-Key``: the shared admin key, for automation and the test suite. It
  acts as SUPER_ADMIN and has no user behind it.
* ``Authorization: Bearer`` or the ``hub_access`` cookie: a person's session.
* ``X-Client-Portal-Token``: a tenant access link, handled in the portal router.

A wrong API key is refused outright and never falls through to a cookie, so a
misconfigured script fails loudly rather than borrowing someone's session.
"""

from __future__ import annotations

import logging
import secrets
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..config.database import get_session
from ..config.settings import Settings, get_settings
from .models import User, UserRole
from .permissions import ROLE_PERMISSIONS, Permission
from .tokens import SessionTokenError, decode_session_token

logger = logging.getLogger(__name__)

ACCESS_COOKIE = "hub_access"
REFRESH_COOKIE = "hub_refresh"


@dataclass(frozen=True)
class Principal:
    role: UserRole
    #: ``None`` for the admin API key.
    user: User | None = None

    @property
    def label(self) -> str:
        return self.user.email if self.user else "api-key"

    def can(self, permission: Permission) -> bool:
        return permission in ROLE_PERMISSIONS[self.role]


def _unauthenticated(detail: str = "Sign in to continue.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def load_session_user(
    session: AsyncSession, settings: Settings, token: str, kind: str = "access"
) -> User | None:
    """The live, active user a token names, or ``None`` for any reason it does not."""
    try:
        claims = decode_session_token(settings, token, kind)  # type: ignore[arg-type]
    except SessionTokenError:
        return None
    user = await session.get(User, claims.user_id)
    if user is None or not user.is_active or user.token_version != claims.version:
        return None
    return user


def _session_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    return request.cookies.get(ACCESS_COOKIE)


async def optional_user(
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> User | None:
    token = _session_token(request)
    return await load_session_user(session, settings, token) if token else None


async def get_principal(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    user: User | None = Depends(optional_user),
    settings: Settings = Depends(get_settings),
) -> Principal:
    if x_api_key is not None:
        if not secrets.compare_digest(
            x_api_key.encode("utf-8"), settings.admin_api_key.encode("utf-8")
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing X-API-Key.",
                headers={"WWW-Authenticate": "ApiKey"},
            )
        return Principal(role=UserRole.SUPER_ADMIN)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key.",
            headers={"WWW-Authenticate": "ApiKey, Bearer"},
        )
    return Principal(role=user.role, user=user)


async def current_user(user: User | None = Depends(optional_user)) -> User:
    """Routes about a person's own session, which an API key does not have."""
    if user is None:
        raise _unauthenticated()
    return user


def require_permission(permission: Permission) -> Callable[..., object]:
    """A dependency that admits only roles granted ``permission``."""

    async def _check(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.can(permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your role does not allow this.",
            )
        return principal

    return _check


def require_any_permission(*permissions: Permission) -> Callable[..., object]:
    async def _check(principal: Principal = Depends(get_principal)) -> Principal:
        if not any(principal.can(permission) for permission in permissions):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your role does not allow this.",
            )
        return principal

    return _check


# ---------------------------------------------------------------- rate limits
class KeyedWindow:
    """Per-process attempt budget, as in the portal router: one worker, so exact."""

    def __init__(self, limit: int, seconds: float) -> None:
        self.limit = limit
        self.seconds = seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        hits = self._hits[key]
        while hits and now - hits[0] >= self.seconds:
            hits.popleft()
        if len(hits) >= self.limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Wait a few minutes and try again.",
            )
        hits.append(now)

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)
