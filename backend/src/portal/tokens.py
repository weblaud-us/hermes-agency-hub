"""Tenant portal access tokens: HS256 JWTs scoped to exactly one tenant.

The signing key is derived from the tenant's ``internal_token``, which is never
rendered into a tenant's files. That gives three properties with no new table,
migration or hub-wide secret:

* A token for one tenant cannot verify against another, even if ``sub`` is forged.
* Rotating ``internal_token`` revokes every outstanding token for that tenant.
* Leaking one tenant's key says nothing about any other tenant's.

The payload travels through the owner's browser and base64 is not encryption, so
it carries the tenant's public slug and nothing else worth reading.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

SCOPE = "portal"
_HEADER = {"alg": "HS256", "typ": "JWT"}
#: Domain separation: ``internal_token`` may gain other uses, and a signature
#: minted here must never validate anywhere else.
_KEY_CONTEXT = b"client-portal-token-v1"


class PortalTokenError(ValueError):
    """The token is malformed, forged, expired or for another tenant."""


@dataclass(frozen=True)
class IssuedToken:
    token: str
    expires_at: int


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise PortalTokenError("malformed segment") from exc


def _signing_key(secret: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), _KEY_CONTEXT, hashlib.sha256).digest()


def _sign(signing_input: str, secret: str) -> bytes:
    return hmac.new(
        _signing_key(secret), signing_input.encode("ascii"), hashlib.sha256
    ).digest()


def issue_token(
    *, slug: str, secret: str, ttl_seconds: int, now: float | None = None
) -> IssuedToken:
    issued_at = int(now if now is not None else time.time())
    expires_at = issued_at + ttl_seconds
    claims = {"sub": slug, "scope": SCOPE, "iat": issued_at, "exp": expires_at}
    signing_input = ".".join(
        _b64encode(json.dumps(part, separators=(",", ":")).encode("utf-8"))
        for part in (_HEADER, claims)
    )
    signature = _b64encode(_sign(signing_input, secret))
    return IssuedToken(token=f"{signing_input}.{signature}", expires_at=expires_at)


def verify_token(
    token: str, *, slug: str, secret: str, now: float | None = None
) -> dict[str, object]:
    """Return the claims, or raise :class:`PortalTokenError`.

    The header is compared to the one value this module ever writes, which
    rejects ``alg: none`` and algorithm-confusion tokens without having to
    reason about them.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise PortalTokenError("expected three segments")
    header_part, claims_part, signature_part = parts

    signature = _b64decode(signature_part)
    try:
        expected = _sign(f"{header_part}.{claims_part}", secret)
    except UnicodeEncodeError as exc:
        raise PortalTokenError("non-ascii segment") from exc
    # Before any parsing, so nothing unauthenticated reaches the JSON decoder.
    if not hmac.compare_digest(signature, expected):
        raise PortalTokenError("bad signature")

    try:
        header = json.loads(_b64decode(header_part))
        claims = json.loads(_b64decode(claims_part))
    except ValueError as exc:
        raise PortalTokenError("malformed json") from exc
    if header != _HEADER or not isinstance(claims, dict):
        raise PortalTokenError("unexpected header")
    if claims.get("scope") != SCOPE or claims.get("sub") != slug:
        raise PortalTokenError("wrong tenant or scope")

    expires_at = claims.get("exp")
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        raise PortalTokenError("missing expiry")
    if (now if now is not None else time.time()) >= expires_at:
        raise PortalTokenError("expired")
    return claims
