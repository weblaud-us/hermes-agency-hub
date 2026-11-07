"""Sign-in, sessions and who may do what, through the real app over HTTP."""

from __future__ import annotations

import base64
import json
import time
import uuid

import jwt
import pytest
import pytest_asyncio
from pydantic import ValidationError

from conftest import AUTH, Hub, make_settings
from src.auth import router as auth_router
from src.auth import service as auth_service
from src.auth.dependencies import ACCESS_COOKIE, REFRESH_COOKIE
from src.auth.models import User, UserRole
from src.auth.permissions import ROLE_PERMISSIONS, Permission
from src.auth.tokens import SessionTokenError, decode_session_token, issue_session_token, verify_password
from src.config.settings import Settings

PASSWORD = "correct-horse-battery"
ME = "/api/v1/auth/me"
LOGIN = "/api/v1/auth/login"
OTP = "/api/v1/auth/magic-otp"


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    # Process-wide by design, which would otherwise carry between tests.
    for window in (
        auth_router._login_limit,
        auth_router._otp_request_limit,
        auth_router._otp_verify_limit,
        auth_router._password_limit,
    ):
        window._hits.clear()


@pytest_asyncio.fixture
async def seeded(hub: Hub, session_factory) -> Hub:
    """The hub with its first-run accounts in place, including the demo tenant."""
    hub.settings.auth_seed_password = PASSWORD
    async with session_factory() as session:
        created = await auth_service.seed_accounts(session, hub.settings)
        await session.commit()
    assert len(created) == 5
    return hub


