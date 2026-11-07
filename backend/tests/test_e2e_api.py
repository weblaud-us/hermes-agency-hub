"""End-to-end API workflow tests.

These drive the real FastAPI app over HTTP with ``TestClient`` and let the
request run all the way down: slug derivation, credential generation, template
rendering to disk, port allocation, the provisioning sequence, nginx
registration, rollback, status transitions and the audit trail. Only the Docker
SDK and the single outbound health probe are faked — see ``conftest.hub``.

That matters for the credential assertions in particular. Checking that the
response *contains* a password is nearly worthless; checking that the password
in the response verifies against the scrypt hash that was written into the
tenant's ``.env`` on disk is the thing an operator actually depends on, and it
is only possible with the real renderer in the loop.
"""

from __future__ import annotations

import uuid

import pytest
from docker.errors import APIError, DockerException
from requests.exceptions import ConnectionError as RequestsConnectionError

from conftest import AUTH, assert_hardened, assert_no_secrets
from src.clients.models import SubscriptionStatus
from src.orchestrator.credentials import (
    API_KEY_MIN_LENGTH,
    verify_dashboard_password,
)
from src.orchestrator.templates import parse_env

PROVIDER_KEY = "sk-or-v1-tenant-secret-key"


# ======================================================================
# 1. authentication
# ======================================================================
class TestAuthentication:
    def test_a_missing_key_is_rejected(self, hub):
        assert hub.http.get("/api/v1/clients").status_code == 401

    def test_a_wrong_key_is_rejected(self, hub):
        response = hub.http.get("/api/v1/clients", headers={"X-API-Key": "nope"})
        assert response.status_code == 401

    def test_the_correct_key_is_accepted(self, hub):
        assert hub.http.get("/api/v1/clients", headers=AUTH).status_code == 200

    def test_onboarding_is_protected(self, hub):
        # The most consequential route must not be reachable unauthenticated.
        response = hub.http.post(
            "/api/v1/clients/onboard",
            json={
                "company_name": "Acme Widgets",
                "openrouter_api_key": PROVIDER_KEY,
                "contact_email": "ops@acme.example.com",
            },
        )
        assert response.status_code == 401
        # And it must not have provisioned anything on the way to refusing.
        assert hub.docker.create_calls == []

    def test_teardown_is_protected(self, hub):
        client_id = hub.onboard().json()["client_id"]
        assert hub.http.delete(f"/api/v1/clients/{client_id}").status_code == 401
        assert (
            hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).status_code
            == 200
        )

    def test_liveness_is_open(self, hub):
        # Load balancers and `docker healthcheck` cannot send an admin key.
        body = hub.http.get("/healthz").json()
        assert body["status"] == "ok"
        assert body["docker"] is True

    def test_the_admin_key_is_never_echoed(self, hub):
        response = hub.http.get("/api/v1/clients", headers=AUTH)
        assert_no_secrets(response.text, AUTH["X-API-Key"])


