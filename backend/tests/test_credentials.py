"""The tenant credential format must be byte-compatible with the agent image.

If these fail, tenants will be provisioned with a dashboard nobody can log
into — and the failure would otherwise only surface as a 401 after a multi-GB
container has already been started.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re

import pytest

from src.orchestrator.credentials import (
    API_KEY_MIN_LENGTH,
    generate_api_key,
    generate_tenant_credentials,
    hash_dashboard_password,
    key_last4,
    verify_dashboard_password,
)


def agent_verify(password: str, encoded: str) -> bool:
    """Independent transcription of the AGENT's `_verify_password`.

    Deliberately does not call our own verifier: a shared bug in both would
    cancel out and the test would pass while production failed. Mirrors
    plugins/dashboard_auth/basic/__init__.py:62-77 in the agent repo.
    """
    scheme, n_s, r_s, p_s, salt_b64, dk_b64 = encoded.split("$")
    if scheme != "scrypt":
        return False
    n, r, p = int(n_s), int(r_s), int(p_s)
    salt = base64.b64decode(salt_b64)
    expected = base64.b64decode(dk_b64)
    actual = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
        dklen=len(expected), maxmem=0,
    )
    return hmac.compare_digest(actual, expected)


class TestHashFormat:
    def test_agent_accepts_our_hash(self) -> None:
        encoded = hash_dashboard_password("correct horse battery staple")
        assert agent_verify("correct horse battery staple", encoded)

    def test_agent_rejects_wrong_password(self) -> None:
        encoded = hash_dashboard_password("right")
        assert not agent_verify("wrong", encoded)

    def test_structure_matches_what_the_agent_unpacks(self) -> None:
        # The agent does a 6-way unpack and will raise ValueError on anything
        # else, which it catches as "malformed" -> login always fails.
        parts = hash_dashboard_password("pw").split("$")
        assert len(parts) == 6
        assert parts[0] == "scrypt"
        assert (parts[1], parts[2], parts[3]) == ("16384", "8", "1")
        assert len(base64.b64decode(parts[4])) == 16   # salt
        assert len(base64.b64decode(parts[5])) == 32   # derived key

    def test_salt_is_random_per_call(self) -> None:
        assert hash_dashboard_password("pw") != hash_dashboard_password("pw")

    def test_round_trip_through_our_own_verifier(self) -> None:
        encoded = hash_dashboard_password("pw")
        assert verify_dashboard_password("pw", encoded)
        assert not verify_dashboard_password("nope", encoded)

    @pytest.mark.parametrize(
        "junk",
        ["", "not-a-hash", "scrypt$1$2$3", "bcrypt$16384$8$1$AA==$AA==",
         "scrypt$x$8$1$AA==$AA=="],
    )
    def test_malformed_input_is_false_not_an_exception(self, junk: str) -> None:
        # A verifier that raises would turn a corrupt stored hash into a 500.
        assert verify_dashboard_password("pw", junk) is False


class TestApiKey:
    def test_shape_is_traceable_to_a_tenant(self) -> None:
        key = generate_api_key("acme")
        assert re.fullmatch(r"sk-acme-[A-Za-z0-9_-]{16,}", key)

    def test_clears_the_agent_minimum_length(self) -> None:
        # Below this the gateway silently refuses to start its API server.
        assert len(generate_api_key("a")) >= API_KEY_MIN_LENGTH

    def test_keys_are_unique(self) -> None:
        assert generate_api_key("acme") != generate_api_key("acme")


class TestTenantCredentials:
    def test_generated_hash_verifies_against_generated_password(self) -> None:
        creds = generate_tenant_credentials("acme")
        assert agent_verify(creds.dashboard_password, creds.dashboard_password_hash)

    def test_secret_decodes_to_at_least_16_bytes(self) -> None:
        # Shorter and the agent's provider discards it and generates a random
        # per-process key instead, silently breaking sessions across restarts.
        creds = generate_tenant_credentials("acme")
        assert len(base64.b64decode(creds.dashboard_secret)) >= 16

    def test_persistable_subset_excludes_the_plaintext(self) -> None:
        creds = generate_tenant_credentials("acme")
        persisted = creds.as_persistable()
        assert "dashboard_password" not in persisted
        assert creds.dashboard_password not in str(persisted)
        assert persisted["dashboard_password_hash"] == creds.dashboard_password_hash

    def test_each_tenant_gets_independent_credentials(self) -> None:
        a = generate_tenant_credentials("acme")
        b = generate_tenant_credentials("acme")
        assert a.dashboard_password != b.dashboard_password
        assert a.dashboard_secret != b.dashboard_secret
        assert a.api_key != b.api_key


def test_key_last4_is_a_fragment_not_the_key() -> None:
    assert key_last4("sk-or-v1-abcdefghijklmnop") == "mnop"
    assert key_last4("") == ""
