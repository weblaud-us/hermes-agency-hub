"""Password hashing and session JWTs.

Separate from ``portal/tokens.py`` on purpose. Those tokens are bearer links, each
scoped to a tenant and signed with that tenant's secret; these identify a person,
are signed with a hub-wide key, and are checked against the user row every time.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from ..config.settings import Settings
from .models import User

TokenKind = Literal["access", "refresh"]

_ALGORITHM = "HS256"
_hasher = PasswordHasher()
#: Verified when no account matches, so a login for an unknown email costs the
#: same as one for a known email and timing cannot be used to enumerate accounts.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


class SessionTokenError(ValueError):
    """The token is malformed, forged, expired or of the wrong kind."""


@dataclass(frozen=True)
class SessionClaims:
    user_id: uuid.UUID
    version: int
    kind: TokenKind


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, stored: str | None) -> bool:
    try:
        return _hasher.verify(stored or _DUMMY_HASH, password) and stored is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def issue_session_token(
    settings: Settings,
    user: User,
    kind: TokenKind,
    *,
    client_slug: str | None = None,
    now: float | None = None,
) -> tuple[str, int]:
    """Mint a token and report its lifetime in seconds.

    ``role`` and ``tenant`` are for the frontend's route guard, which only decodes
    them to choose a redirect. The hub itself reads the role from the user row.
    """
    ttl = (
        settings.access_token_ttl_minutes * 60
        if kind == "access"
        else settings.refresh_token_ttl_days * 86_400
    )
    issued_at = int(now if now is not None else time.time())
    claims = {
        "sub": str(user.id),
        "kind": kind,
        "ver": user.token_version,
        "role": user.role.value,
        "tenant": client_slug,
        "iat": issued_at,
        "exp": issued_at + ttl,
    }
    return jwt.encode(claims, settings.session_signing_key, algorithm=_ALGORITHM), ttl


def decode_session_token(
    settings: Settings, token: str, kind: TokenKind
) -> SessionClaims:
    try:
        claims = jwt.decode(
            token,
            settings.session_signing_key,
            # Pinned: the header's own "alg" is never trusted.
            algorithms=[_ALGORITHM],
            options={"require": ["exp", "sub", "kind", "ver"]},
        )
        if claims["kind"] != kind:
            raise SessionTokenError("wrong token kind")
        return SessionClaims(uuid.UUID(claims["sub"]), int(claims["ver"]), kind)
    except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
        raise SessionTokenError(str(exc)) from exc


def new_otp_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_otp(settings: Settings, user_id: uuid.UUID, code: str) -> str:
    """Keyed, because a bare hash of six digits reverses in a million tries."""
    message = f"otp:{user_id}:{code}".encode("utf-8")
    return hmac.new(settings.session_signing_key.encode("utf-8"), message, hashlib.sha256).hexdigest()