# ======================================================================
# 2. the onboarding lifecycle
# ======================================================================
class TestOnboardingLifecycle:
    def test_returns_201_with_a_complete_access_bundle(self, hub):
        response = hub.onboard()
        assert response.status_code == 201
        body = response.json()

        assert body["subdomain"] == "acme.localhost"
        assert body["status"] == SubscriptionStatus.ACTIVE.value
        assert body["warning"] is None
        assert body["dashboard_url"] == "http://acme.localhost"
        assert body["api_base_url"] == "http://acme.localhost/v1"
        assert body["container_name"] == "hermes-client-acme"
        assert body["synced_skills"] == ["sales-rep-inbox"]
        assert uuid.UUID(body["client_id"])

    def test_the_returned_password_verifies_against_the_deployed_hash(self, hub):
        """The credential assertion that actually proves a tenant can log in.

        The hub keeps only a scrypt hash, and the container authenticates
        against the hash written into its ``.env``. If generation and rendering
        ever disagree, the operator gets a password nobody can use — and the
        only symptom is a 401 after a multi-gigabyte container has started.
        """
        body = hub.onboard().json()
        env = parse_env(hub.env_text(body["subdomain"]))

        assert env["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"] == (
            body["dashboard_username"]
        )
        assert verify_dashboard_password(
            body["dashboard_password"],
            env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"],
        )

    def test_the_returned_api_key_is_the_one_the_container_will_accept(self, hub):
        body = hub.onboard().json()
        env = parse_env(hub.env_text(body["subdomain"]))

        assert body["api_key"].startswith("sk-acme.localhost-")
        # Shorter than this and the gateway silently leaves its API server
        # down, which surfaces much later as an unexplained health failure.
        assert len(body["api_key"]) >= API_KEY_MIN_LENGTH
        assert env["API_SERVER_KEY"] == body["api_key"]

    def test_the_designated_loopback_ports_are_what_docker_published(self, hub):
        body = hub.onboard().json()
        dash, api = body["container_port_dash"], body["container_port_api"]

        assert 19000 <= dash <= 19499
        assert 19500 <= api <= 19999
        # The caller is told where to reach the tenant on this host; that has
        # to be where the daemon actually bound it.
        call = hub.docker.created_for(body["container_name"])
        assert call["ports"] == {
            "9119/tcp": ("127.0.0.1", dash),
            "8642/tcp": ("127.0.0.1", api),
        }

    def test_the_container_is_created_inside_the_hardened_envelope(self, hub):
        body = hub.onboard().json()
        container = hub.docker.containers_by_name[body["container_name"]]
        assert_hardened(
            container.host_config,
            expected_ports={
                "9119/tcp": body["container_port_dash"],
                "8642/tcp": body["container_port_api"],
            },
        )

    def test_the_tenant_directory_is_populated(self, hub):
        body = hub.onboard().json()
        tenant_dir = hub.tenant_dir(body["subdomain"])
        assert (tenant_dir / ".env").is_file()
        assert (tenant_dir / "config.yaml").is_file()
        assert (tenant_dir / "skills" / "sales-rep-inbox" / "SKILL.md").is_file()

    def test_the_subdomain_is_derived_from_the_company_name(self, hub):
        body = hub.onboard(subdomain=None, company_name="Globex Corporation").json()
        assert body["subdomain"] == "globex-corporation.localhost"
        assert body["container_name"] == "hermes-client-globex-corporation"

    def test_a_requested_subdomain_is_normalised(self, hub):
        body = hub.onboard(subdomain="ACME Widgets!").json()
        assert body["subdomain"] == "acme-widgets.localhost"

    @pytest.mark.parametrize("plan", ["starter", "growth", "scale"])
    def test_every_plan_onboards(self, hub, plan):
        body = hub.onboard(plan=plan).json()
        assert body["status"] == "active"
        # The envelope is per-tenant, not per-plan: isolation does not scale
        # with price.
        container = hub.docker.containers_by_name[body["container_name"]]
        assert_hardened(container.host_config)

    def test_the_audit_trail_records_the_whole_run(self, hub):
        client_id = hub.onboard().json()["client_id"]
        entries = hub.http.get(
            f"/api/v1/clients/{client_id}/audit", headers=AUTH
        ).json()
        actions = {(entry["action"], entry["status"]) for entry in entries}
        assert ("created", "succeeded") in actions
        assert ("provision", "started") in actions
        assert ("provision", "succeeded") in actions

    def test_two_tenants_are_fully_isolated(self, hub):
        first = hub.onboard(subdomain="acme").json()
        second = hub.onboard(
            subdomain="globex",
            company_name="Globex Corporation",
            contact_email="ops@globex.example.com",
        ).json()

        assert first["container_port_dash"] != second["container_port_dash"]
        assert first["container_port_api"] != second["container_port_api"]
        assert first["api_key"] != second["api_key"]
        assert first["dashboard_password"] != second["dashboard_password"]
        # Separate data directories, and neither .env mentions the other.
        assert_no_secrets(hub.env_text(first["subdomain"]), second["api_key"])
        assert_no_secrets(hub.env_text(second["subdomain"]), first["api_key"])

    def test_ten_tenants_never_share_a_port(self, hub):
        ports: list[int] = []
        for index in range(10):
            body = hub.onboard(
                subdomain=f"tenant-{index}",
                company_name=f"Tenant {index} Ltd",
                contact_email=f"ops{index}@example.com",
            ).json()
            ports.extend([body["container_port_dash"], body["container_port_api"]])
        assert len(set(ports)) == 20


