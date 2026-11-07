"""ROI arithmetic, the approval state machine, guardrails, CRM and the skill library."""

from __future__ import annotations

import pytest
import pytest_asyncio
import yaml

from conftest import AUTH, Hub
from src.auth import service as auth_service
from src.auth.models import UserRole
from src.clients.skills import ECOMMERCE_SKILLS, available_skills, skills_for_client
from src.config.settings import REPO_ROOT
from src.ops import approvals as approval_service
from src.ops.approvals import ApprovalTransitionError
from src.ops.crm import PIPELINE_TARGET, priority_score
from src.ops.demo import DEMO_BASELINE
from src.ops.models import ApprovalItem, ApprovalKind, ApprovalStatus, Prospect
from src.ops.roi import calculate_roi

PASSWORD = "correct-horse-battery"
BASELINE = {
    "monthly_inquiries": 200,
    "conversion_rate": 10.0,
    "avg_order_or_profit_value": 500.0,
    "monthly_retainer_investment": 10000.0,
}


def sign_in(hub: Hub, email: str) -> dict[str, str]:
    response = hub.http.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    hub.http.cookies.clear()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def onboard(hub: Hub, slug: str = "acme", **fields) -> tuple[str, dict[str, str]]:
    """A client and an access link for its owner."""
    response = hub.onboard(company_name=f"{slug.title()} Co", subdomain=slug, **fields)
    assert response.status_code == 201, response.text
    client_id = response.json()["client_id"]
    token = hub.http.post(f"/api/v1/clients/{client_id}/portal-token", headers=AUTH).json()["token"]
    return client_id, {"X-Client-Portal-Token": token}


def set_stage(hub: Hub, client_id: str, stage: int) -> None:
    response = hub.http.patch(f"/api/v1/clients/{client_id}", headers=AUTH, json={"onboarding_stage": stage})
    assert response.status_code == 200, response.text


def draft(hub: Hub, client_id: str, kind: str = "partner_email", title: str = "A draft", **fields) -> dict:
    response = hub.http.post(
        f"/api/v1/clients/{client_id}/approvals", headers=AUTH, json={"kind": kind, "title": title, **fields}
    )
    assert response.status_code == 201, response.text
    return response.json()


def decide(hub: Hub, slug: str, item_id: str, owner: dict, decision: str, note: str | None = None):
    return hub.http.post(
        f"/api/v1/portal/{slug}/approvals/{item_id}/decide",
        headers=owner,
        json={"decision": decision, "note": note},
    )


def qa(hub: Hub, client_id: str, item_id: str, decision: str, note: str | None = None):
    return hub.http.post(
        f"/api/v1/clients/{client_id}/approvals/{item_id}/qa",
        headers=AUTH,
        json={"decision": decision, "note": note},
    )


# ======================================================================
# the arithmetic
# ======================================================================
class TestCalculateRoi:
    def test_the_worked_example(self):
        # 420 x 8% = 33.6 baseline outcomes, worth 21,840 at 650 each.
        # 118 outcomes are worth 76,700, so the increase is 54,860.
        # Investment 25,000 + 18,000 = 43,000, leaving 11,860: 27.58%.
        result = calculate_roi(
            monthly_inquiries=420,
            conversion_rate=8.0,
            avg_value=650,
            retainer=25_000,
            confirmed_outcomes=118,
            ad_spend=18_000,
        )
        assert result.baseline_outcomes == 33.6
        assert result.baseline_gross_profit == 21_840
        assert result.current_gross_profit == 76_700
        assert result.incremental_gross_profit == 54_860
        assert result.total_investment == 43_000
        assert result.net_value == 11_860
        assert result.roi_percent == 27.58

    def test_a_losing_month_is_reported_as_a_loss(self):
        result = calculate_roi(
            monthly_inquiries=100, conversion_rate=10, avg_value=100,
            retainer=1000, confirmed_outcomes=5, ad_spend=0,
        )
        assert result.incremental_gross_profit == -500
        assert result.net_value == -1500
        assert result.roi_percent == -150

    def test_no_investment_has_no_percentage(self):
        result = calculate_roi(
            monthly_inquiries=10, conversion_rate=10, avg_value=10,
            retainer=0, confirmed_outcomes=2, ad_spend=0,
        )
        assert result.roi_percent is None
        assert result.net_value == 10

    def test_break_even_is_zero_not_a_rounding_artifact(self):
        result = calculate_roi(
            monthly_inquiries=100, conversion_rate=10, avg_value=100,
            retainer=1000, confirmed_outcomes=20, ad_spend=0,
        )
        assert result.net_value == 0
        assert result.roi_percent == 0

    def test_decimal_inputs_do_not_pick_up_binary_float_error(self):
        # In floats, 0.1 * 3 is 0.30000000000000004.
        result = calculate_roi(
            monthly_inquiries=1000, conversion_rate=0.1, avg_value=0.1,
            retainer=0.1, confirmed_outcomes=3, ad_spend=0.2,
        )
        assert result.total_investment == 0.3
        assert result.current_gross_profit == 0.3

    def test_half_cents_round_up(self):
        result = calculate_roi(
            monthly_inquiries=1, conversion_rate=0.5, avg_value=1,
            retainer=0, confirmed_outcomes=0, ad_spend=0,
        )
        assert result.baseline_gross_profit == 0.01