def sign_in(hub: Hub, email: str, password: str = PASSWORD) -> dict[str, str]:
    """Bearer headers for a user, leaving the shared test client without cookies."""
    response = hub.http.post(LOGIN, json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    hub.http.cookies.clear()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def add_user(session_factory, **fields) -> User:
    async with session_factory() as session:
        user = await auth_service.create_user(session, password=PASSWORD, **fields)
        await session.commit()
    return user


# ======================================================================
# seeding
# ======================================================================
class TestSeeding:
    async def test_creates_the_team_and_the_demo_owner(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            roles = {user.email: user.role for user in await auth_service.list_users(session)}
        assert roles == {
            "ishtiaq@weblaud.com": UserRole.SUPER_ADMIN,
            "sakib@weblaud.com": UserRole.SUPER_ADMIN,
            "jubayed@weblaud.com": UserRole.SALES_OPS,
            "owner@suvana.com": UserRole.CLIENT_OWNER,
            "owner@apex-dental.com": UserRole.CLIENT_OWNER,
        }

    async def test_the_demo_owner_is_linked_to_the_suvana_tenant(self, seeded: Hub):
        response = seeded.http.post(LOGIN, json={"email": "owner@suvana.com", "password": PASSWORD})
        assert response.json()["user"]["client_slug"] == "suvana"

    async def test_does_nothing_once_any_account_exists(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            assert await auth_service.seed_accounts(session, seeded.settings) == []

    async def test_a_local_install_uses_the_published_demo_passwords(
        self, session_factory, tmp_path
    ):
        settings = make_settings(tmp_path)
        async with session_factory() as session:
            await auth_service.seed_accounts(session, settings)
            users = await auth_service.list_users(session)
        assert len(users) == 5
        for user in users:
            assert verify_password(auth_service.LOCAL_DEMO_PASSWORDS[user.email], user.password_hash)

    async def test_refuses_to_invent_passwords_outside_a_local_install(self, session_factory, tmp_path):
        settings = make_settings(tmp_path, environment="production")
        async with session_factory() as session:
            assert await auth_service.seed_accounts(session, settings) == []

    async def test_no_demo_tenant_in_production(self, session_factory, tmp_path):
        settings = make_settings(tmp_path, environment="production", auth_seed_password=PASSWORD)
        async with session_factory() as session:
            created = await auth_service.seed_accounts(session, settings)
        assert "owner@suvana.com" not in created
        assert "owner@apex-dental.com" not in created
        assert len(created) == 3


# ======================================================================
# settings that would be sign-in bypasses
# ======================================================================
class TestUnsafeSettings:
    def test_simulated_otp_is_refused_outside_local(self, tmp_path):
        with pytest.raises(ValidationError):
            make_settings(tmp_path, environment="production", otp_simulate=True)

    def test_otp_simulation_defaults_off_outside_local(self, tmp_path):
        assert make_settings(tmp_path, environment="staging").otp_simulated is False
        assert make_settings(tmp_path).otp_simulated is True

    def test_production_refuses_the_published_default_key(self, tmp_path):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, environment="production", admin_api_key="change-me-admin-key", data_root=tmp_path)

    def test_signing_key_is_not_the_admin_key(self, tmp_path):
        settings = make_settings(tmp_path)
        assert settings.session_signing_key != settings.admin_api_key

    def test_an_explicit_secret_wins(self, tmp_path):
        assert make_settings(tmp_path, jwt_secret="x" * 40).session_signing_key == "x" * 40


# ======================================================================
# password login
# ======================================================================
class TestLogin:
    async def test_returns_tokens_profile_and_permissions(self, seeded: Hub):
        body = seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD}).json()
        assert body["access_token"] and body["refresh_token"]
        assert body["token_type"] == "bearer"
        assert body["user"]["role"] == "SUPER_ADMIN"
        assert Permission.CONTAINERS_TERMINATE.value in body["user"]["permissions"]
        assert "password" not in json.dumps(body["user"])

    async def test_sets_http_only_same_site_cookies(self, seeded: Hub):
        response = seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD})
        cookies = [value.lower() for value in response.headers.get_list("set-cookie")]
        assert len(cookies) == 2
        for cookie in cookies:
            assert "httponly" in cookie
            assert "samesite=lax" in cookie
            assert "path=/" in cookie

    async def test_cookies_are_secure_outside_local(self, tmp_path):
        assert make_settings(tmp_path, environment="production", admin_api_key="k" * 32).secure_cookies is True
        assert make_settings(tmp_path).secure_cookies is False

    async def test_the_email_is_case_insensitive(self, seeded: Hub):
        response = seeded.http.post(LOGIN, json={"email": "SAKIB@Weblaud.com", "password": PASSWORD})
        assert response.status_code == 200

    async def test_wrong_password_and_unknown_email_look_the_same(self, seeded: Hub):
        wrong = seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": "nope"})
        unknown = seeded.http.post(LOGIN, json={"email": "nobody@weblaud.com", "password": "nope"})
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json() == unknown.json()

    async def test_an_owner_with_no_password_cannot_use_a_blank_one(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            await auth_service.create_user(
                session, email="codes@only.example.com", full_name="Codes Only", role=UserRole.SALES_OPS
            )
            await session.commit()
        response = seeded.http.post(LOGIN, json={"email": "codes@only.example.com", "password": "x"})
        assert response.status_code == 401

    async def test_a_deactivated_account_cannot_sign_in(self, seeded: Hub):
        admin = sign_in(seeded, "sakib@weblaud.com")
        users = seeded.http.get("/api/v1/auth/users", headers=admin).json()
        target = next(user for user in users if user["email"] == "jubayed@weblaud.com")
        patched = seeded.http.patch(
            f"/api/v1/auth/users/{target['id']}", headers=admin, json={"is_active": False}
        )
        assert patched.status_code == 200
        response = seeded.http.post(LOGIN, json={"email": "jubayed@weblaud.com", "password": PASSWORD})
        assert response.status_code == 401

    async def test_repeated_failures_are_rate_limited(self, seeded: Hub):
        codes = [
            seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": "nope"}).status_code
            for _ in range(9)
        ]
        assert codes[:8] == [401] * 8
        assert codes[8] == 429


# ======================================================================
# session tokens
# ======================================================================
class TestSessions:
    async def test_me_works_with_a_bearer_token(self, seeded: Hub):
        body = seeded.http.get(ME, headers=sign_in(seeded, "sakib@weblaud.com")).json()
        assert body["email"] == "sakib@weblaud.com"

    async def test_me_works_with_the_cookie(self, seeded: Hub):
        seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD})
        assert seeded.http.get(ME).status_code == 200

    async def test_me_requires_a_session(self, hub: Hub):
        assert hub.http.get(ME).status_code == 401

    async def test_the_admin_key_is_not_a_person(self, hub: Hub):
        assert hub.http.get(ME, headers=AUTH).status_code == 401

    async def test_refresh_issues_a_working_session(self, seeded: Hub):
        seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD})
        seeded.http.cookies.delete(ACCESS_COOKIE)
        assert seeded.http.get(ME).status_code == 401
        assert seeded.http.post("/api/v1/auth/refresh").status_code == 200
        assert seeded.http.get(ME).status_code == 200

    async def test_a_bad_refresh_clears_the_cookies(self, seeded: Hub):
        seeded.http.cookies.set(REFRESH_COOKIE, "garbage")
        response = seeded.http.post("/api/v1/auth/refresh")
        assert response.status_code == 401
        assert any("max-age=0" in value.lower() for value in response.headers.get_list("set-cookie"))

    async def test_logout_revokes_tokens_already_issued(self, seeded: Hub):
        headers = sign_in(seeded, "sakib@weblaud.com")
        assert seeded.http.get(ME, headers=headers).status_code == 200
        seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD})
        assert seeded.http.post("/api/v1/auth/logout").status_code == 204
        seeded.http.cookies.clear()
        assert seeded.http.get(ME, headers=headers).status_code == 401

    async def test_logout_is_safe_with_no_session(self, hub: Hub):
        assert hub.http.post("/api/v1/auth/logout").status_code == 204

    async def test_a_refresh_token_is_not_an_access_token(self, seeded: Hub):
        body = seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD}).json()
        seeded.http.cookies.clear()
        headers = {"Authorization": f"Bearer {body['refresh_token']}"}
        assert seeded.http.get(ME, headers=headers).status_code == 401

    async def test_an_access_token_cannot_refresh(self, seeded: Hub):
        body = seeded.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": PASSWORD}).json()
        seeded.http.cookies.clear()
        seeded.http.cookies.set(REFRESH_COOKIE, body["access_token"])
        assert seeded.http.post("/api/v1/auth/refresh").status_code == 401

    async def test_an_expired_token_is_rejected(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            user = await auth_service.get_by_email(session, "sakib@weblaud.com")
        token, _ = issue_session_token(seeded.settings, user, "access", now=time.time() - 86_400)
        assert seeded.http.get(ME, headers={"Authorization": f"Bearer {token}"}).status_code == 401

    async def test_a_token_signed_with_another_key_is_rejected(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            user = await auth_service.get_by_email(session, "sakib@weblaud.com")
        forged = jwt.encode(
            {"sub": str(user.id), "kind": "access", "ver": 0, "role": "SUPER_ADMIN", "exp": time.time() + 600},
            "not-the-signing-key-but-long-enough-to-not-warn",
            algorithm="HS256",
        )
        assert seeded.http.get(ME, headers={"Authorization": f"Bearer {forged}"}).status_code == 401

    def test_alg_none_is_rejected(self, tmp_path):
        def b64(data: dict) -> str:
            return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

        forged = ".".join(
            [
                b64({"alg": "none", "typ": "JWT"}),
                b64({"sub": str(uuid.uuid4()), "kind": "access", "ver": 0, "exp": 9_999_999_999}),
                "",
            ]
        )
        with pytest.raises(SessionTokenError):
            decode_session_token(make_settings(tmp_path), forged, "access")

    async def test_the_role_in_a_token_is_not_believed(self, seeded: Hub, session_factory):
        # Sales signing a token that claims SUPER_ADMIN still gets the row's role.
        async with session_factory() as session:
            user = await auth_service.get_by_email(session, "jubayed@weblaud.com")
        token = jwt.encode(
            {"sub": str(user.id), "kind": "access", "ver": 0, "role": "SUPER_ADMIN", "exp": time.time() + 600},
            seeded.settings.session_signing_key,
            algorithm="HS256",
        )
        response = seeded.http.get("/api/v1/clients", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 403

    async def test_changing_a_password_ends_other_sessions(self, seeded: Hub):
        old = sign_in(seeded, "sakib@weblaud.com")
        response = seeded.http.post(
            "/api/v1/auth/change-password",
            headers=old,
            json={"current_password": PASSWORD, "new_password": "a-much-better-password"},
        )
        assert response.status_code == 200
        seeded.http.cookies.clear()
        assert seeded.http.get(ME, headers=old).status_code == 401
        sign_in(seeded, "sakib@weblaud.com", "a-much-better-password")

    async def test_changing_a_password_needs_the_current_one(self, seeded: Hub):
        response = seeded.http.post(
            "/api/v1/auth/change-password",
            headers=sign_in(seeded, "sakib@weblaud.com"),
            json={"current_password": "wrong", "new_password": "a-much-better-password"},
        )
        assert response.status_code == 403


# ======================================================================
# one-time codes
# ======================================================================
class TestMagicOtp:
    def _request(self, hub: Hub, identifier: str = "owner@suvana.com"):
        return hub.http.post(OTP, json={"identifier": identifier})

    async def test_requesting_then_verifying_signs_in(self, seeded: Hub):
        issued = self._request(seeded).json()
        assert issued["channel"] == "email"
        code = issued["simulated_code"]
        assert len(code) == 6 and code.isdigit()

        response = seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": code})
        assert response.status_code == 200
        assert response.json()["user"]["client_slug"] == "suvana"
        assert seeded.http.get(ME).status_code == 200

    async def test_a_code_works_once(self, seeded: Hub):
        code = self._request(seeded).json()["simulated_code"]
        body = {"identifier": "owner@suvana.com", "code": code}
        assert seeded.http.post(OTP, json=body).status_code == 200
        assert seeded.http.post(OTP, json=body).status_code == 401

    async def test_a_new_code_replaces_the_old_one(self, seeded: Hub):
        first = self._request(seeded).json()["simulated_code"]
        second = self._request(seeded).json()["simulated_code"]
        if first == second:
            pytest.skip("the two random codes happened to match")
        assert seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": first}).status_code == 401
        assert seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": second}).status_code == 200

    async def test_whatsapp_number_works_in_any_format(self, seeded: Hub, session_factory):
        async with session_factory() as session:
            owner = await auth_service.get_by_email(session, "owner@suvana.com")
            owner.phone = "8801711000000"
            await session.commit()
        issued = self._request(seeded, "+880 1711-000000").json()
        assert issued["channel"] == "whatsapp"
        response = seeded.http.post(
            OTP, json={"identifier": "+8801711000000", "code": issued["simulated_code"]}
        )
        assert response.status_code == 200

    async def test_an_unknown_identifier_gets_the_same_shape_and_no_code(self, seeded: Hub):
        known = self._request(seeded).json()
        unknown = self._request(seeded, "nobody@nowhere.example.com").json()
        assert unknown["simulated_code"] is None
        assert unknown["detail"] == known["detail"]
        assert set(unknown) == set(known)

    async def test_wrong_guesses_exhaust_the_code(self, seeded: Hub):
        code = self._request(seeded).json()["simulated_code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(seeded.settings.otp_max_attempts):
            response = seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": wrong})
            assert response.status_code == 401
        # Even the right code no longer works: the attempts were counted.
        assert seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": code}).status_code == 401

    async def test_an_expired_code_is_refused(self, seeded: Hub):
        seeded.settings.otp_ttl_minutes = -1
        code = self._request(seeded).json()["simulated_code"]
        assert seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": code}).status_code == 401

    async def test_requests_are_rate_limited(self, seeded: Hub):
        codes = [self._request(seeded).status_code for _ in range(4)]
        assert codes == [200, 200, 200, 429]

    async def test_outside_local_it_refuses_rather_than_handing_out_codes(self, seeded: Hub):
        seeded.settings.otp_simulate = False
        response = self._request(seeded)
        assert response.status_code == 503
        assert "simulated_code" not in response.text

    @pytest.mark.parametrize("code", ["12345", "1234567", "abcdef"])
    async def test_malformed_codes_are_rejected(self, seeded: Hub, code: str):
        response = seeded.http.post(OTP, json={"identifier": "owner@suvana.com", "code": code})
        assert response.status_code == 422


# ======================================================================
# the role matrix
# ======================================================================
class TestAdminKeyStaysCompatible:
    def test_the_admin_key_still_works_on_every_admin_route(self, hub: Hub):
        assert hub.http.get("/api/v1/clients", headers=AUTH).status_code == 200
        assert hub.http.get("/api/v1/crm/prospects", headers=AUTH).status_code == 200
        assert hub.http.get("/api/v1/qa/queue", headers=AUTH).status_code == 200

    async def test_a_wrong_key_does_not_fall_through_to_a_session(self, seeded: Hub):
        headers = {**sign_in(seeded, "sakib@weblaud.com"), "X-API-Key": "wrong"}
        assert seeded.http.get("/api/v1/clients", headers=headers).status_code == 401

    def test_a_non_ascii_key_is_refused_not_crashed_on(self, hub: Hub):
        response = hub.http.get("/api/v1/clients", headers={"X-API-Key": b"\xc3\xa9"})
        assert response.status_code == 401


class TestSalesOps:
    async def test_cannot_delete_a_container(self, seeded: Hub):
        client_id = seeded.onboard(company_name="Delete Me", subdomain="delete-me").json()["client_id"]
        response = seeded.http.delete(
            f"/api/v1/clients/{client_id}", headers=sign_in(seeded, "jubayed@weblaud.com")
        )
        assert response.status_code == 403
        # The refusal has to mean nothing happened.
        assert "hermes-client-delete-me" in seeded.docker.containers_by_name
        assert seeded.docker.removed == []

    async def test_cannot_provision(self, seeded: Hub):
        response = seeded.http.post(
            "/api/v1/clients/onboard",
            headers=sign_in(seeded, "jubayed@weblaud.com"),
            json={
                "company_name": "Nope",
                "openrouter_api_key": "sk-or-v1-whatever",
                "contact_email": "a@b.example.com",
            },
        )
        assert response.status_code == 403
        assert seeded.docker.create_calls == []

    @pytest.mark.parametrize(
        "path", ["/api/v1/clients", "/api/v1/clients/stats", "/api/v1/qa/queue", "/api/v1/skills", "/api/v1/auth/users"]
    )
    async def test_cannot_read_fleet_or_server_details(self, seeded: Hub, path: str):
        assert seeded.http.get(path, headers=sign_in(seeded, "jubayed@weblaud.com")).status_code == 403

    async def test_cannot_read_logs_or_mint_portal_links(self, seeded: Hub):
        client_id = seeded.onboard().json()["client_id"]
        headers = sign_in(seeded, "jubayed@weblaud.com")
        assert seeded.http.get(f"/api/v1/clients/{client_id}/logs", headers=headers).status_code == 403
        assert seeded.http.post(f"/api/v1/clients/{client_id}/portal-token", headers=headers).status_code == 403

    async def test_cannot_read_a_clients_portal(self, seeded: Hub):
        response = seeded.http.get("/api/v1/portal/suvana/overview", headers=sign_in(seeded, "jubayed@weblaud.com"))
        assert response.status_code == 403
        assert response.json()["error"] == "portal_forbidden"

    async def test_can_work_the_crm(self, seeded: Hub):
        headers = sign_in(seeded, "jubayed@weblaud.com")
        assert seeded.http.get("/api/v1/crm/prospects", headers=headers).status_code == 200
        assert seeded.http.get("/api/v1/crm/standup", headers=headers).status_code == 200
        assert seeded.http.get("/api/v1/crm/drafts", headers=headers).status_code == 200
        created = seeded.http.post(
            "/api/v1/crm/prospects", headers=headers, json={"business_name": "New Prospect"}
        )
        assert created.status_code == 201


class TestGrowthOps:
    @pytest_asyncio.fixture
    async def growth(self, seeded: Hub, session_factory) -> dict[str, str]:
        await add_user(session_factory, email="growth@weblaud.com", full_name="Growth", role=UserRole.GROWTH_OPS)
        return sign_in(seeded, "growth@weblaud.com")

    async def test_can_read_clients_qa_skills_and_roi(self, seeded: Hub, growth):
        client_id = seeded.onboard().json()["client_id"]
        for path in ("/api/v1/clients", "/api/v1/qa/queue", "/api/v1/skills", f"/api/v1/clients/{client_id}/roi"):
            assert seeded.http.get(path, headers=growth).status_code == 200, path

    async def test_cannot_terminate_a_container(self, seeded: Hub, growth):
        client_id = seeded.onboard().json()["client_id"]
        assert seeded.http.delete(f"/api/v1/clients/{client_id}", headers=growth).status_code == 403
        assert seeded.docker.removed == []

    async def test_cannot_provision(self, seeded: Hub, growth):
        response = seeded.http.post(
            "/api/v1/clients/onboard",
            headers=growth,
            json={"company_name": "Nope", "openrouter_api_key": "sk-or-v1-x", "contact_email": "a@b.example.com"},
        )
        assert response.status_code == 403

    async def test_cannot_reach_the_crm(self, seeded: Hub, growth):
        assert seeded.http.get("/api/v1/crm/prospects", headers=growth).status_code == 403

    async def test_can_move_a_client_through_onboarding(self, seeded: Hub, growth):
        client_id = seeded.onboard().json()["client_id"]
        response = seeded.http.patch(f"/api/v1/clients/{client_id}", headers=growth, json={"onboarding_stage": 6})
        assert response.status_code == 200
        assert response.json()["onboarding_stage"] == 6

    @pytest.mark.parametrize(
        "field, value",
        [
            ("image", "evil/image:latest"),
            ("config", {"x": 1}),
            ("package_tier", "scale"),
            ("plan", "scale"),
            ("stripe_customer_id", "cus_1"),
        ],
    )
    async def test_cannot_change_server_or_billing_fields(self, seeded: Hub, growth, field, value):
        client_id = seeded.onboard().json()["client_id"]
        response = seeded.http.patch(f"/api/v1/clients/{client_id}", headers=growth, json={field: value})
        assert response.status_code == 403

    async def test_can_look_at_a_clients_portal(self, seeded: Hub, growth):
        assert seeded.http.get("/api/v1/portal/suvana/overview", headers=growth).status_code == 200


class TestSuperAdmin:
    async def test_can_terminate_a_container(self, seeded: Hub):
        client_id = seeded.onboard().json()["client_id"]
        response = seeded.http.delete(
            f"/api/v1/clients/{client_id}", headers=sign_in(seeded, "sakib@weblaud.com")
        )
        assert response.status_code == 200
        assert response.json()["container_removed"] is True

    def test_holds_every_permission(self):
        assert ROLE_PERMISSIONS[UserRole.SUPER_ADMIN] == frozenset(Permission)

    async def test_can_manage_accounts(self, seeded: Hub):
        headers = sign_in(seeded, "sakib@weblaud.com")
        created = seeded.http.post(
            "/api/v1/auth/users",
            headers=headers,
            json={"email": "new@weblaud.com", "full_name": "New", "role": "GROWTH_OPS", "password": PASSWORD},
        )
        assert created.status_code == 201
        duplicate = seeded.http.post(
            "/api/v1/auth/users",
            headers=headers,
            json={"email": "new@weblaud.com", "full_name": "New", "role": "GROWTH_OPS"},
        )
        assert duplicate.status_code == 409

    async def test_an_owner_account_must_name_a_tenant(self, seeded: Hub):
        response = seeded.http.post(
            "/api/v1/auth/users",
            headers=sign_in(seeded, "sakib@weblaud.com"),
            json={"email": "o@x.example.com", "full_name": "Owner", "role": "CLIENT_OWNER"},
        )
        assert response.status_code == 422

    async def test_a_demotion_ends_existing_sessions(self, seeded: Hub):
        admin = sign_in(seeded, "sakib@weblaud.com")
        victim = sign_in(seeded, "ishtiaq@weblaud.com")
        users = seeded.http.get("/api/v1/auth/users", headers=admin).json()
        target = next(user for user in users if user["email"] == "ishtiaq@weblaud.com")
        seeded.http.patch(f"/api/v1/auth/users/{target['id']}", headers=admin, json={"role": "SALES_OPS"})
        assert seeded.http.get(ME, headers=victim).status_code == 401


class TestClientOwner:
    async def test_can_read_their_own_portal(self, seeded: Hub):
        headers = sign_in(seeded, "owner@suvana.com")
        assert seeded.http.get("/api/v1/portal/suvana/overview", headers=headers).status_code == 200

    async def test_cannot_read_another_tenants_portal(self, seeded: Hub):
        seeded.onboard(company_name="Rival", subdomain="rival")
        response = seeded.http.get("/api/v1/portal/rival/overview", headers=sign_in(seeded, "owner@suvana.com"))
        assert response.status_code == 403
        assert response.json()["error"] == "portal_forbidden"

    @pytest.mark.parametrize(
        "route", ["overview", "channels", "cron-reports", "skills-and-memory", "roi", "approvals", "guardrails", "workspace", "profile"]
    )
    async def test_every_portal_route_is_locked_to_their_tenant(self, seeded: Hub, route: str):
        seeded.onboard(company_name="Rival", subdomain="rival")
        response = seeded.http.get(f"/api/v1/portal/rival/{route}", headers=sign_in(seeded, "owner@suvana.com"))
        assert response.status_code == 403

    async def test_an_unknown_tenant_looks_the_same_as_someone_elses(self, seeded: Hub):
        seeded.onboard(company_name="Rival", subdomain="rival")
        headers = sign_in(seeded, "owner@suvana.com")
        taken = seeded.http.get("/api/v1/portal/rival/overview", headers=headers)
        unknown = seeded.http.get("/api/v1/portal/no-such-tenant/overview", headers=headers)
        assert taken.status_code == unknown.status_code == 403
        assert taken.json() == unknown.json()

    @pytest.mark.parametrize(
        "path", ["/api/v1/clients", "/api/v1/crm/prospects", "/api/v1/qa/queue", "/api/v1/kits", "/api/v1/skills"]
    )
    async def test_cannot_reach_anything_on_the_agency_side(self, seeded: Hub, path: str):
        assert seeded.http.get(path, headers=sign_in(seeded, "owner@suvana.com")).status_code == 403

    async def test_a_session_for_one_tenant_does_not_mix_with_a_token_for_another(self, seeded: Hub):
        rival = seeded.onboard(company_name="Rival", subdomain="rival").json()["client_id"]
        token = seeded.http.post(f"/api/v1/clients/{rival}/portal-token", headers=AUTH).json()["token"]
        # A valid link still opens only its own tenant, whoever is signed in.
        headers = {**sign_in(seeded, "owner@suvana.com"), "X-Client-Portal-Token": token}
        assert seeded.http.get("/api/v1/portal/rival/overview", headers=headers).status_code == 200
        assert seeded.http.get("/api/v1/portal/suvana/overview", headers=headers).status_code == 401

    async def test_a_bad_token_does_not_fall_through_to_the_session(self, seeded: Hub):
        headers = {**sign_in(seeded, "owner@suvana.com"), "X-Client-Portal-Token": "a.b.c"}
        assert seeded.http.get("/api/v1/portal/suvana/overview", headers=headers).status_code == 401


class TestOnboardingCreatesAnOwner:
    async def test_a_new_client_gets_an_owner_who_can_sign_in_with_a_code(self, hub: Hub):
        hub.onboard(company_name="Bright Dental", subdomain="bright", contact_email="dr@bright.example.com")
        issued = hub.http.post(OTP, json={"identifier": "dr@bright.example.com"}).json()
        assert issued["simulated_code"]
        response = hub.http.post(OTP, json={"identifier": "dr@bright.example.com", "code": issued["simulated_code"]})
        assert response.status_code == 200
        assert response.json()["user"]["role"] == "CLIENT_OWNER"
        assert hub.http.get("/api/v1/portal/bright/overview").status_code == 200

    async def test_an_existing_account_is_never_repointed_at_a_new_tenant(self, seeded: Hub):
        seeded.onboard(company_name="Second", subdomain="second", contact_email="owner@suvana.com")
        headers = sign_in(seeded, "owner@suvana.com")
        assert seeded.http.get(ME, headers=headers).json()["client_slug"] == "suvana"
        assert seeded.http.get("/api/v1/portal/second/overview", headers=headers).status_code == 403

    async def test_a_staff_email_as_contact_stays_staff(self, seeded: Hub):
        seeded.onboard(company_name="Internal", subdomain="internal", contact_email="sakib@weblaud.com")
        body = seeded.http.get(ME, headers=sign_in(seeded, "sakib@weblaud.com")).json()
        assert body["role"] == "SUPER_ADMIN"
        assert body["client_id"] is None