class TestOnboardingSecretHygiene:
    def test_the_provider_key_is_never_echoed_back(self, hub):
        response = hub.onboard()
        assert_no_secrets(response.text, PROVIDER_KEY)

    def test_the_provider_key_is_not_stored_in_the_database(self, hub):
        client_id = hub.onboard().json()["client_id"]
        record = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()
        assert_no_secrets(record, PROVIDER_KEY)
        # Only a fragment, so support can confirm *which* key without holding it.
        assert record["openrouter_key_last4"] == PROVIDER_KEY[-4:]

    def test_the_client_representation_carries_no_credentials(self, hub):
        client_id = hub.onboard().json()["client_id"]
        record = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()
        for field in ("api_key", "dashboard_password_hash", "dashboard_secret",
                      "internal_token", "dashboard_password"):
            assert field not in record

    def test_the_provider_key_reaches_the_env_file_and_nothing_else(self, hub):
        body = hub.onboard().json()
        tenant_dir = hub.tenant_dir(body["subdomain"])
        assert PROVIDER_KEY in (tenant_dir / ".env").read_text(encoding="utf-8")
        assert_no_secrets(
            (tenant_dir / "config.yaml").read_text(encoding="utf-8"), PROVIDER_KEY
        )
        # And not into the container environment, which `docker inspect` shows
        # to anyone with socket access.
        assert_no_secrets(
            hub.docker.created_for(body["container_name"])["environment"],
            PROVIDER_KEY,
            body["api_key"],
            body["dashboard_password"],
        )

    def test_the_plaintext_password_is_unrecoverable_afterwards(self, hub):
        # It is returned exactly once. Nothing else must be able to surface it.
        body = hub.onboard().json()
        password = body["dashboard_password"]
        client_id = body["client_id"]

        for path in (
            f"/api/v1/clients/{client_id}",
            f"/api/v1/clients/{client_id}/audit",
            f"/api/v1/clients/{client_id}/health",
            "/api/v1/clients",
        ):
            assert_no_secrets(
                hub.http.get(path, headers=AUTH).text, password
            )
        assert_no_secrets(hub.env_text(body["subdomain"]), password)


# ======================================================================
# 3. health checks
# ======================================================================
class TestHealthEndpoint:
    def test_reports_both_probes_for_a_healthy_tenant(self, hub):
        body = hub.onboard().json()
        health = hub.http.get(
            f"/api/v1/clients/{body['client_id']}/health", headers=AUTH
        ).json()

        assert health["healthy"] is True
        assert health["container_state"] == "running"
        assert health["subscription_status"] == "active"
        assert health["subdomain"] == body["subdomain"]
        assert health["dashboard"]["reachable"] is True
        assert health["api"]["reachable"] is True
        assert health["dashboard"]["status"] == 200
        assert health["restart_count"] == 0

    def test_probes_the_two_services_separately(self, hub):
        body = hub.onboard().json()
        hub.probe.calls.clear()
        health = hub.http.get(
            f"/api/v1/clients/{body['client_id']}/health", headers=AUTH
        ).json()
        # Distinct URLs: a single probe would report a dead API server as
        # healthy whenever the dashboard answered.
        assert health["dashboard"]["url"] != health["api"]["url"]
        assert health["dashboard"]["url"].endswith("/api/health")
        assert health["api"]["url"].endswith("/health")
        assert len(hub.probe.calls) == 2

    def test_a_running_container_with_a_dead_service_is_not_healthy(self, hub):
        client_id = hub.onboard().json()["client_id"]
        hub.probe.reachable = False
        health = hub.http.get(
            f"/api/v1/clients/{client_id}/health", headers=AUTH
        ).json()

        assert health["healthy"] is False
        assert health["container_state"] == "running"
        assert health["dashboard"]["reachable"] is False
        assert health["dashboard"]["error"] == "connection refused"

    def test_an_authenticated_dashboard_still_counts_as_healthy(self, hub):
        # A 401 on the health path proves the service is up and its auth gate
        # is engaged. Reporting that as down would fail every real tenant.
        client_id = hub.onboard().json()["client_id"]
        hub.probe.status = 401
        health = hub.http.get(
            f"/api/v1/clients/{client_id}/health", headers=AUTH
        ).json()
        assert health["healthy"] is True
        assert health["dashboard"]["status"] == 401

    def test_a_vanished_container_is_reported_without_probing(self, hub):
        body = hub.onboard().json()
        hub.docker.containers_by_name.pop(body["container_name"])
        hub.probe.calls.clear()

        health = hub.http.get(
            f"/api/v1/clients/{body['client_id']}/health", headers=AUTH
        ).json()
        assert health["container_state"] == "absent"
        assert health["healthy"] is False
        assert health["dashboard"] is None
        assert health["api"] is None
        assert hub.probe.calls == []

    def test_a_crashed_container_reports_its_restart_count(self, hub):
        body = hub.onboard().json()
        hub.docker.containers_by_name[body["container_name"]].set_state(
            "exited", restarts=7
        )
        health = hub.http.get(
            f"/api/v1/clients/{body['client_id']}/health", headers=AUTH
        ).json()
        assert health["container_state"] == "exited"
        assert health["restart_count"] == 7
        assert health["healthy"] is False

    def test_an_unknown_client_is_404(self, hub):
        response = hub.http.get(
            f"/api/v1/clients/{uuid.uuid4()}/health", headers=AUTH
        )
        assert response.status_code == 404
        assert response.json()["error"] == "client_not_found"

    def test_a_malformed_client_id_is_422(self, hub):
        assert (
            hub.http.get("/api/v1/clients/not-a-uuid/health", headers=AUTH).status_code
            == 422
        )