class TestRoiReport:
    def test_with_nothing_recorded_it_invents_nothing(self, hub: Hub):
        client_id, _ = onboard(hub)
        body = hub.http.get(f"/api/v1/clients/{client_id}/roi", headers=AUTH).json()
        assert body["baseline"] is None
        assert body["funnel"] is None
        assert body["result"] is None

    def test_month_without_baseline_has_a_funnel_but_no_roi(self, hub: Hub):
        client_id, _ = onboard(hub)
        response = hub.http.put(
            f"/api/v1/clients/{client_id}/roi/2026-10",
            headers=AUTH,
            json={"total_inquiries": 100, "qualified_leads": 40, "confirmed_outcomes": 20},
        )
        body = response.json()
        assert body["funnel"]["conversion_rate"] == 20.0
        assert body["result"] is None

    def test_the_full_report(self, hub: Hub):
        client_id, owner = onboard(hub, baseline_metrics=BASELINE, region_preset="bd", package_tier="growth")
        hub.http.put(
            f"/api/v1/clients/{client_id}/roi/2026-10",
            headers=AUTH,
            json={"total_inquiries": 300, "qualified_leads": 120, "confirmed_outcomes": 50, "ad_spend": 5000},
        )
        body = hub.http.get("/api/v1/portal/acme/roi?period=2026-10", headers=owner).json()
        assert body["currency"] == "BDT"
        assert body["available_periods"] == ["2026-10"]
        # 20 baseline outcomes at 500 is 10,000; 50 outcomes is 25,000.
        # Investment is the baseline retainer 10,000 + 5,000 ads.
        result = body["result"]
        assert result["incremental_gross_profit"] == 15_000
        assert result["total_investment"] == 15_000
        assert result["net_value"] == 0
        assert result["roi_percent"] == 0

    def test_a_month_can_override_retainer_and_value(self, hub: Hub):
        client_id, _ = onboard(hub, baseline_metrics=BASELINE)
        body = hub.http.put(
            f"/api/v1/clients/{client_id}/roi/2026-10",
            headers=AUTH,
            json={
                "total_inquiries": 100, "qualified_leads": 50, "confirmed_outcomes": 30,
                "avg_order_or_profit_value": 1000, "retainer": 2000,
            },
        ).json()
        assert body["result"]["value_per_outcome"] == 1000
        assert body["result"]["retainer"] == 2000

    def test_saving_a_month_twice_replaces_it(self, hub: Hub):
        client_id, _ = onboard(hub, baseline_metrics=BASELINE)
        for confirmed in (10, 25):
            body = hub.http.put(
                f"/api/v1/clients/{client_id}/roi/2026-10",
                headers=AUTH,
                json={"total_inquiries": 100, "qualified_leads": 50, "confirmed_outcomes": confirmed},
            ).json()
        assert body["funnel"]["confirmed_outcomes"] == 25
        assert body["available_periods"] == ["2026-10"]

    @pytest.mark.parametrize(
        "funnel",
        [
            {"total_inquiries": 10, "qualified_leads": 20, "confirmed_outcomes": 5},
            {"total_inquiries": 10, "qualified_leads": 5, "confirmed_outcomes": 8},
        ],
    )
    def test_a_funnel_cannot_widen(self, hub: Hub, funnel):
        client_id, _ = onboard(hub)
        response = hub.http.put(f"/api/v1/clients/{client_id}/roi/2026-10", headers=AUTH, json=funnel)
        assert response.status_code == 422

    @pytest.mark.parametrize("period", ["2026-13", "2026-1", "26-10", "abc"])
    def test_a_malformed_period_is_rejected(self, hub: Hub, period: str):
        client_id, _ = onboard(hub)
        response = hub.http.get(f"/api/v1/clients/{client_id}/roi?period={period}", headers=AUTH)
        assert response.status_code == 422

    def test_a_baseline_with_a_bad_rate_is_rejected(self, hub: Hub):
        response = hub.onboard(subdomain="bad-rate", baseline_metrics={**BASELINE, "conversion_rate": 140})
        assert response.status_code == 422

    def test_one_owner_cannot_read_anothers_roi(self, hub: Hub):
        onboard(hub, "first")
        _, second_owner = onboard(hub, "second", contact_email="b@second.example.com")
        response = hub.http.get("/api/v1/portal/first/roi", headers=second_owner)
        assert response.status_code == 401


