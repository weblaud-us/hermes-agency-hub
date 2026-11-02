"""Credential generation for a tenant container.

Every secret a tenant needs is minted here and handed to the caller exactly
once. The hub keeps only what it needs to *identify* a credential later — the
scrypt hash of the dashboard password, never the password itself.

The hash format is not ours to choose: it has to be byte-compatible with the
agent image's bundled basic-auth provider, which verifies
``scrypt$n$r$p$<salt_b64>$<dk_b64>`` using stdlib :func:`hashlib.scrypt`. The
parameters below mirror ``plugins/dashboard_auth/basic/__init__.py`` (``_SCRYPT_*``
constants and ``hash_password()``) in the upstream agent repo. Keep them in sync
if that provider ever changes; ``tests/test_credentials.py`` verifies the
round-trip against the real implementation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

# ---- scrypt parameters (mirror of the agent's basic-auth provider) ----
# Interactive-login cost: ~16 MiB, a few milliseconds. ``n`` must be a power
# of two. Changing any of these produces hashes the agent still *verifies*
# fine (the parameters are encoded in the string), but keeping them aligned
# means our output is indistinguishable from the agent's own.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SCRYPT_SALT_BYTES = 16

#: ``API_SERVER_KEY`` shorter than this makes the agent's gateway refuse to
#: start its API server (startup guard in ``gateway/platforms/api_server.py``).
API_KEY_MIN_LENGTH = 16

#: Entropy for the generated dashboard password, in bytes before base64.
_PASSWORD_BYTES = 18
#: Entropy for the dashboard session-signing secret. The provider requires at
#: least 16 decoded bytes before it will accept a value as a key.
_SECRET_BYTES = 32
_API_KEY_BYTES = 32

DEFAULT_DASHBOARD_USERNAME = "admin"


def hash_dashboard_password(password: str) -> str:
    """Hash ``password`` into the agent's ``scrypt$...`` format.

    Returns a self-describing string: the cost parameters travel with the
    hash, so the agent can verify it without sharing our constants.
    """
    salt = secrets.token_bytes(_SCRYPT_SALT_BYTES)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=0,
    )
    salt_b64 = base64.b64encode(salt).decode()
    derived_b64 = base64.b64encode(derived).decode()
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt_b64}${derived_b64}"


def verify_dashboard_password(password: str, encoded: str) -> bool:
    """Constant-time verify against a ``scrypt$...`` string.

    The hub never authenticates dashboard logins itself — the tenant container
    does. This exists so our hashes can be tested without importing the agent,
    and so support tooling can confirm a stored hash matches a reissued
    password. Returns ``False`` on any malformed input rather than raising.
    """
    try:
        scheme, n_s, r_s, p_s, salt_b64, derived_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n_s), int(r_s), int(p_s)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(derived_b64)
    except (ValueError, TypeError):
        return False
    try:
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=n,
            r=r,
            p=p,
            dklen=len(expected),
            maxmem=0,
        )
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(actual, expected)


@dataclass(frozen=True)
class TenantCredentials:
    """The full credential set for one tenant.

    ``dashboard_password`` is the only plaintext here and the only field the
    hub does not persist. It is returned to the operator in the onboarding
    response and is unrecoverable afterwards — reissuing means regenerating.
    """

    dashboard_username: str
    dashboard_password: str
    dashboard_password_hash: str
    dashboard_secret: str
    api_key: str

    def as_persistable(self) -> dict[str, str]:
        """The subset safe to write to the database (no plaintext password)."""
        return {
            "dashboard_username": self.dashboard_username,
            "dashboard_password_hash": self.dashboard_password_hash,
            "dashboard_secret": self.dashboard_secret,
            "api_key": self.api_key,
        }


def generate_api_key(subdomain: str) -> str:
    """Mint a tenant bearer token, shaped ``sk-{subdomain}-{random}``.

    The subdomain is embedded so a leaked key is immediately traceable to a
    tenant without a database lookup.
    """
    key = f"sk-{subdomain}-{secrets.token_urlsafe(_API_KEY_BYTES)}"
    # Defence in depth: the agent silently leaves its API server *down* when
    # the key is too short, which would surface as a confusing health failure
    # much later. The generated key clears this by a wide margin; the check
    # exists to catch a future change to _API_KEY_BYTES.
    if len(key) < API_KEY_MIN_LENGTH:
        raise ValueError(
            f"Generated api_key is {len(key)} chars; the agent requires at "
            f"least {API_KEY_MIN_LENGTH}."
        )
    return key


def generate_tenant_credentials(
    subdomain: str,
    *,
    username: str = DEFAULT_DASHBOARD_USERNAME,
) -> TenantCredentials:
    """Mint a complete, independent credential set for one tenant."""
    password = secrets.token_urlsafe(_PASSWORD_BYTES)
    return TenantCredentials(
        dashboard_username=username,
        dashboard_password=password,
        dashboard_password_hash=hash_dashboard_password(password),
        # base64 so it survives .env round-tripping unambiguously; the
        # provider decodes base64/hex and falls back to raw bytes.
        dashboard_secret=base64.b64encode(secrets.token_bytes(_SECRET_BYTES)).decode(),
        api_key=generate_api_key(subdomain),
    )


def key_last4(api_key: str) -> str:
    """Trailing fragment of a provider key, for support triage.

    Stored instead of the key itself so an operator can confirm *which* key a
    tenant was given without the hub holding the credential.
    """
    return api_key.strip()[-4:] if api_key else ""