# ======================================================================
# 4. error handling
# ======================================================================
class TestMissingAndInvalidParameters:
    @pytest.mark.parametrize(
        ("missing", "field"),
        [
            ("company_name", "company_name"),
            ("openrouter_api_key", "openrouter_api_key"),
            ("contact_email", "contact_email"),
        ],
    )
    def test_a_missing_required_field_is_422_and_names_it(self, hub, missing, field):
        payload = {
            "company_name": "Acme Widgets",
            "openrouter_api_key": PROVIDER_KEY,
            "contact_email": "ops@acme.example.com",
        }
        del payload[missing]
        response = hub.http.post(
            "/api/v1/clients/onboard", json=payload, headers=AUTH
        )
        assert response.status_code == 422
        assert any(
            field in detail["loc"] for detail in response.json()["detail"]
        )
        assert hub.docker.create_calls == []

    def test_an_empty_body_is_422(self, hub):
        assert (
            hub.http.post("/api/v1/clients/onboard", json={}, headers=AUTH).status_code
            == 422
        )

    @pytest.mark.parametrize(
        "bad",
        [
            {"company_name": "A"},                       # below min_length
            {"company_name": "x" * 201},                 # above max_length
            {"openrouter_api_key": "short"},             # below min_length
            {"contact_email": "not-an-email"},
            {"contact_email": "ops@acme.test"},          # reserved TLD
            {"plan": "enterprise"},                      # not a known plan
            {"subdomain": "a" * 64},                     # beyond a DNS label
            {"subdomain": "ß" * 40},                     # beyond one once slugified
            {"config": "not-an-object"},
            {"channels": ["not", "an", "object"]},
        ],
    )
    def test_invalid_values_are_422(self, hub, bad):
        assert hub.onboard(**bad).status_code == 422
        assert hub.docker.create_calls == []

    def test_a_422_leaves_no_client_row_behind(self, hub):
        hub.onboard(contact_email="nope")
        assert hub.http.get("/api/v1/clients", headers=AUTH).json()["total"] == 0


class TestDuplicateAndReservedSubdomains:
    def test_a_duplicate_subdomain_is_409(self, hub):
        assert hub.onboard().status_code == 201
        response = hub.onboard()
        assert response.status_code == 409
        assert response.json()["error"] == "client_conflict"
        assert "already taken" in response.json()["detail"]

    def test_a_duplicate_does_not_disturb_the_existing_tenant(self, hub):
        first = hub.onboard().json()
        hub.onboard()
        # No second container, and the original is untouched.
        assert len(hub.docker.create_calls) == 1
        health = hub.http.get(
            f"/api/v1/clients/{first['client_id']}/health", headers=AUTH
        ).json()
        assert health["healthy"] is True

    def test_a_collision_on_the_derived_subdomain_is_also_409(self, hub):
        # Two companies with the same name resolve to the same DNS label.
        assert hub.onboard(subdomain=None).status_code == 201
        assert hub.onboard(subdomain=None).status_code == 409

    @pytest.mark.parametrize("reserved", ["api", "admin", "www", "dashboard", "hub"])
    def test_a_reserved_subdomain_is_409(self, hub, reserved):
        # These would shadow the agency's own routes.
        response = hub.onboard(subdomain=reserved)
        assert response.status_code == 409
        assert "reserved" in response.json()["detail"]

    def test_a_subdomain_freed_by_a_purge_can_be_reused(self, hub):
        client_id = hub.onboard().json()["client_id"]
        hub.http.delete(
            f"/api/v1/clients/{client_id}?purge=true", headers=AUTH
        )
        assert hub.onboard().status_code == 201