# ======================================================================
# the approval state machine
# ======================================================================
class TestEntry:
    def test_before_autonomous_live_a_draft_goes_to_the_team_first(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 6)
        item = draft(hub, client_id)
        assert item["status"] == "qa_review"
        # And the owner does not see it yet.
        assert hub.http.get("/api/v1/portal/acme/approvals", headers=owner).json() == []

    def test_once_autonomous_a_draft_goes_to_the_owner(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        assert draft(hub, client_id)["status"] == "pending_owner"
        assert len(hub.http.get("/api/v1/portal/acme/approvals", headers=owner).json()) == 1

    def test_a_discount_offer_always_waits_for_the_owner(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        item = draft(hub, client_id, "discount_offer", "10% off whitening")
        assert item["status"] == "pending_owner"
        lanes = {row["key"]: row for row in hub.http.get("/api/v1/portal/acme/guardrails", headers=owner).json()}
        assert lanes["discount_offers"]["lane"] == "owner" and lanes["discount_offers"]["promotable"] is False
        assert lanes["price_changes"]["lane"] == "never"

    def test_courier_dispatch_is_refused_for_a_general_business(self, hub: Hub):
        client_id, _ = onboard(hub)
        response = hub.http.post(
            f"/api/v1/clients/{client_id}/approvals",
            headers=AUTH,
            json={"kind": "courier_dispatch", "title": "Twelve parcels"},
        )
        assert response.status_code == 422

    def test_courier_dispatch_is_accepted_for_e_commerce(self, hub: Hub):
        client_id, _ = onboard(hub, business_mode="ecommerce")
        assert draft(hub, client_id, "courier_dispatch")["kind"] == "courier_dispatch"


class TestOwnerDecisions:
    @pytest_asyncio.fixture
    async def pending(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        return client_id, owner, draft(hub, client_id)["id"]

    def test_approve(self, hub: Hub, pending):
        _, owner, item = pending
        response = decide(hub, "acme", item, owner, "approve")
        assert response.status_code == 200
        assert response.json()["status"] == "approved"
        assert response.json()["decided_at"]

    def test_edit_needs_an_instruction(self, hub: Hub, pending):
        _, owner, item = pending
        assert decide(hub, "acme", item, owner, "edit").status_code == 422
        assert decide(hub, "acme", item, owner, "edit", "   ").status_code == 422
        response = decide(hub, "acme", item, owner, "edit", "Use the blue photo.")
        assert response.status_code == 200
        assert response.json()["status"] == "changes_requested"
        assert response.json()["note"] == "Use the blue photo."

    def test_reject_needs_no_reason(self, hub: Hub, pending):
        _, owner, item = pending
        response = decide(hub, "acme", item, owner, "reject")
        assert response.status_code == 200
        assert response.json()["status"] == "rejected"

    @pytest.mark.parametrize("first", ["approve", "reject"])
    @pytest.mark.parametrize("second", ["approve", "reject"])
    def test_a_decision_is_final(self, hub: Hub, pending, first: str, second: str):
        _, owner, item = pending
        assert decide(hub, "acme", item, owner, first).status_code == 200
        response = decide(hub, "acme", item, owner, second)
        assert response.status_code == 409
        assert response.json()["error"] == "approval_invalid_transition"

    def test_an_unknown_decision_is_rejected(self, hub: Hub, pending):
        _, owner, item = pending
        assert decide(hub, "acme", item, owner, "maybe").status_code == 422

    def test_the_decision_is_audited_with_who_made_it(self, hub: Hub, pending):
        client_id, owner, item = pending
        decide(hub, "acme", item, owner, "approve")
        audit = hub.http.get(f"/api/v1/clients/{client_id}/audit", headers=AUTH).json()
        entry = next(row for row in audit if row["action"] == "approval.owner.approve")
        assert entry["payload"]["item_id"] == item
        assert entry["payload"]["actor"] == "owner:access-link"

    def test_an_item_from_another_tenant_is_not_found(self, hub: Hub, pending):
        _, _, item = pending
        _, rival = onboard(hub, "rival", contact_email="r@rival.example.com")
        response = decide(hub, "rival", item, rival, "approve")
        assert response.status_code == 404

    def test_an_owner_cannot_jump_the_qa_queue(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 6)
        item = draft(hub, client_id)["id"]
        assert decide(hub, "acme", item, owner, "approve").status_code == 409

    def test_a_suspended_account_cannot_decide(self, hub: Hub, pending, monkeypatch):
        from src.clients.models import SubscriptionStatus
        from src.portal import portal_router

        _, owner, item = pending

        async def suspended(client):
            client.subscription_status = SubscriptionStatus.SUSPENDED

        real = portal_router.client_service.get_by_slug

        async def fake(session, slug):
            client = await real(session, slug)
            await suspended(client)
            return client

        monkeypatch.setattr(portal_router.client_service, "get_by_slug", fake)
        response = decide(hub, "acme", item, owner, "approve")
        assert response.status_code == 403
        assert response.json()["error"] == "portal_account_paused"


class TestQaLane:
    @pytest_asyncio.fixture
    async def in_review(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 6)
        return client_id, owner, draft(hub, client_id)["id"]

    def test_the_queue_names_the_client(self, hub: Hub, in_review):
        queue = hub.http.get("/api/v1/qa/queue", headers=AUTH).json()
        assert [row["client_slug"] for row in queue] == ["acme"]
        assert queue[0]["company_name"] == "Acme Co"

    def test_forward_puts_it_in_front_of_the_owner(self, hub: Hub, in_review):
        client_id, owner, item = in_review
        assert qa(hub, client_id, item, "forward").json()["status"] == "pending_owner"
        assert hub.http.get("/api/v1/qa/queue", headers=AUTH).json() == []
        assert decide(hub, "acme", item, owner, "approve").status_code == 200

    def test_return_needs_a_note_and_keeps_it_from_the_owner(self, hub: Hub, in_review):
        client_id, owner, item = in_review
        assert qa(hub, client_id, item, "return").status_code == 422
        assert qa(hub, client_id, item, "return", "Off brand.").json()["status"] == "qa_returned"
        assert hub.http.get("/api/v1/portal/acme/approvals", headers=owner).json() == []

    def test_escalate_flags_it_and_moves_it_to_the_top(self, hub: Hub, in_review):
        client_id, _, item = in_review
        second = draft(hub, client_id, title="Second")["id"]
        assert qa(hub, client_id, second, "escalate").status_code == 422
        body = qa(hub, client_id, second, "escalate", "Needs Ishtiaq.").json()
        assert body["escalated"] is True
        assert body["status"] == "qa_review"
        queue = hub.http.get("/api/v1/qa/queue", headers=AUTH).json()
        assert [row["id"] for row in queue] == [second, item]

    def test_forwarding_clears_an_escalation(self, hub: Hub, in_review):
        client_id, _, item = in_review
        qa(hub, client_id, item, "escalate", "Check this.")
        assert qa(hub, client_id, item, "forward").json()["escalated"] is False

    def test_revise_runs_a_returned_draft_through_again(self, hub: Hub, in_review):
        client_id, _, item = in_review
        qa(hub, client_id, item, "return", "Off brand.")
        response = hub.http.post(
            f"/api/v1/clients/{client_id}/approvals/{item}/revise",
            headers=AUTH,
            json={"title": "Better draft", "preview": {"body": "On brand"}},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "qa_review"
        assert response.json()["title"] == "Better draft"
        assert response.json()["preview"] == {"body": "On brand"}

    def test_an_owners_edit_comes_back_to_the_team(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        item = draft(hub, client_id)["id"]
        decide(hub, "acme", item, owner, "edit", "Shorter, please.")
        queue = hub.http.get("/api/v1/qa/queue", headers=AUTH).json()
        assert queue[0]["id"] == item
        assert queue[0]["note"] == "Shorter, please."
        # Past Shadow Week, the revision returns to the owner directly.
        revised = hub.http.post(f"/api/v1/clients/{client_id}/approvals/{item}/revise", headers=AUTH, json={})
        assert revised.json()["status"] == "pending_owner"
        assert revised.json()["decided_at"] is None

    @pytest.mark.parametrize("status", ["approve", "reject"])
    def test_a_decided_item_cannot_be_revised(self, hub: Hub, status: str):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        item = draft(hub, client_id)["id"]
        decide(hub, "acme", item, owner, status)
        response = hub.http.post(f"/api/v1/clients/{client_id}/approvals/{item}/revise", headers=AUTH, json={})
        assert response.status_code == 409

    def test_qa_cannot_decide_something_already_with_the_owner(self, hub: Hub, in_review):
        client_id, _, item = in_review
        qa(hub, client_id, item, "forward")
        assert qa(hub, client_id, item, "return", "Too late.").status_code == 409


class TestRacingDecisions:
    async def test_the_second_of_two_simultaneous_decisions_loses(self, session, make_db_client):
        # Both requests have read the item as pending. Only the conditional UPDATE
        # can tell them apart, so this drives it with a stale object.
        client = await make_db_client()
        client.onboarding_stage = 7
        item = await approval_service.create_item(session, client, kind=ApprovalKind.PARTNER_EMAIL, title="Post")
        await session.commit()

        await approval_service.decide_as_owner(session, client, item.id, decision="approve", actor="first")
        stale = ApprovalItem(id=item.id, status=ApprovalStatus.PENDING_OWNER)
        with pytest.raises(ApprovalTransitionError):
            await approval_service._move(
                session,
                stale,
                allowed_from=(ApprovalStatus.PENDING_OWNER,),
                values={"status": ApprovalStatus.REJECTED, "decided_by": "second"},
            )
        await session.refresh(item)
        assert item.status is ApprovalStatus.APPROVED
        assert item.decided_by == "first"


class TestWhoMayDecide:
    @pytest_asyncio.fixture
    async def people(self, hub: Hub, session_factory):
        hub.settings.auth_seed_password = PASSWORD
        async with session_factory() as session:
            await auth_service.seed_accounts(session, hub.settings)
            await auth_service.create_user(
                session, email="growth@weblaud.com", full_name="Growth", role=UserRole.GROWTH_OPS, password=PASSWORD
            )
            await session.commit()
        client_id = next(
            row["id"] for row in hub.http.get("/api/v1/clients", headers=AUTH).json()["items"] if row["slug"] == "suvana"
        )
        set_stage(hub, client_id, 7)
        return client_id

    async def test_an_owners_session_can_decide_and_is_named_in_the_audit(self, hub: Hub, people):
        item = draft(hub, people)["id"]
        response = decide(hub, "suvana", item, sign_in(hub, "owner@suvana.com"), "approve")
        assert response.status_code == 200
        audit = hub.http.get(f"/api/v1/clients/{people}/audit", headers=AUTH).json()
        entry = next(row for row in audit if row["action"] == "approval.owner.approve")
        assert entry["payload"]["actor"] == "owner@suvana.com"

    async def test_growth_can_look_but_not_decide_for_the_owner(self, hub: Hub, people):
        item = draft(hub, people)["id"]
        growth = sign_in(hub, "growth@weblaud.com")
        assert hub.http.get("/api/v1/portal/suvana/approvals", headers=growth).status_code == 200
        assert decide(hub, "suvana", item, growth, "approve").status_code == 403
        moved = hub.http.put("/api/v1/portal/suvana/guardrails/social_posts", headers=growth, json={"lane": "automatic"})
        assert moved.status_code == 403

    async def test_a_super_admin_can_and_the_audit_says_who(self, hub: Hub, people):
        item = draft(hub, people)["id"]
        assert decide(hub, "suvana", item, sign_in(hub, "sakib@weblaud.com"), "approve").status_code == 200
        audit = hub.http.get(f"/api/v1/clients/{people}/audit", headers=AUTH).json()
        entry = next(row for row in audit if row["action"] == "approval.owner.approve")
        assert entry["payload"]["actor"] == "sakib@weblaud.com"

    async def test_sales_cannot_use_the_qa_queue(self, hub: Hub, people):
        sales = sign_in(hub, "jubayed@weblaud.com")
        response = hub.http.post(
            f"/api/v1/clients/{people}/approvals",
            headers=sales,
            json={"kind": "social_post", "title": "Nope"},
        )
        assert response.status_code == 403


class TestWhiteLabel:
    def test_agent_vocabulary_is_scrubbed_on_the_way_to_the_owner(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        draft(
            hub, client_id,
            title="Post from hermes agent",
            summary="Read /opt/data/SOUL.md first",
            preview={"body": "key sk-abcdefghijklmnop", "nested": {"path": "/opt/data/skills"}},
            source_skill="social-media-autopilot",
        )
        body = hub.http.get("/api/v1/portal/acme/approvals", headers=owner).text.lower()
        for leaked in ("hermes", "/opt/data", "sk-abcdefghijklmnop", "source_skill", "social-media-autopilot"):
            assert leaked not in body


# ======================================================================
# guardrails
# ======================================================================
class TestGuardrails:
    def lanes(self, hub: Hub, owner: dict) -> dict[str, dict]:
        rows = hub.http.get("/api/v1/portal/acme/guardrails", headers=owner).json()
        return {row["key"]: row for row in rows}

    def test_all_three_lanes_are_populated(self, hub: Hub):
        _, owner = onboard(hub)
        lanes = {row["lane"] for row in self.lanes(hub, owner).values()}
        assert lanes == {"automatic", "owner", "never"}

    def test_the_catalog_follows_the_business_model(self, hub: Hub):
        _, general = onboard(hub)
        keys = self.lanes(hub, general)
        assert "appointment_reminders" in keys
        assert "courier_dispatch" not in keys
        _, shop = onboard(hub, "shop", business_mode="ecommerce", contact_email="s@shop.example.com")
        rows = hub.http.get("/api/v1/portal/shop/guardrails", headers=shop).json()
        keys = {row["key"] for row in rows}
        assert "courier_dispatch" in keys
        assert "appointment_reminders" not in keys

    def test_a_routine_item_can_be_promoted_and_then_skips_the_queue(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        response = hub.http.put(
            "/api/v1/portal/acme/guardrails/partner_emails", headers=owner, json={"lane": "automatic"}
        )
        assert response.status_code == 200
        assert self.lanes(hub, owner)["partner_emails"]["lane"] == "automatic"

        item = draft(hub, client_id, "partner_email")
        assert item["status"] == "approved"
        assert item["decided_by"] == approval_service.AUTOMATIC_ACTOR
        listed = hub.http.get("/api/v1/portal/acme/approvals", headers=owner).json()
        assert listed[0]["decided_automatically"] is True

    def test_a_promotion_can_be_taken_back(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 7)
        url = "/api/v1/portal/acme/guardrails/partner_emails"
        hub.http.put(url, headers=owner, json={"lane": "automatic"})
        hub.http.put(url, headers=owner, json={"lane": "owner"})
        assert draft(hub, client_id, "partner_email")["status"] == "pending_owner"

    def test_shadow_week_outranks_a_promotion(self, hub: Hub):
        client_id, owner = onboard(hub)
        set_stage(hub, client_id, 6)
        hub.http.put("/api/v1/portal/acme/guardrails/partner_emails", headers=owner, json={"lane": "automatic"})
        assert draft(hub, client_id, "partner_email")["status"] == "qa_review"

    @pytest.mark.parametrize(
        "key", ["refunds", "price_changes", "legal_commitments", "payment_settings", "customer_data_export", "ad_boosts", "faq_replies"]
    )
    def test_locked_items_cannot_be_moved(self, hub: Hub, key: str):
        _, owner = onboard(hub)
        response = hub.http.put(f"/api/v1/portal/acme/guardrails/{key}", headers=owner, json={"lane": "automatic"})
        assert response.status_code == 409
        assert response.json()["error"] == "guardrail_locked"

    def test_ad_boosts_always_reach_the_owner(self, hub: Hub):
        client_id, _ = onboard(hub)
        set_stage(hub, client_id, 7)
        assert draft(hub, client_id, "ad_boost")["status"] == "pending_owner"

    def test_a_never_lane_cannot_be_requested(self, hub: Hub):
        _, owner = onboard(hub)
        response = hub.http.put("/api/v1/portal/acme/guardrails/social_posts", headers=owner, json={"lane": "never"})
        assert response.status_code == 422

    def test_an_unknown_item_is_not_found(self, hub: Hub):
        _, owner = onboard(hub)
        assert hub.http.put("/api/v1/portal/acme/guardrails/nope", headers=owner, json={"lane": "owner"}).status_code == 404

    def test_an_item_from_the_other_business_model_is_not_found(self, hub: Hub):
        _, owner = onboard(hub)
        response = hub.http.put(
            "/api/v1/portal/acme/guardrails/courier_dispatch", headers=owner, json={"lane": "automatic"}
        )
        assert response.status_code == 404

    def test_a_change_is_audited(self, hub: Hub):
        client_id, owner = onboard(hub)
        hub.http.put("/api/v1/portal/acme/guardrails/reels", headers=owner, json={"lane": "automatic"})
        audit = hub.http.get(f"/api/v1/clients/{client_id}/audit", headers=AUTH).json()
        assert any(row["action"] == "portal.guardrail.update" for row in audit)


# ======================================================================
# business model and region
# ======================================================================
class TestBusinessProfile:
    def test_defaults_keep_old_payloads_working(self, hub: Hub):
        response = hub.onboard()
        assert response.status_code == 201
        client = hub.http.get(f"/api/v1/clients/{response.json()['client_id']}", headers=AUTH).json()
        assert client["business_mode"] == "general"
        assert client["region_preset"] == "global"
        assert client["currency"] == "USD"
        assert client["package_tier"] == "presence"
        assert client["onboarding_stage"] == 5

    def test_the_package_sets_the_resource_plan(self, hub: Hub):
        client_id = hub.onboard(package_tier="scale", plan="starter").json()["client_id"]
        client = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()
        assert client["plan"] == "scale"
        assert client["package_tier"] == "scale"

    def test_bangladesh_always_bills_in_taka(self, hub: Hub):
        client_id = hub.onboard(region_preset="bd").json()["client_id"]
        assert hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()["currency"] == "BDT"
        refused = hub.onboard(subdomain="usd-bd", region_preset="bd", currency="USD")
        assert refused.status_code == 409

    @pytest.mark.parametrize("currency", ["USD", "EUR", "GBP", "gbp"])
    def test_global_clients_choose_a_currency(self, hub: Hub, currency: str):
        client_id = hub.onboard(region_preset="global", currency=currency).json()["client_id"]
        assert hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()["currency"] == currency.upper()

    def test_moving_region_moves_the_currency(self, hub: Hub):
        client_id = hub.onboard(region_preset="global", currency="EUR").json()["client_id"]
        body = hub.http.patch(f"/api/v1/clients/{client_id}", headers=AUTH, json={"region_preset": "bd"}).json()
        assert body["currency"] == "BDT"

    def test_the_profile_reaches_the_tenant_without_secrets(self, hub: Hub):
        response = hub.onboard(
            business_mode="ecommerce", niche_template="ecommerce_store", region_preset="bd", package_tier="growth"
        )
        text = (hub.tenant_dir("acme.localhost") / "business-profile.yaml").read_text(encoding="utf-8")
        profile = yaml.safe_load(text)
        assert profile["business_mode"] == "ecommerce"
        assert profile["currency"] == "BDT"
        assert "steadfast" in profile["couriers"]
        assert "bkash" in profile["payments"]
        assert "refunds" in profile["guardrails"]["never"]
        for secret in (response.json()["api_key"], response.json()["dashboard_password"], "sk-or-v1"):
            assert secret not in text

    def test_a_global_profile_has_the_global_stack(self, hub: Hub):
        hub.onboard(region_preset="global", business_mode="ecommerce")
        profile = yaml.safe_load((hub.tenant_dir("acme.localhost") / "business-profile.yaml").read_text(encoding="utf-8"))
        assert "stripe" in profile["payments"]
        assert "shopify" in profile["integrations"]
        assert "dhl" in profile["couriers"]


class TestSkillSelection:
    @pytest.fixture
    def library(self, settings):
        for name in (
            "ai-employee-orchestrator", "lead-qualification", "social-media-autopilot", "designer-brand-studio",
            "roi-weekly-reporter", "ads-growth-manager", "order-desk-ecommerce", "catalog-keeper-ecommerce",
        ):
            directory = settings.shared_skills_dir / name
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
        return settings

    def test_general_clients_never_get_e_commerce_skills(self, library):
        for plan in ("starter", "growth", "scale"):
            assert not set(skills_for_client(library, plan, "general")) & ECOMMERCE_SKILLS

    def test_e_commerce_clients_get_them_on_every_plan(self, library):
        for plan in ("starter", "growth", "scale"):
            assert ECOMMERCE_SKILLS <= set(skills_for_client(library, plan, "ecommerce"))

    def test_the_presence_package_excludes_higher_tier_skills(self, library):
        assert "ads-growth-manager" not in skills_for_client(library, "starter", "general")
        assert "ads-growth-manager" in skills_for_client(library, "growth", "general")

    def test_a_kit_narrows_but_cannot_grant(self, library):
        chosen = skills_for_client(library, "starter", "general", ["designer-brand-studio", "ads-growth-manager"])
        assert chosen == ["ai-employee-orchestrator", "designer-brand-studio"]

    async def test_provisioning_disables_the_shared_copy_for_general_clients(self, hub: Hub):
        for name in ECOMMERCE_SKILLS:
            directory = hub.settings.shared_skills_dir / name
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
        hub.onboard(company_name="Clinic", subdomain="clinic")
        hub.onboard(
            company_name="Shop", subdomain="shop", business_mode="ecommerce", contact_email="s@shop.example.com"
        )
        clinic = yaml.safe_load((hub.tenant_dir("clinic.localhost") / "config.yaml").read_text(encoding="utf-8"))
        shop = yaml.safe_load((hub.tenant_dir("shop.localhost") / "config.yaml").read_text(encoding="utf-8"))
        assert set(clinic["skills"]["disabled"]) == ECOMMERCE_SKILLS
        assert "skills" not in shop


class TestSkillLibraryOnDisk:
    """Against the real ``shared-skills/``, since the agent reads these files."""

    EXPECTED = {
        "ai-employee-orchestrator", "designer-brand-studio", "video-reel-editor", "social-media-autopilot", "sales-rep-inbox", "ads-growth-manager",
        "email-outreach-assistant", "web-seo-manager", "roi-weekly-reporter", "order-desk-ecommerce", "catalog-keeper-ecommerce",
    }

    def test_every_specialist_is_present(self):
        root = REPO_ROOT / "shared-skills"
        present = {path.parent.name for path in root.glob("*/SKILL.md")}
        assert self.EXPECTED <= present

    @pytest.mark.parametrize("name", sorted(EXPECTED))
    def test_the_frontmatter_is_what_the_agent_expects(self, name: str):
        text = (REPO_ROOT / "shared-skills" / name / "SKILL.md").read_text(encoding="utf-8")
        assert text.startswith("---\n")
        meta = yaml.safe_load(text.split("---", 2)[1])
        assert meta["name"] == name
        assert len(meta["description"]) > 40
        assert "Use when" in meta["description"]

    @pytest.mark.parametrize("name", sorted(EXPECTED))
    def test_descriptions_are_safe_for_the_portal(self, name: str):
        # The portal shows the first sentence of each description to the owner.
        from src.portal.sanitize import mentions_internals

        text = (REPO_ROOT / "shared-skills" / name / "SKILL.md").read_text(encoding="utf-8")
        meta = yaml.safe_load(text.split("---", 2)[1])
        assert not mentions_internals(meta["description"])


class TestKitsAndLibraryRoutes:
    def test_the_four_kits_exist(self, hub: Hub):
        kits = {kit["key"]: kit for kit in hub.http.get("/api/v1/kits", headers=AUTH).json()}
        assert set(kits) == {"dental_clinic", "beauty_salon", "restaurant", "travel_agency", "ecommerce_store"}
        assert kits["ecommerce_store"]["business_mode"] == "ecommerce"
        assert "order-desk-ecommerce" in kits["ecommerce_store"]["skills"]

    def test_a_kit_can_be_edited_and_restored(self, hub: Hub):
        body = hub.http.patch(
            "/api/v1/kits/dental_clinic", headers=AUTH, json={"description": "Edited.", "skills": ["lead-qualification"]}
        )
        assert body.status_code == 200
        kit = next(row for row in body.json() if row["key"] == "dental_clinic")
        assert kit["description"] == "Edited."
        assert kit["customised"] is True
        restored = hub.http.delete("/api/v1/kits/dental_clinic/customisation", headers=AUTH).json()
        kit = next(row for row in restored if row["key"] == "dental_clinic")
        assert kit["customised"] is False
        assert kit["description"] != "Edited."

    def test_a_kit_cannot_reference_a_skill_that_does_not_exist(self, hub: Hub):
        response = hub.http.patch("/api/v1/kits/dental_clinic", headers=AUTH, json={"skills": ["made-up"]})
        assert response.status_code == 422

    def test_an_unknown_kit_is_not_found(self, hub: Hub):
        assert hub.http.patch("/api/v1/kits/nope", headers=AUTH, json={"description": "x"}).status_code == 404

    def test_the_library_returns_the_full_text(self, hub: Hub):
        rows = hub.http.get("/api/v1/skills", headers=AUTH).json()
        assert {row["id"] for row in rows} == {"lead-qualification", "ecommerce-lookup"}
        assert rows[0]["markdown"].startswith("# ")


# ======================================================================
# the workspace
# ======================================================================
class TestWorkspace:
    def test_an_owner_sees_their_records_and_nobody_elses(self, hub: Hub):
        client_id, owner = onboard(hub, business_mode="ecommerce")
        _, rival = onboard(hub, "rival", contact_email="r@rival.example.com")
        created = hub.http.post(
            f"/api/v1/clients/{client_id}/workspace-records",
            headers=AUTH,
            json={"kind": "order", "title": "Order 1", "status": "in_transit", "detail": {"courier": "Pathao"}},
        )
        assert created.status_code == 201
        body = hub.http.get("/api/v1/portal/acme/workspace", headers=owner).json()
        assert body["business_mode"] == "ecommerce"
        assert body["records"][0]["detail"]["courier"] == "Pathao"
        assert hub.http.get("/api/v1/portal/rival/workspace", headers=rival).json()["records"] == []

    def test_a_record_cannot_be_changed_through_another_client(self, hub: Hub):
        client_id, _ = onboard(hub)
        other_id, _ = onboard(hub, "other", contact_email="o@other.example.com")
        record = hub.http.post(
            f"/api/v1/clients/{client_id}/workspace-records", headers=AUTH, json={"kind": "lead", "title": "A lead"}
        ).json()
        response = hub.http.patch(
            f"/api/v1/clients/{other_id}/workspace-records/{record['id']}", headers=AUTH, json={"status": "done"}
        )
        assert response.status_code == 404


class TestDemoTenant:
    @pytest_asyncio.fixture
    async def demo(self, hub: Hub, session_factory):
        hub.settings.auth_seed_password = PASSWORD
        async with session_factory() as session:
            await auth_service.seed_accounts(session, hub.settings)
            await session.commit()
        return sign_in(hub, "owner@suvana.com")

    async def test_its_figures_add_up(self, hub: Hub, demo):
        body = hub.http.get("/api/v1/portal/suvana/roi", headers=demo).json()
        assert body["baseline"]["conversion_rate"] == DEMO_BASELINE["conversion_rate"]
        assert body["result"]["net_value"] == 11_860
        assert body["result"]["roi_percent"] == 27.58

    async def test_the_portal_knows_it_is_a_demo(self, hub: Hub, demo):
        profile = hub.http.get("/api/v1/portal/suvana/profile", headers=demo).json()
        assert profile["is_demo"] is True
        assert profile["business_mode"] == "ecommerce"
        assert profile["pending_approvals"] == 3

    async def test_provisioning_it_for_real_clears_the_samples(self, hub: Hub, demo):
        response = hub.onboard(company_name="Suvana", subdomain="suvana", contact_email="owner@suvana.com")
        assert response.status_code == 201, response.text
        fresh = sign_in(hub, "owner@suvana.com")
        assert hub.http.get("/api/v1/portal/suvana/profile", headers=fresh).json()["is_demo"] is False
        assert hub.http.get("/api/v1/portal/suvana/approvals", headers=fresh).json() == []
        assert hub.http.get("/api/v1/portal/suvana/roi", headers=fresh).json()["funnel"] is None

    async def test_someone_else_cannot_take_the_demo_subdomain(self, hub: Hub, demo):
        response = hub.onboard(company_name="Suvana", subdomain="suvana", contact_email="else@else.example.com")
        assert response.status_code == 409


# ======================================================================
# the CRM
# ======================================================================
class TestPriorityScore:
    @pytest.mark.parametrize(
        "signals, expected",
        [
            ({}, 1),
            ({"no_website": True}, 1),
            ({"no_website": True, "slow_reply": True}, 2),
            ({"irregular_social": True, "slow_reply": True, "accessible_owner": True}, 3),
            ({"no_website": True, "irregular_social": True, "slow_reply": True, "repeat_high_value_sales": True}, 4),
            (
                {
                    "no_website": True, "irregular_social": True, "slow_reply": True,
                    "repeat_high_value_sales": True, "accessible_owner": True,
                },
                5,
            ),
        ],
    )
    def test_each_signal_adds_one_on_a_one_to_five_scale(self, signals, expected):
        assert priority_score(Prospect(**signals)) == expected


class TestPipeline:
    def test_a_prospect_moves_through_the_stages(self, hub: Hub):
        created = hub.http.post(
            "/api/v1/crm/prospects",
            headers=AUTH,
            json={"business_name": "Smile Care", "no_website": True, "slow_reply": True, "assignee": "jubayed"},
        ).json()
        assert created["stage"] == "new"
        assert created["priority_score"] == 2
        for stage in ("qualified", "contacted", "video_audit_sent", "meeting", "proposal", "won"):
            body = hub.http.patch(f"/api/v1/crm/prospects/{created['id']}", headers=AUTH, json={"stage": stage}).json()
            assert body["stage"] == stage

    def test_changing_a_signal_changes_the_score(self, hub: Hub):
        created = hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Smile Care"}).json()
        body = hub.http.patch(
            f"/api/v1/crm/prospects/{created['id']}",
            headers=AUTH,
            json={"no_website": True, "accessible_owner": True, "irregular_social": True},
        ).json()
        assert body["priority_score"] == 3

    def test_the_list_puts_the_best_prospects_first_and_states_the_target(self, hub: Hub):
        hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Low"})
        hub.http.post(
            "/api/v1/crm/prospects",
            headers=AUTH,
            json={"business_name": "High", "no_website": True, "slow_reply": True, "irregular_social": True},
        )
        body = hub.http.get("/api/v1/crm/prospects", headers=AUTH).json()
        assert body["target"] == PIPELINE_TARGET == 100
        assert [row["business_name"] for row in body["items"]] == ["High", "Low"]

    def test_the_list_can_be_filtered_by_stage(self, hub: Hub):
        hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Fresh"})
        hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Warm", "stage": "meeting"})
        body = hub.http.get("/api/v1/crm/prospects?stage=meeting", headers=AUTH).json()
        assert [row["business_name"] for row in body["items"]] == ["Warm"]

    def test_an_unknown_assignee_is_rejected(self, hub: Hub):
        response = hub.http.post(
            "/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Smile", "assignee": "nobody"}
        )
        assert response.status_code == 422

    def test_a_prospect_can_be_removed(self, hub: Hub):
        created = hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Gone"}).json()
        assert hub.http.delete(f"/api/v1/crm/prospects/{created['id']}", headers=AUTH).status_code == 204
        assert hub.http.get("/api/v1/crm/prospects", headers=AUTH).json()["items"] == []

    def test_an_audit_link_must_be_a_web_address(self, hub: Hub):
        response = hub.http.post(
            "/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Bad", "audit_url": "javascript:alert(1)"}
        )
        assert response.status_code == 422

    def test_an_onboarding_draft_round_trips(self, hub: Hub):
        prospect = hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Smile"}).json()
        response = hub.http.put(
            f"/api/v1/crm/prospects/{prospect['id']}/draft",
            headers=AUTH,
            json={
                "company_name": "Smile Care",
                "contact_email": "dr@smile.example.com",
                "business_mode": "general",
                "niche_template": "dental_clinic",
                "package_tier": "growth",
                "region_preset": "bd",
                "baseline_metrics": BASELINE,
            },
        )
        assert response.status_code == 200
        drafts = hub.http.get("/api/v1/crm/drafts", headers=AUTH).json()
        assert drafts[0]["onboarding_draft"]["niche_template"] == "dental_clinic"
        assert drafts[0]["onboarding_draft"]["baseline_metrics"]["monthly_inquiries"] == 200

    def test_a_draft_with_the_wrong_currency_for_its_region_is_refused(self, hub: Hub):
        prospect = hub.http.post("/api/v1/crm/prospects", headers=AUTH, json={"business_name": "Smile"}).json()
        response = hub.http.put(
            f"/api/v1/crm/prospects/{prospect['id']}/draft",
            headers=AUTH,
            json={"company_name": "Smile Care", "region_preset": "bd", "currency": "USD"},
        )
        assert response.status_code == 409


class TestStandup:
    def test_the_day_starts_at_zero_with_the_agreed_targets(self, hub: Hub):
        members = {m["key"]: m for m in hub.http.get("/api/v1/crm/standup?day=2026-11-04", headers=AUTH).json()["members"]}
        assert set(members) == {"sakib", "jubayed", "ishtiaq"}
        targets = {metric["key"]: metric["target"] for metric in members["jubayed"]["metrics"]}
        assert targets == {"new_leads": 15, "follow_ups": 10}
        assert all(member["completion_percent"] == 0 for member in members.values())

    def test_progress_is_saved_per_day(self, hub: Hub):
        url = "/api/v1/crm/standup/2026-11-04/jubayed/new_leads"
        assert hub.http.put(url, headers=AUTH, json={"done": 15}).status_code == 200
        hub.http.put(url, headers=AUTH, json={"done": 10})
        today = hub.http.get("/api/v1/crm/standup?day=2026-11-04", headers=AUTH).json()
        jubayed = next(m for m in today["members"] if m["key"] == "jubayed")
        # 10 of the 25 total.
        assert jubayed["completion_percent"] == 40
        tomorrow = hub.http.get("/api/v1/crm/standup?day=2026-11-05", headers=AUTH).json()
        assert next(m for m in tomorrow["members"] if m["key"] == "jubayed")["completion_percent"] == 0

    def test_overshooting_one_target_cannot_hide_missing_another(self, hub: Hub):
        hub.http.put("/api/v1/crm/standup/2026-11-04/jubayed/new_leads", headers=AUTH, json={"done": 100})
        body = hub.http.get("/api/v1/crm/standup?day=2026-11-04", headers=AUTH).json()
        assert next(m for m in body["members"] if m["key"] == "jubayed")["completion_percent"] == 60

    @pytest.mark.parametrize("path", ["nobody/new_leads", "jubayed/demos", "sakib/nope"])
    def test_unknown_targets_are_not_found(self, hub: Hub, path: str):
        assert hub.http.put(f"/api/v1/crm/standup/2026-11-04/{path}", headers=AUTH, json={"done": 1}).status_code == 404

    def test_a_malformed_day_is_rejected(self, hub: Hub):
        assert hub.http.get("/api/v1/crm/standup?day=04-11-2026", headers=AUTH).status_code == 422
