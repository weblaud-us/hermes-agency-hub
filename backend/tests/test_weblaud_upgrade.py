"""The Weblaud upgrade end to end: sessions and roles, the social autopilot and its two
scripts, the ROI funnel, one-tap approvals, the CRM, and the specialist skill library.

These run against the real app and the real scripts in ``shared-skills``. Nothing is
mocked except Meta's HTTP calls, in the one test that checks the live request sequence.
"""

from __future__ import annotations

import importlib.util
import io
import re
import sys
from pathlib import Path

import pytest
import pytest_asyncio

from conftest import AUTH, Hub, make_settings
from src.auth import router as auth_router
from src.auth import service as auth_service
from src.config.settings import REPO_ROOT
from src.portal import social_router

LOGIN = "/api/v1/auth/login"
SKILLS = REPO_ROOT / "shared-skills"
SCRIPTS = SKILLS / "social-media-autopilot" / "scripts"

PASSWORDS = {
    "ishtiaq@weblaud.com": "WeblaudAdmin!2026",
    "sakib@weblaud.com": "WeblaudAdmin!2026",
    "jubayed@weblaud.com": "WeblaudSales!2026",
    "owner@suvana.com": "ClientPortal!2026",
    "owner@apex-dental.com": "ClientPortal!2026",
}
SPEC_SKILLS = (
    "ai-employee-orchestrator",
    "social-media-autopilot",
    "designer-brand-studio",
    "video-reel-editor",
    "sales-rep-inbox",
    "ads-growth-manager",
    "email-outreach-assistant",
    "web-seo-manager",
    "roi-weekly-reporter",
    "order-desk-ecommerce",
    "catalog-keeper-ecommerce",
)


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(f"weblaud_{name}", SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def bearer(hub: Hub, email: str) -> dict[str, str]:
    response = hub.http.post(LOGIN, json={"email": email, "password": PASSWORDS[email]})
    assert response.status_code == 200, response.text
    hub.http.cookies.clear()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    for window in (
        auth_router._login_limit,
        auth_router._otp_request_limit,
        auth_router._otp_verify_limit,
        social_router._generate_limit,
    ):
        window._hits.clear()


@pytest_asyncio.fixture
async def weblaud(hub: Hub, session_factory) -> Hub:
    """First-run accounts on a local install, and the real skill library for the scripts."""
    hub.settings.shared_skills_dir = SKILLS
    async with session_factory() as session:
        created = await auth_service.seed_accounts(session, hub.settings)
        await session.commit()
    assert sorted(created) == sorted(PASSWORDS)
    return hub


def client_id_of(hub: Hub, slug: str) -> str:
    rows = hub.http.get("/api/v1/clients", headers=AUTH).json()["items"]
    return next(row["id"] for row in rows if row["slug"] == slug)


# ======================================================================
# Part 1: sessions and roles
# ======================================================================
class TestSeededAccounts:
    @pytest.mark.parametrize("email", sorted(PASSWORDS))
    async def test_every_published_account_signs_in(self, weblaud: Hub, email: str):
        response = weblaud.http.post(LOGIN, json={"email": email, "password": PASSWORDS[email]})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["user"]["email"] == email
        assert body["access_token"]
        # The cookie a browser keeps cannot be read by page scripts.
        assert "httponly" in response.headers["set-cookie"].lower()

    async def test_roles_and_tenant_scope_match_the_brief(self, weblaud: Hub):
        expected = {
            "ishtiaq@weblaud.com": ("SUPER_ADMIN", None),
            "sakib@weblaud.com": ("SUPER_ADMIN", None),
            "jubayed@weblaud.com": ("SALES_OPS", None),
            "owner@suvana.com": ("CLIENT_OWNER", "suvana"),
            "owner@apex-dental.com": ("CLIENT_OWNER", "apex-dental"),
        }
        for email, (role, subdomain) in expected.items():
            user = weblaud.http.post(LOGIN, json={"email": email, "password": PASSWORDS[email]}).json()["user"]
            assert user["role"] == role
            assert user["client_subdomain"] == subdomain
        weblaud.http.cookies.clear()

    async def test_a_portal_login_is_scoped_to_the_subdomain_entered(self, weblaud: Hub):
        owner = {"email": "owner@apex-dental.com", "password": PASSWORDS["owner@apex-dental.com"]}
        assert weblaud.http.post(LOGIN, json={**owner, "subdomain": "apex-dental"}).status_code == 200
        weblaud.http.cookies.clear()
        # The right password for the wrong business looks like any other bad login.
        wrong = weblaud.http.post(LOGIN, json={**owner, "subdomain": "suvana"})
        assert wrong.status_code == 401
        assert wrong.json()["detail"] == "That email and password do not match."
        # Agency staff sign in through the console, not through a business portal.
        staff = {"email": "sakib@weblaud.com", "password": PASSWORDS["sakib@weblaud.com"], "subdomain": "suvana"}
        assert weblaud.http.post(LOGIN, json=staff).status_code == 401

    async def test_a_wrong_password_is_refused(self, weblaud: Hub):
        response = weblaud.http.post(LOGIN, json={"email": "sakib@weblaud.com", "password": "WeblaudAdmin!2025"})
        assert response.status_code == 401

    async def test_the_admin_api_key_still_works(self, weblaud: Hub):
        assert weblaud.http.get("/api/v1/clients", headers=AUTH).status_code == 200

    async def test_a_cookie_session_reads_me(self, weblaud: Hub):
        weblaud.http.post(LOGIN, json={"email": "jubayed@weblaud.com", "password": PASSWORDS["jubayed@weblaud.com"]})
        body = weblaud.http.get("/api/v1/auth/me").json()
        assert body["role"] == "SALES_OPS"
        assert "crm:manage" in body["permissions"]
        assert "containers:terminate" not in body["permissions"]
        weblaud.http.cookies.clear()

    async def test_production_will_not_use_the_published_passwords(self, session_factory, tmp_path):
        settings = make_settings(tmp_path, environment="production")
        async with session_factory() as session:
            assert await auth_service.seed_accounts(session, settings) == []


class TestRoleEnforcement:
    async def test_sales_ops_cannot_terminate_a_container(self, weblaud: Hub):
        onboarded = weblaud.onboard()
        assert onboarded.status_code == 201, onboarded.text
        client_id = onboarded.json()["client_id"]
        sales = bearer(weblaud, "jubayed@weblaud.com")
        assert weblaud.http.delete(f"/api/v1/clients/{client_id}", headers=sales).status_code == 403
        # The client is still there.
        assert weblaud.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).status_code == 200

    async def test_sales_ops_cannot_read_server_logs_or_provision(self, weblaud: Hub):
        client_id = weblaud.onboard().json()["client_id"]
        sales = bearer(weblaud, "jubayed@weblaud.com")
        assert weblaud.http.get(f"/api/v1/clients/{client_id}/logs", headers=sales).status_code == 403
        body = {
            "company_name": "Nope Co", "subdomain": "nope",
            "openrouter_api_key": "sk-or-v1-tenant-secret-key", "contact_email": "a@nope.example.com",
        }
        assert weblaud.http.post("/api/v1/clients/onboard", json=body, headers=sales).status_code == 403

    async def test_sales_ops_can_reach_the_crm(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        assert weblaud.http.get("/api/v1/crm/prospects", headers=sales).status_code == 200

    async def test_a_super_admin_can_terminate(self, weblaud: Hub):
        client_id = weblaud.onboard().json()["client_id"]
        admin = bearer(weblaud, "ishtiaq@weblaud.com")
        assert weblaud.http.delete(f"/api/v1/clients/{client_id}", headers=admin).status_code in (200, 202, 204)

    async def test_an_owner_cannot_use_the_agency_api(self, weblaud: Hub):
        owner = bearer(weblaud, "owner@suvana.com")
        assert weblaud.http.get("/api/v1/clients", headers=owner).status_code == 403
        assert weblaud.http.get("/api/v1/crm/prospects", headers=owner).status_code == 403

    async def test_an_owner_reads_their_own_tenant(self, weblaud: Hub):
        owner = bearer(weblaud, "owner@apex-dental.com")
        response = weblaud.http.get("/api/v1/portal/apex-dental/profile", headers=owner)
        assert response.status_code == 200
        assert response.json()["business_mode"] == "general"

    @pytest.mark.parametrize(
        "email, other",
        [("owner@suvana.com", "apex-dental"), ("owner@apex-dental.com", "suvana")],
    )
    @pytest.mark.parametrize("path", ["profile", "roi", "approvals", "social-autopilot", "roster"])
    async def test_an_owner_is_forbidden_every_other_tenant(self, weblaud: Hub, email, other, path):
        headers = bearer(weblaud, email)
        assert weblaud.http.get(f"/api/v1/portal/{other}/{path}", headers=headers).status_code == 403

    async def test_an_owner_cannot_publish_to_another_tenant(self, weblaud: Hub):
        headers = bearer(weblaud, "owner@suvana.com")
        response = weblaud.http.post("/api/v1/portal/apex-dental/social-autopilot/generate-now", headers=headers)
        assert response.status_code == 403

    async def test_an_unknown_subdomain_looks_the_same_as_a_forbidden_one(self, weblaud: Hub):
        headers = bearer(weblaud, "owner@suvana.com")
        assert weblaud.http.get("/api/v1/portal/no-such-business/profile", headers=headers).status_code == 403


class TestMagicOtp:
    async def test_the_demo_code_signs_an_owner_in(self, weblaud: Hub):
        sent = weblaud.http.post(
            "/api/v1/auth/magic-otp/request", json={"identifier": "owner@apex-dental.com", "subdomain": "apex-dental"}
        )
        assert sent.status_code == 200
        assert sent.json()["simulated_code"] == "246810"
        verified = weblaud.http.post(
            "/api/v1/auth/magic-otp/verify",
            json={"identifier": "owner@apex-dental.com", "subdomain": "apex-dental", "code": "246810"},
        )
        assert verified.status_code == 200
        assert verified.json()["user"]["client_subdomain"] == "apex-dental"
        weblaud.http.cookies.clear()

    async def test_a_code_is_only_good_for_its_own_portal(self, weblaud: Hub):
        sent = weblaud.http.post(
            "/api/v1/auth/magic-otp/request", json={"identifier": "owner@suvana.com", "subdomain": "apex-dental"}
        )
        # Same answer as for an account that does not exist, and no code in it.
        assert sent.status_code == 200
        assert sent.json()["simulated_code"] is None
        verified = weblaud.http.post(
            "/api/v1/auth/magic-otp/verify",
            json={"identifier": "owner@suvana.com", "subdomain": "apex-dental", "code": "246810"},
        )
        assert verified.status_code == 401

    async def test_a_wrong_code_is_refused(self, weblaud: Hub):
        weblaud.http.post("/api/v1/auth/magic-otp/request", json={"identifier": "owner@suvana.com"})
        wrong = weblaud.http.post(
            "/api/v1/auth/magic-otp/verify", json={"identifier": "owner@suvana.com", "code": "111111"}
        )
        assert wrong.status_code == 401

    async def test_verify_needs_a_code(self, weblaud: Hub):
        response = weblaud.http.post("/api/v1/auth/magic-otp/verify", json={"identifier": "owner@suvana.com"})
        assert response.status_code == 422

    async def test_a_code_works_once(self, weblaud: Hub):
        weblaud.http.post("/api/v1/auth/magic-otp/request", json={"identifier": "owner@suvana.com"})
        body = {"identifier": "owner@suvana.com", "code": "246810"}
        assert weblaud.http.post("/api/v1/auth/magic-otp/verify", json=body).status_code == 200
        weblaud.http.cookies.clear()
        assert weblaud.http.post("/api/v1/auth/magic-otp/verify", json=body).status_code == 401

    async def test_the_combined_endpoint_still_works(self, weblaud: Hub):
        sent = weblaud.http.post("/api/v1/auth/magic-otp", json={"identifier": "owner@suvana.com"})
        assert sent.json()["simulated_code"] == "246810"

    async def test_codes_are_refused_when_delivery_is_not_simulated(self, hub: Hub):
        hub.settings.environment = "staging"
        response = hub.http.post("/api/v1/auth/magic-otp/request", json={"identifier": "owner@suvana.com"})
        assert response.status_code == 503


# ======================================================================
# Part 2: the dual business model
# ======================================================================
class TestBusinessModel:
    def test_the_eleven_specialists_exist_with_matching_names(self):
        for name in SPEC_SKILLS:
            manifest = SKILLS / name / "SKILL.md"
            assert manifest.is_file(), name
            text = manifest.read_text(encoding="utf-8")
            assert re.search(rf"^name: {re.escape(name)}$", text, re.M), name
            assert re.search(r"^description: .{40,}", text, re.M), name

    def test_the_social_autopilot_ships_both_scripts(self):
        assert (SCRIPTS / "generate_social_visual.py").is_file()
        assert (SCRIPTS / "meta_publisher.py").is_file()

    async def test_an_ecommerce_client_carries_the_whole_profile(self, weblaud: Hub):
        kit = {
            "primary_color": "#FF5733", "accent_color": "#112233", "logo_text": "NOVA",
            "contact_cta": "Order via DM", "website_url": "https://nova.example.com",
        }
        response = weblaud.onboard(
            company_name="Nova Store", subdomain="nova", business_mode="ecommerce",
            niche_template="ecommerce_store", package_tier="scale", autopilot_social=False, brand_kit=kit,
            baseline_metrics={
                "monthly_inquiries": 50, "conversion_rate": 10.0,
                "avg_customer_profit": 150.0, "monthly_investment": 599.0,
            },
        )
        assert response.status_code == 201, response.text
        row = weblaud.http.get(f"/api/v1/clients/{response.json()['client_id']}", headers=AUTH).json()
        assert row["business_mode"] == "ecommerce"
        assert row["niche_template"] == "ecommerce_store"
        assert row["package_tier"] == "scale"
        assert row["currency"] == "USD"
        assert row["onboarding_stage"] in range(1, 8)
        assert row["autopilot_social"] is False
        assert row["brand_kit_json"] == kit
        # The brief's names are accepted and stored under the ones the hub reads.
        assert row["baseline_metrics_json"] == {
            "monthly_inquiries": 50, "conversion_rate": 10.0,
            "avg_order_or_profit_value": 150.0, "monthly_retainer_investment": 599.0,
        }

    async def test_a_new_client_starts_on_the_zero_touch_autopilot(self, weblaud: Hub):
        row = weblaud.http.get(f"/api/v1/clients/{weblaud.onboard().json()['client_id']}", headers=AUTH).json()
        assert row["autopilot_social"] is True
        assert row["business_mode"] == "general"

    @pytest.mark.parametrize("color", ["red", "#12345", "#GGGGGG", "00F5D4"])
    async def test_a_brand_colour_must_be_a_hex_code(self, weblaud: Hub, color: str):
        response = weblaud.onboard(brand_kit={"primary_color": color})
        assert response.status_code == 422

    async def test_a_brand_website_must_be_http(self, weblaud: Hub):
        assert weblaud.onboard(brand_kit={"website_url": "javascript:alert(1)"}).status_code == 422

    async def test_the_package_tier_sets_the_plan(self, weblaud: Hub):
        response = weblaud.onboard(package_tier="presence")
        row = weblaud.http.get(f"/api/v1/clients/{response.json()['client_id']}", headers=AUTH).json()
        assert (row["plan"], row["package_tier"]) == ("starter", "presence")

    async def test_the_roster_follows_the_business_model(self, weblaud: Hub):
        general = weblaud.http.get(
            "/api/v1/portal/apex-dental/roster", headers=bearer(weblaud, "owner@apex-dental.com")
        ).json()
        assert general["business_mode"] == "general"
        active = [agent["name"] for agent in general["rosters"]["general"] if agent["active"]]
        assert "Social Media Autopilot" in active
        assert "Order Desk" not in {a["name"] for a in general["rosters"]["general"]}
        # The other model's roster is a preview: nothing in it is switched on.
        assert not any(agent["active"] for agent in general["rosters"]["ecommerce"])
        assert {"Order Desk", "Catalog Keeper"} <= {a["name"] for a in general["rosters"]["ecommerce"]}

        shop = weblaud.http.get(
            "/api/v1/portal/suvana/roster", headers=bearer(weblaud, "owner@suvana.com")
        ).json()
        assert shop["business_mode"] == "ecommerce"
        assert {"Order Desk", "Catalog Keeper"} <= {a["name"] for a in shop["rosters"]["ecommerce"] if a["active"]}


# ======================================================================
# Part 3: the two scripts
# ======================================================================
class TestVisualGenerator:
    def test_it_draws_a_1080_square_branded_png(self, tmp_path: Path):
        module = load_script("generate_social_visual")
        from PIL import Image

        result = module.generate_branded_post(
            brand_name="Apex Dental", business_mode="general", prompt="clinic",
            headline="Brighter smiles start here", subtext="Ask about whitening",
            cta_text="Book via WhatsApp", output_path=tmp_path / "post.png",
        )
        assert result["status"] == "ok"
        assert result["engine"] == "studio_canvas_overlay"
        with Image.open(result["output_path"]) as image:
            assert image.size == (1080, 1080)
            assert image.format == "PNG"

    def test_the_brand_colour_is_what_gets_drawn(self, tmp_path: Path):
        module = load_script("generate_social_visual")
        from PIL import Image

        module.generate_branded_post(
            brand_name="X", business_mode="ecommerce", prompt="p", headline="H", subtext="s",
            cta_text="Go", primary_hex="#FF0000", output_path=tmp_path / "red.png",
        )
        with Image.open(tmp_path / "red.png") as image:
            # The CTA pill is filled with the primary colour.
            assert image.convert("RGB").getpixel((120, 1080 - 190 + 10)) == (255, 0, 0)

    def test_a_bad_hex_falls_back_to_the_default(self):
        module = load_script("generate_social_visual")
        assert module._hex_to_rgb("not-a-colour") == (0, 245, 212)
        assert module._hex_to_rgb("#6366F1") == (99, 102, 241)

    def test_the_svg_fallback_escapes_client_text(self, tmp_path: Path, monkeypatch):
        module = load_script("generate_social_visual")
        monkeypatch.setattr(module, "PIL_AVAILABLE", False)
        result = module.generate_branded_post(
            brand_name="A&B <Co>", business_mode="general", prompt="p",
            headline="<script>alert(1)</script>", subtext="x", cta_text="Go",
            primary_hex='"/><script>', output_path=tmp_path / "post.png",
        )
        assert result["engine"] == "svg_fallback"
        svg = Path(result["output_path"]).read_text(encoding="utf-8")
        assert "<script>" not in svg
        assert "&lt;script&gt;" in svg
        assert "A&amp;B" in svg

    def test_it_runs_as_a_command_line_tool(self, tmp_path: Path):
        import json
        import subprocess

        done = subprocess.run(
            [sys.executable, "-I", str(SCRIPTS / "generate_social_visual.py"), "--prompt", "p",
             "--headline", "Hello", "--output", str(tmp_path / "cli.png")],
            capture_output=True, text=True, check=True,
        )
        assert json.loads(done.stdout.splitlines()[-1])["status"] == "ok"
        assert (tmp_path / "cli.png").is_file()


class TestMetaPublisher:
    @pytest.fixture(autouse=True)
    def _no_meta_env(self, monkeypatch):
        for key in ("META_PAGE_ACCESS_TOKEN", "META_PAGE_ID", "META_IG_USER_ID"):
            monkeypatch.delenv(key, raising=False)

    def test_without_credentials_it_records_a_sandbox_receipt(self):
        module = load_script("meta_publisher")
        out = module.publish_social_post(
            image_url_or_path="/tmp/x.png", caption="Hello", platforms=["facebook", "instagram"]
        )
        assert out["status"] == "published_simulated"
        assert out["mode"] == "sandbox_autopilot"
        assert out["post_id"].startswith("post_")
        assert out["permalink"].startswith("https://facebook.com/")

    def test_a_reply_without_credentials_is_simulated_too(self):
        module = load_script("meta_publisher")
        out = module.auto_reply_and_dm_comment(comment_id="c1", public_reply="Thanks", private_dm_text="Hi")
        assert out["status"] == "replied_simulated"

    def test_live_publishing_calls_graph_in_the_documented_order(self, monkeypatch):
        module = load_script("meta_publisher")
        calls: list[tuple[str, dict]] = []

        def fake_post(endpoint, payload, access_token):
            calls.append((endpoint, payload))
            assert access_token == "tok"
            return {"id": "creation-1"} if endpoint.endswith("/media") else {"id": "published-1"}

        monkeypatch.setattr(module, "_graph_post", fake_post)
        out = module.publish_social_post(
            image_url_or_path="https://cdn.example.com/p.png", caption="Hi",
            platforms=["facebook", "instagram"], page_id="PAGE", ig_user_id="IG", access_token="tok",
        )
        assert out["status"] == "published_live"
        assert [endpoint for endpoint, _ in calls] == ["PAGE/photos", "IG/media", "IG/media_publish"]
        assert calls[2][1] == {"creation_id": "creation-1"}

    def test_live_comment_replies_go_public_then_private(self, monkeypatch):
        module = load_script("meta_publisher")
        calls = []
        monkeypatch.setattr(module, "_graph_post", lambda e, p, t: calls.append(e) or {"id": "x"})
        out = module.auto_reply_and_dm_comment(
            comment_id="C9", public_reply="Thanks", private_dm_text="Hi", access_token="tok"
        )
        assert out["status"] == "replied_live"
        assert calls == ["C9/comments", "C9/private_replies"]


# ======================================================================
# Part 4: the social autopilot through the portal
# ======================================================================
def owner_of(hub: Hub, slug: str) -> dict[str, str]:
    return bearer(hub, "owner@suvana.com" if slug == "suvana" else "owner@apex-dental.com")


def generate(hub: Hub, slug: str):
    return hub.http.post(f"/api/v1/portal/{slug}/social-autopilot/generate-now", headers=owner_of(hub, slug))


class TestGenerateNow:
    async def test_zero_touch_publishes_a_branded_post_straight_away(self, weblaud: Hub):
        response = generate(weblaud, "apex-dental")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["outcome"] == "published"
        post = body["post"]
        assert post["status"] == "published"
        # No Meta credentials are set in tests, so this is the sandbox, and says so.
        assert post["publish_mode"] == "sandbox"
        assert "sandbox" in body["message"].lower()
        assert post["has_image"] is True
        assert post["platforms"] == ["facebook", "instagram"]
        assert post["hashtags"] and all(tag.startswith("#") for tag in post["hashtags"])
        assert "Book via WhatsApp or DM" in post["caption"]
        # Reach is unknown rather than invented.
        assert post["reach"] is None

    async def test_the_comment_to_dm_stream_names_who_took_over(self, weblaud: Hub):
        comments = generate(weblaud, "apex-dental").json()["comments"]
        assert comments
        assert comments[0]["text"] == "How much is the Teeth Whitening package?"
        assert comments[0]["handoff_to"] == "Sales Rep"
        assert comments[0]["public_reply"] and comments[0]["dm_text"]
        assert all(comment["sample"] for comment in comments)
        # A reply never quotes a price the business has not published.
        assert not any(re.search(r"[$€£]\s?\d", comment["public_reply"] + comment["dm_text"]) for comment in comments)

    async def test_an_ecommerce_comment_goes_to_the_order_desk(self, weblaud: Hub):
        client_id = client_id_of(weblaud, "suvana")
        assert weblaud.http.patch(
            f"/api/v1/clients/{client_id}", headers=AUTH, json={"onboarding_stage": 7}
        ).status_code == 200
        comments = generate(weblaud, "suvana").json()["comments"]
        assert comments[0]["text"] == "Do you have Size L in stock?"
        assert comments[0]["handoff_to"] == "Order Desk"

    async def test_the_visual_is_served_to_its_owner_as_a_1080_png(self, weblaud: Hub):
        from PIL import Image

        post = generate(weblaud, "apex-dental").json()["post"]
        headers = owner_of(weblaud, "apex-dental")
        image = weblaud.http.get(f"/api/v1/portal/apex-dental/social-autopilot/media/{post['id']}", headers=headers)
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        assert image.headers["x-content-type-options"] == "nosniff"
        with Image.open(io.BytesIO(image.content)) as decoded:
            assert decoded.size == (1080, 1080)

    async def test_another_business_cannot_fetch_the_visual(self, weblaud: Hub):
        post = generate(weblaud, "apex-dental").json()["post"]
        other = owner_of(weblaud, "suvana")
        forbidden = weblaud.http.get(f"/api/v1/portal/apex-dental/social-autopilot/media/{post['id']}", headers=other)
        assert forbidden.status_code == 403
        # Nor by asking for it under their own path.
        missing = weblaud.http.get(f"/api/v1/portal/suvana/social-autopilot/media/{post['id']}", headers=other)
        assert missing.status_code == 404

    async def test_the_posts_grid_lists_new_work_first_with_counts(self, weblaud: Hub):
        generate(weblaud, "apex-dental")
        view = weblaud.http.get(
            "/api/v1/portal/apex-dental/social-autopilot", headers=owner_of(weblaud, "apex-dental")
        ).json()
        assert view["autopilot_social"] is True
        assert view["live_publishing"] is False
        newest = view["posts"][0]
        assert newest["demo"] is False
        assert newest["comments_replied"] == newest["leads_captured"] >= 1
        assert any(post["demo"] for post in view["posts"])  # the seeded samples are labelled
        assert view["comments"][0]["post_id"] == newest["id"]

    async def test_shadow_week_goes_to_qa_before_anything_is_published(self, weblaud: Hub):
        body = generate(weblaud, "suvana").json()  # seeded at step 6, Shadow Week
        assert body["outcome"] == "in_qa_review"
        assert body["post"]["status"] == "awaiting_approval"
        assert body["post"]["publish_mode"] is None
        assert body["comments"] == []
        queue = weblaud.http.get("/api/v1/qa/queue", headers=AUTH).json()
        assert any(row["title"] == body["post"]["headline"] for row in queue)

    async def test_one_tap_mode_waits_for_the_owner_then_publishes(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        toggled = weblaud.http.patch(
            "/api/v1/portal/apex-dental/social-autopilot/settings", headers=headers, json={"autopilot_social": False}
        )
        assert toggled.status_code == 200
        assert toggled.json()["autopilot_social"] is False

        body = generate(weblaud, "apex-dental").json()
        assert body["outcome"] == "awaiting_owner"
        assert body["post"]["status"] == "awaiting_approval"

        pending = [
            item for item in weblaud.http.get("/api/v1/portal/apex-dental/approvals", headers=headers).json()
            if item["kind"] == "social_post" and item["status"] == "pending_owner"
        ]
        assert len(pending) == 1
        decided = weblaud.http.post(
            f"/api/v1/portal/apex-dental/approvals/{pending[0]['id']}/decide", headers=headers,
            json={"decision": "approve"},
        )
        assert decided.status_code == 200
        view = weblaud.http.get("/api/v1/portal/apex-dental/social-autopilot", headers=headers).json()
        published = next(post for post in view["posts"] if post["id"] == body["post"]["id"])
        assert published["status"] == "published"
        assert published["comments_replied"] >= 1

    async def test_rejecting_the_approval_drops_the_post(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        weblaud.http.patch(
            "/api/v1/portal/apex-dental/social-autopilot/settings", headers=headers, json={"autopilot_social": False}
        )
        body = generate(weblaud, "apex-dental").json()
        item = next(
            row for row in weblaud.http.get("/api/v1/portal/apex-dental/approvals", headers=headers).json()
            if row["title"] == body["post"]["headline"] and row["status"] == "pending_owner"
        )
        assert weblaud.http.post(
            f"/api/v1/portal/apex-dental/approvals/{item['id']}/decide", headers=headers, json={"decision": "reject"}
        ).status_code == 200
        view = weblaud.http.get("/api/v1/portal/apex-dental/social-autopilot", headers=headers).json()
        assert next(post for post in view["posts"] if post["id"] == body["post"]["id"])["status"] == "rejected"

    async def test_the_toggle_and_the_guardrail_lane_cannot_disagree(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        lane = lambda: next(  # noqa: E731
            row for row in weblaud.http.get("/api/v1/portal/apex-dental/guardrails", headers=headers).json()
            if row["key"] == "social_posts"
        )["lane"]
        assert lane() == "automatic"
        weblaud.http.patch(
            "/api/v1/portal/apex-dental/social-autopilot/settings", headers=headers, json={"autopilot_social": False}
        )
        assert lane() == "owner"
        weblaud.http.put("/api/v1/portal/apex-dental/guardrails/social_posts", headers=headers, json={"lane": "automatic"})
        view = weblaud.http.get("/api/v1/portal/apex-dental/social-autopilot", headers=headers).json()
        assert view["autopilot_social"] is True

    async def test_the_brand_kit_can_be_changed_and_is_used(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        kit = {"primary_color": "#FF8800", "accent_color": "#0044FF", "logo_text": "APEX", "contact_cta": "Call us today"}
        patched = weblaud.http.patch(
            "/api/v1/portal/apex-dental/social-autopilot/settings", headers=headers, json={"brand_kit": kit}
        )
        assert patched.status_code == 200
        assert patched.json()["brand_kit"]["primary_color"] == "#FF8800"
        assert "Call us today" in generate(weblaud, "apex-dental").json()["post"]["caption"]

    @pytest.mark.parametrize("kit", [{"primary_color": "orange"}, {"website_url": "ftp://x"}, {"logo_text": ""}, {"extra": 1}])
    async def test_a_bad_brand_kit_is_refused(self, weblaud: Hub, kit):
        response = weblaud.http.patch(
            "/api/v1/portal/apex-dental/social-autopilot/settings",
            headers=owner_of(weblaud, "apex-dental"), json={"brand_kit": kit},
        )
        assert response.status_code == 422

    async def test_a_missing_script_fails_politely_and_leaks_nothing(self, weblaud: Hub, tmp_path):
        weblaud.settings.shared_skills_dir = tmp_path / "empty"
        response = generate(weblaud, "apex-dental")
        assert response.status_code == 503
        text = response.text.lower()
        assert response.json()["error"] == "social_unavailable"
        assert "generate_social_visual" not in text and str(tmp_path).lower() not in text

    async def test_generation_is_rate_limited(self, weblaud: Hub):
        statuses = [generate(weblaud, "apex-dental").status_code for _ in range(social_router._generate_limit.limit + 1)]
        assert statuses[-1] == 429
        assert set(statuses[:-1]) == {200}


# ======================================================================
# Part 4: the ROI funnel and one-tap approvals
# ======================================================================
class TestRoiFunnel:
    async def test_the_worked_example_for_the_dental_demo(self, weblaud: Hub):
        report = weblaud.http.get(
            "/api/v1/portal/apex-dental/roi", headers=owner_of(weblaud, "apex-dental")
        ).json()
        assert report["currency"] == "USD"
        assert report["baseline"] == {
            "monthly_inquiries": 50, "conversion_rate": 10.0,
            "avg_order_or_profit_value": 150.0, "monthly_retainer_investment": 599.0,
        }
        funnel = report["funnel"]
        assert (funnel["total_inquiries"], funnel["qualified_leads"], funnel["confirmed_outcomes"]) == (140, 82, 31)
        result = report["result"]
        # Baseline: 50 x 10% = 5 outcomes. Now 31 at 150 each, so +26 outcomes = 3,900.
        assert result["baseline_outcomes"] == 5
        assert result["incremental_gross_profit"] == 3900
        # Investment: 599 retainer + 250 ads = 849. Net 3,051. ROI 3,051 / 849 = 359.36%.
        assert result["total_investment"] == 849
        assert result["net_value"] == 3051
        assert result["roi_percent"] == 359.36

    async def test_the_funnel_narrows_at_every_stage(self, weblaud: Hub):
        funnel = weblaud.http.get(
            "/api/v1/portal/apex-dental/roi", headers=owner_of(weblaud, "apex-dental")
        ).json()["funnel"]
        assert funnel["total_inquiries"] >= funnel["qualified_leads"] >= funnel["confirmed_outcomes"]
        assert funnel["conversion_rate"] == round(31 / 140 * 100, 2)

    async def test_entering_a_month_changes_the_result(self, weblaud: Hub):
        client_id = client_id_of(weblaud, "apex-dental")
        entered = weblaud.http.put(
            f"/api/v1/clients/{client_id}/roi/2026-10", headers=AUTH,
            json={"total_inquiries": 100, "qualified_leads": 60, "confirmed_outcomes": 20, "ad_spend": 0},
        )
        assert entered.status_code == 200, entered.text
        report = weblaud.http.get(
            "/api/v1/portal/apex-dental/roi?period=2026-10", headers=owner_of(weblaud, "apex-dental")
        ).json()
        # (20 - 5) x 150 = 2,250 gained for a 599 retainer: net 1,651, ROI 275.63%.
        assert report["result"]["incremental_gross_profit"] == 2250
        assert report["result"]["roi_percent"] == 275.63

    async def test_a_month_with_no_figures_has_no_invented_result(self, weblaud: Hub):
        report = weblaud.http.get(
            "/api/v1/portal/apex-dental/roi?period=2020-01", headers=owner_of(weblaud, "apex-dental")
        ).json()
        assert report["result"] is None and report["funnel"] is None


class TestOneTapApprovals:
    def pending(self, hub: Hub, headers: dict[str, str]) -> list[dict]:
        rows = hub.http.get("/api/v1/portal/apex-dental/approvals", headers=headers).json()
        return [row for row in rows if row["status"] == "pending_owner"]

    def decide(self, hub: Hub, headers, item_id: str, decision: str, note: str | None = None):
        return hub.http.post(
            f"/api/v1/portal/apex-dental/approvals/{item_id}/decide", headers=headers,
            json={"decision": decision, "note": note},
        )

    async def test_the_three_lanes_are_listed(self, weblaud: Hub):
        lanes = weblaud.http.get(
            "/api/v1/portal/apex-dental/guardrails", headers=owner_of(weblaud, "apex-dental")
        ).json()
        assert {row["lane"] for row in lanes} == {"automatic", "owner", "never"}
        by_key = {row["key"]: row for row in lanes}
        assert by_key["ad_boosts"]["lane"] == "owner" and by_key["ad_boosts"]["promotable"] is False
        assert by_key["refunds"]["lane"] == "never"

    async def test_approve_moves_pending_to_approved(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, headers)[0]
        body = self.decide(weblaud, headers, item["id"], "approve").json()
        assert body["status"] == "approved"
        assert body["decided_at"]

    async def test_modify_needs_an_instruction_and_returns_to_the_team(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, headers)[0]
        assert self.decide(weblaud, headers, item["id"], "edit").status_code in (400, 422)
        body = self.decide(weblaud, headers, item["id"], "edit", "Lower the budget to 10 a day").json()
        assert body["status"] == "changes_requested"
        assert body["note"] == "Lower the budget to 10 a day"

    async def test_reject_needs_no_reason(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, headers)[0]
        assert self.decide(weblaud, headers, item["id"], "reject").json()["status"] == "rejected"

    async def test_a_decision_is_final(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, headers)[0]
        self.decide(weblaud, headers, item["id"], "approve")
        again = self.decide(weblaud, headers, item["id"], "reject")
        assert again.status_code == 409

    async def test_an_owner_cannot_decide_another_tenants_item(self, weblaud: Hub):
        mine = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, mine)[0]
        theirs = owner_of(weblaud, "suvana")
        assert weblaud.http.post(
            f"/api/v1/portal/apex-dental/approvals/{item['id']}/decide", headers=theirs, json={"decision": "approve"}
        ).status_code == 403
        assert weblaud.http.post(
            f"/api/v1/portal/suvana/approvals/{item['id']}/decide", headers=theirs, json={"decision": "approve"}
        ).status_code == 404

    async def test_an_unknown_decision_is_refused(self, weblaud: Hub):
        headers = owner_of(weblaud, "apex-dental")
        item = self.pending(weblaud, headers)[0]
        assert self.decide(weblaud, headers, item["id"], "maybe").status_code == 422


# ======================================================================
# Part 5: CRM and the stand-up board
# ======================================================================
class TestProspectCrm:
    async def test_the_five_signals_score_one_each(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        response = weblaud.http.post(
            "/api/v1/crm/prospects", headers=sales,
            json={
                "business_name": "Bright Smile", "niche": "dental_clinic", "assignee": "jubayed",
                "no_website": True, "irregular_social": True, "slow_reply": True,
                "repeat_high_value_sales": True, "accessible_owner": True,
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["priority_score"] == 5
        assert response.json()["stage"] == "new"

    @pytest.mark.parametrize(
        "flags, score",
        [
            ({}, 1),  # floored at 1 so every prospect sits on the 1-5 scale
            ({"no_website": True}, 1),
            ({"no_website": True, "slow_reply": True}, 2),
            ({"irregular_social": True, "repeat_high_value_sales": True, "accessible_owner": True}, 3),
        ],
    )
    async def test_the_score_is_the_count_of_signals_with_a_floor_of_one(self, weblaud: Hub, flags, score):
        created = weblaud.http.post(
            "/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Scored Co", **flags}
        ).json()
        assert created["priority_score"] == score

    async def test_the_score_follows_an_edit(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        prospect = weblaud.http.post("/api/v1/crm/prospects", headers=sales, json={"business_name": "Edit Me"}).json()
        patched = weblaud.http.patch(
            f"/api/v1/crm/prospects/{prospect['id']}", headers=sales, json={"no_website": True, "accessible_owner": True}
        ).json()
        assert patched["priority_score"] == 2

    async def test_a_prospect_walks_the_whole_pipeline(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        prospect = weblaud.http.post("/api/v1/crm/prospects", headers=sales, json={"business_name": "Pipeline Co"}).json()
        for stage in ("qualified", "contacted", "video_audit_sent", "meeting", "proposal", "won"):
            body = weblaud.http.patch(f"/api/v1/crm/prospects/{prospect['id']}", headers=sales, json={"stage": stage})
            assert body.status_code == 200 and body.json()["stage"] == stage

    async def test_the_pipeline_target_is_one_hundred(self, weblaud: Hub):
        body = weblaud.http.get("/api/v1/crm/prospects", headers=bearer(weblaud, "jubayed@weblaud.com")).json()
        assert body["target"] == 100

    async def test_the_standup_board_has_the_three_members(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        board = weblaud.http.get("/api/v1/crm/standup?day=2026-11-09", headers=sales).json()
        members = {member["key"]: member for member in board["members"]}
        assert set(members) == {"sakib", "jubayed", "ishtiaq"}
        targets = {metric["key"]: metric["target"] for metric in members["jubayed"]["metrics"]}
        assert targets["new_leads"] == 15 and targets["follow_ups"] == 10

    async def test_ticking_a_task_updates_completion(self, weblaud: Hub):
        sales = bearer(weblaud, "jubayed@weblaud.com")
        before = weblaud.http.get("/api/v1/crm/standup?day=2026-11-09", headers=sales).json()
        start = next(m for m in before["members"] if m["key"] == "jubayed")["completion_percent"]
        updated = weblaud.http.put(
            "/api/v1/crm/standup/2026-11-09/jubayed/new_leads", headers=sales, json={"done": 15}
        )
        assert updated.status_code == 200, updated.text
        after = weblaud.http.get("/api/v1/crm/standup?day=2026-11-09", headers=sales).json()
        member = next(m for m in after["members"] if m["key"] == "jubayed")
        assert member["completion_percent"] > start
        assert next(m for m in member["metrics"] if m["key"] == "new_leads")["done"] == 15
        # Another day is untouched.
        other = weblaud.http.get("/api/v1/crm/standup?day=2026-11-10", headers=sales).json()
        assert next(m for m in other["members"] if m["key"] == "jubayed")["completion_percent"] == start