class TestUpstreamFailureMapping:
    def test_a_daemon_failure_is_502_not_500(self, hub):
        # The hub is fine; its dependency is not.
        hub.docker.create_error = APIError("no space left on device")
        response = hub.onboard()
        assert response.status_code == 502
        assert response.json()["error"] == "orchestrator_error"

    def test_port_exhaustion_is_503_because_it_is_capacity(self, hub):
        # The same request succeeds once a port frees up.
        hub.settings.dash_port_range = (19000, 19000)
        assert hub.onboard(subdomain="first").status_code == 201
        response = hub.onboard(
            subdomain="second", contact_email="ops2@example.com"
        )
        assert response.status_code == 503
        assert response.json()["error"] == "no_port_available"

    def test_an_unreachable_daemon_is_502_not_500(self, hub, monkeypatch):
        # No cached client, so this goes through the real from_env path.
        from src.orchestrator import docker_service as docker_module

        def refuse():
            raise DockerException("Error while fetching server API version")

        monkeypatch.setattr(docker_module.docker, "from_env", refuse)
        hub.docker_service._client = None
        response = hub.onboard()
        assert response.status_code == 502
        assert response.json()["error"] == "orchestrator_error"
        assert "Cannot reach Docker daemon" in response.json()["detail"]

    def test_health_still_answers_when_the_daemon_is_lost(self, hub, monkeypatch):
        # A health endpoint that errors out is useless precisely when it matters.
        client_id = hub.onboard().json()["client_id"]

        def refuse(_):
            raise RequestsConnectionError("connection aborted")

        monkeypatch.setattr(hub.docker.containers, "get", refuse)
        response = hub.http.get(f"/api/v1/clients/{client_id}/health", headers=AUTH)
        assert response.status_code == 200
        assert response.json()["container_state"] == "unknown"
        assert response.json()["healthy"] is False

    def test_a_failed_provision_is_recorded_for_reconciliation(self, hub):
        hub.docker.create_error = APIError("no space left on device")
        assert hub.onboard().status_code == 502

        items = hub.http.get("/api/v1/clients", headers=AUTH).json()["items"]
        assert items, "the failed onboarding left no client row"
        record = items[0]
        assert record["subscription_status"] == "failed"
        assert "no space left" in record["status_detail"]
        # Ports released, and no container left behind.
        assert record["container_port_dash"] is None
        assert record["container_id"] is None
        assert hub.docker.containers_by_name.get("hermes-client-acme") is None

        entries = hub.http.get(
            f"/api/v1/clients/{record['id']}/audit", headers=AUTH
        ).json()
        statuses = {e["status"] for e in entries if e["action"] == "provision"}
        assert statuses == {"started", "failed"}


class TestRetryAfterFailure:
    """A failed run keeps its row, but must not burn the subdomain."""

    def test_resubmitting_resumes_the_same_client(self, hub):
        hub.docker.create_error = APIError("no space left on device")
        assert hub.onboard().status_code == 502
        failed_id = hub.http.get("/api/v1/clients", headers=AUTH).json()["items"][0]["id"]

        hub.docker.create_error = None
        retry = hub.onboard()
        assert retry.status_code == 201
        body = retry.json()
        assert body["client_id"] == failed_id
        assert body["status"] == "active"
        assert body["container_port_dash"] == 19000
        assert hub.http.get("/api/v1/clients", headers=AUTH).json()["total"] == 1

        # The credentials from the retry are the ones deployed.
        env = parse_env(hub.env_text(body["subdomain"]))
        assert env["API_SERVER_KEY"] == body["api_key"]
        assert verify_dashboard_password(
            body["dashboard_password"], env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"]
        )

        # The earlier failure stays on the record.
        entries = hub.http.get(
            f"/api/v1/clients/{failed_id}/audit", headers=AUTH
        ).json()
        recorded = {(e["action"], e["status"]) for e in entries}
        assert ("provision", "failed") in recorded
        assert ("retried", "succeeded") in recorded
        assert ("provision", "succeeded") in recorded

    def test_the_retry_applies_the_resubmitted_request(self, hub):
        # A bad image may be exactly why the first attempt failed.
        hub.docker.create_error = APIError("no space left on device")
        hub.onboard(image="broken/image:1")

        hub.docker.create_error = None
        body = hub.onboard(image="fixed/image:2", plan="growth").json()
        assert hub.docker.created_for(body["container_name"])["image"] == "fixed/image:2"
        record = hub.http.get(f"/api/v1/clients/{body['client_id']}", headers=AUTH).json()
        assert record["plan"] == "growth"
        assert record["image"] == "fixed/image:2"

    def test_port_exhaustion_succeeds_once_a_port_frees_up(self, hub):
        # main.py maps this to 503 because the same request succeeds later.
        hub.settings.dash_port_range = (19000, 19000)
        first = hub.onboard(subdomain="first").json()
        second = {"subdomain": "second", "contact_email": "ops2@example.com"}
        assert hub.onboard(**second).status_code == 503

        hub.http.delete(f"/api/v1/clients/{first['client_id']}", headers=AUTH)
        assert hub.onboard(**second).status_code == 201

    def test_a_different_contact_cannot_take_over_a_failed_subdomain(self, hub):
        # A retry mounts the existing tenant directory, so this must not be one.
        hub.docker.create_error = APIError("no space left on device")
        hub.onboard()

        hub.docker.create_error = None
        response = hub.onboard(contact_email="someone-else@example.com")
        assert response.status_code == 409
        assert hub.docker.containers_by_name.get("hermes-client-acme") is None

    def test_an_unhealthy_tenant_is_not_replaced_by_a_resubmission(self, hub):
        # Also FAILED, but its container is up and its credentials are live.
        hub.probe.reachable = False
        first = hub.onboard().json()
        assert first["status"] == "failed"
        container = hub.docker.containers_by_name[first["container_name"]]

        assert hub.onboard().status_code == 409
        assert hub.docker.containers_by_name[first["container_name"]] is container
        assert hub.docker.removed == []
        env = parse_env(hub.env_text(first["subdomain"]))
        assert env["API_SERVER_KEY"] == first["api_key"]

    def test_an_unhealthy_tenant_returns_201_with_a_warning(self, hub):
        # The tenant exists and its credentials are real; it is simply not
        # answering yet. Withholding them would strand it.
        hub.probe.reachable = False
        response = hub.onboard()
        body = response.json()

        assert response.status_code == 201
        assert body["status"] == "failed"
        assert body["warning"]
        assert body["api_key"] and body["dashboard_password"]
        # Left running on purpose, so the operator can read `docker logs`.
        assert hub.docker.removed == []


# ======================================================================
# 5. teardown
# ======================================================================
class TestTeardownEndpoint:
    def test_archives_by_default(self, hub):
        body = hub.onboard().json()
        response = hub.http.delete(
            f"/api/v1/clients/{body['client_id']}", headers=AUTH
        )
        assert response.status_code == 200

        result = response.json()
        assert result["status"] == "archived"
        assert result["container_removed"] is True
        assert result["archive_path"]
        # Moved, not copied: a tenant's secrets must not end up in two places.
        assert not hub.tenant_dir(body["subdomain"]).exists()

    def test_the_archive_keeps_the_tenants_data(self, hub):
        from pathlib import Path

        body = hub.onboard().json()
        tenant_dir = hub.tenant_dir(body["subdomain"])
        (tenant_dir / "conversations").mkdir()
        (tenant_dir / "conversations" / "thread.json").write_text("{}", "utf-8")

        result = hub.http.delete(
            f"/api/v1/clients/{body['client_id']}", headers=AUTH
        ).json()
        archive = Path(result["archive_path"])
        assert (archive / ".env").is_file()
        assert (archive / "conversations" / "thread.json").is_file()

    def test_archive_false_discards_the_data(self, hub):
        body = hub.onboard().json()
        result = hub.http.delete(
            f"/api/v1/clients/{body['client_id']}?archive=false", headers=AUTH
        ).json()
        assert result["archive_path"] is None
        assert not hub.tenant_dir(body["subdomain"]).exists()

    def test_the_row_survives_by_default(self, hub):
        # The audit history of a decommissioned tenant is usually worth keeping.
        client_id = hub.onboard().json()["client_id"]
        hub.http.delete(f"/api/v1/clients/{client_id}", headers=AUTH)
        record = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH)
        assert record.status_code == 200
        assert record.json()["subscription_status"] == "archived"

    def test_purge_removes_the_row_and_its_audit_trail(self, hub):
        client_id = hub.onboard().json()["client_id"]
        hub.http.delete(f"/api/v1/clients/{client_id}?purge=true", headers=AUTH)
        assert (
            hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).status_code
            == 404
        )

    def test_the_container_is_stopped_and_removed(self, hub):
        body = hub.onboard().json()
        hub.http.delete(f"/api/v1/clients/{body['client_id']}", headers=AUTH)
        assert body["container_name"] in hub.docker.removed
        assert body["container_name"] not in hub.docker.containers_by_name

    def test_the_freed_ports_are_handed_to_the_next_tenant(self, hub):
        first = hub.onboard().json()
        hub.http.delete(f"/api/v1/clients/{first['client_id']}", headers=AUTH)
        second = hub.onboard(
            subdomain="globex", contact_email="ops@globex.example.com"
        ).json()
        assert second["container_port_dash"] == first["container_port_dash"]

    def test_an_unknown_client_is_404(self, hub):
        response = hub.http.delete(f"/api/v1/clients/{uuid.uuid4()}", headers=AUTH)
        assert response.status_code == 404
        assert response.json()["error"] == "client_not_found"

    def test_tearing_down_twice_is_not_an_error(self, hub):
        # Teardown has to finish on a partially broken deployment.
        client_id = hub.onboard().json()["client_id"]
        assert (
            hub.http.delete(f"/api/v1/clients/{client_id}", headers=AUTH).status_code
            == 200
        )
        assert (
            hub.http.delete(f"/api/v1/clients/{client_id}", headers=AUTH).status_code
            == 200
        )


# ======================================================================
# 6. reads and updates
# ======================================================================
class TestReads:
    def test_the_list_is_paginated(self, hub):
        for index in range(3):
            hub.onboard(
                subdomain=f"tenant-{index}",
                company_name=f"Tenant {index} Ltd",
                contact_email=f"ops{index}@example.com",
            )
        body = hub.http.get("/api/v1/clients?limit=2", headers=AUTH).json()
        assert body["total"] == 3
        assert len(body["items"]) == 2
        assert body["limit"] == 2

        page_two = hub.http.get(
            "/api/v1/clients?limit=2&offset=2", headers=AUTH
        ).json()
        assert len(page_two["items"]) == 1

    @pytest.mark.parametrize(
        ("query", "expected"), [("acme", 1), ("ACME", 1), ("widgets", 1), ("zzz", 0)]
    )
    def test_search_matches_case_insensitively(self, hub, query, expected):
        hub.onboard()
        body = hub.http.get(f"/api/v1/clients?q={query}", headers=AUTH).json()
        assert body["total"] == expected

    def test_filters_by_status_and_plan(self, hub):
        hub.onboard(plan="growth")
        assert (
            hub.http.get(
                "/api/v1/clients?plan=growth", headers=AUTH
            ).json()["total"]
            == 1
        )
        assert (
            hub.http.get(
                "/api/v1/clients?subscription_status=archived", headers=AUTH
            ).json()["total"]
            == 0
        )

    def test_the_list_carries_the_public_url(self, hub):
        hub.onboard()
        item = hub.http.get("/api/v1/clients", headers=AUTH).json()["items"][0]
        assert item["url"] == "http://acme.localhost"

    def test_stats_is_not_parsed_as_a_client_id(self, hub):
        # /stats is declared before /{client_id}; if that order regressed this
        # would 422 trying to coerce "stats" into a UUID.
        hub.onboard()
        response = hub.http.get("/api/v1/clients/stats", headers=AUTH)
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert body["by_status"] == {"active": 1}
        assert body["by_plan"] == {"starter": 1}
        assert body["running_containers"] == 1

    def test_logs_are_tailed_from_the_container(self, hub):
        client_id = hub.onboard().json()["client_id"]
        body = hub.http.get(
            f"/api/v1/clients/{client_id}/logs?tail=50", headers=AUTH
        ).json()
        assert "[stage2] Setup complete; starting user services" in body["lines"]

    @pytest.mark.parametrize("tail", [0, 5001])
    def test_an_out_of_range_tail_is_422(self, hub, tail):
        client_id = hub.onboard().json()["client_id"]
        assert (
            hub.http.get(
                f"/api/v1/clients/{client_id}/logs?tail={tail}", headers=AUTH
            ).status_code
            == 422
        )


class TestUpdates:
    def test_a_plan_change_updates_the_recorded_envelope(self, hub):
        client_id = hub.onboard().json()["client_id"]
        response = hub.http.patch(
            f"/api/v1/clients/{client_id}",
            json={"plan": "scale"},
            headers=AUTH,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["plan"] == "scale"
        # Docker cannot resize a running container's limits in place, so the
        # row records the new envelope and the container keeps the old one
        # until it is re-provisioned.
        assert body["cpu_limit"] == 1.0
        assert body["memory_limit"] == "2g"

    def test_an_update_is_persisted(self, hub):
        # The response alone cannot show this: a failure after the flush rolls
        # the change back, and a later request reads the old value.
        client_id = hub.onboard().json()["client_id"]
        hub.http.patch(
            f"/api/v1/clients/{client_id}",
            json={"company_name": "Acme Widgets International"},
            headers=AUTH,
        )
        record = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()
        assert record["company_name"] == "Acme Widgets International"

    def test_metadata_updates_are_audited(self, hub):
        client_id = hub.onboard().json()["client_id"]
        assert (
            hub.http.patch(
                f"/api/v1/clients/{client_id}",
                json={"company_name": "Acme Widgets International"},
                headers=AUTH,
            ).status_code
            == 200
        )
        entries = hub.http.get(
            f"/api/v1/clients/{client_id}/audit", headers=AUTH
        ).json()
        assert any(entry["action"] == "updated" for entry in entries)

    def test_an_invalid_update_is_422(self, hub):
        client_id = hub.onboard().json()["client_id"]
        assert (
            hub.http.patch(
                f"/api/v1/clients/{client_id}",
                json={"contact_email": "nope"},
                headers=AUTH,
            ).status_code
            == 422
        )

    def test_updating_an_unknown_client_is_404(self, hub):
        assert (
            hub.http.patch(
                f"/api/v1/clients/{uuid.uuid4()}",
                json={"plan": "growth"},
                headers=AUTH,
            ).status_code
            == 404
        )


# ======================================================================
# 7. the whole thing, in order
# ======================================================================
def test_the_complete_tenant_lifecycle(hub):
    """Onboard, verify, inspect, update, tear down — in one pass.

    Each step above is checked in isolation; this one checks that they compose,
    which is where ordering bugs (``/stats`` shadowed by ``/{client_id}``, a
    port not released on teardown, a status left in ``provisioning``) show up.
    """
    from pathlib import Path

    # 1. onboard
    body = hub.onboard().json()
    client_id = body["client_id"]
    assert body["status"] == "active"

    # 2. the credentials work against what was deployed
    env = parse_env(hub.env_text(body["subdomain"]))
    assert verify_dashboard_password(
        body["dashboard_password"], env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"]
    )
    assert env["API_SERVER_KEY"] == body["api_key"]

    # 3. it reports healthy
    assert hub.http.get(
        f"/api/v1/clients/{client_id}/health", headers=AUTH
    ).json()["healthy"]

    # 4. it appears in the fleet view
    assert hub.http.get("/api/v1/clients/stats", headers=AUTH).json()["total"] == 1

    # 5. it can be reconfigured, and its logs and audit trail are reachable
    assert (
        hub.http.patch(
            f"/api/v1/clients/{client_id}", json={"plan": "growth"}, headers=AUTH
        ).json()["plan"]
        == "growth"
    )
    assert hub.http.get(
        f"/api/v1/clients/{client_id}/logs", headers=AUTH
    ).json()["lines"]
    assert hub.http.get(f"/api/v1/clients/{client_id}/audit", headers=AUTH).json()

    # 6. the agent wrote data we must not lose
    (hub.tenant_dir(body["subdomain"]) / "conversations").mkdir()
    (hub.tenant_dir(body["subdomain"]) / "conversations" / "t.json").write_text(
        '{"id": 1}', encoding="utf-8"
    )

    # 7. teardown archives it
    result = hub.http.delete(f"/api/v1/clients/{client_id}", headers=AUTH).json()
    assert (
        Path(result["archive_path"]) / "conversations" / "t.json"
    ).read_text(encoding="utf-8") == '{"id": 1}'

    # 8. nothing is left running, and the ports are free again
    assert body["container_name"] not in hub.docker.containers_by_name
    record = hub.http.get(f"/api/v1/clients/{client_id}", headers=AUTH).json()
    assert record["subscription_status"] == "archived"
    assert record["container_port_dash"] is None

    reused = hub.onboard(
        subdomain="globex", contact_email="ops@globex.example.com"
    ).json()
    assert reused["container_port_dash"] == body["container_port_dash"]
