"""The HTTP layer: authentication, status-code mapping, response shapes.

The provisioner is stubbed here — its behaviour is covered in
test_provisioner.py. What matters at this layer is that the admin key is
enforced, that domain exceptions become the right status codes, and that the
onboarding response actually carries the credentials a caller needs.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.clients.models import SubscriptionStatus
from src.clients.service import ClientConflictError
from src.config.database import Base, get_session
from src.config.settings import get_settings
from src.main import app
from src.orchestrator.credentials import generate_tenant_credentials
from src.orchestrator.docker_service import OrchestratorError, get_docker_service
from src.orchestrator.provisioner import (
    ProvisionResult,
    TeardownResult,
    get_provisioner,
)
from src.proxy.service import NoPortAvailableError

ADMIN_KEY = "test-admin-key"
AUTH = {"X-API-Key": ADMIN_KEY}


class StubProvisioner:
    """Satisfies the provisioner contract without touching anything real."""

    def __init__(self, *, error: Exception | None = None, healthy: bool = True) -> None:
        self.error = error
        self.healthy = healthy
        self.torn_down: list[uuid.UUID] = []

    async def provision_client(self, session, client, openrouter_api_key):
        if self.error:
            raise self.error
        credentials = generate_tenant_credentials(client.subdomain)
        for field, value in credentials.as_persistable().items():
            setattr(client, field, value)
        client.container_name = f"hermes-client-{client.slug}"
        client.container_port_dash = 19000
        client.container_port_api = 19500
        client.subscription_status = (
            SubscriptionStatus.ACTIVE if self.healthy else SubscriptionStatus.FAILED
        )
        await session.flush()
        return ProvisionResult(
            credentials=credentials,
            healthy=self.healthy,
            detail="ok" if self.healthy else "probe timed out",
            synced_skills=["sales-rep-inbox"],
        )

    async def teardown_client(self, session, client, *, archive=True):
        self.torn_down.append(client.id)
        client.subscription_status = SubscriptionStatus.ARCHIVED
        await session.flush()
        return TeardownResult(
            container_removed=True,
            proxy_removed=True,
            archive_path=Path("/srv/hermes-multi/archive/x") if archive else None,
        )

    async def health_check(self, client):
        return {
            "container_state": "running",
            "container_id": "abc123",
            "container_health": None,
            "started_at": "2026-11-02T00:00:00Z",
            "restart_count": 0,
            "dashboard": {
                "url": "http://d/api/health", "reachable": True,
                "status": 200, "latency_ms": 2.0, "error": None,
            },
            "api": {
                "url": "http://a/health", "reachable": True,
                "status": 200, "latency_ms": 1.0, "error": None,
            },
            "healthy": True,
        }


class StubDocker:
    async def running_count(self) -> int:
        return 1

    async def logs(self, name, tail=200) -> list[str]:
        return ["[stage2] Setup complete; starting user services"]


@pytest_asyncio.fixture
async def api(tmp_path: Path, monkeypatch):
    """A TestClient with the database and provisioner swapped out.

    Not used as a context manager on purpose: that would run the real
    lifespan, which tries to reach Docker and prepare /srv.
    """
    monkeypatch.setenv("ADMIN_API_KEY", ADMIN_KEY)
    monkeypatch.setenv("DATA_ROOT", str(tmp_path / "hermes"))
    monkeypatch.setenv("NGINX_CONTROL_MODE", "none")
    get_settings.cache_clear()

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'api.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _session():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    stub = StubProvisioner()
    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_provisioner] = lambda: stub
    app.dependency_overrides[get_docker_service] = lambda: StubDocker()

    client = TestClient(app, raise_server_exceptions=False)
    client.stub = stub  # type: ignore[attr-defined]
    yield client

    app.dependency_overrides.clear()
    get_settings.cache_clear()
    await engine.dispose()


def onboard_payload(**overrides) -> dict:
    body = {
        "company_name": "Acme Widgets",
        "subdomain": "acme",
        "openrouter_api_key": "sk-or-v1-abcdefghijkl",
        "contact_email": "ops@acme.example.com",
    }
    body.update(overrides)
    return body


# ----------------------------------------------------------------- auth
class TestAuthentication:
    def test_missing_key_is_rejected(self, api):
        assert api.get("/api/v1/clients").status_code == 401

    def test_wrong_key_is_rejected(self, api):
        response = api.get("/api/v1/clients", headers={"X-API-Key": "nope"})
        assert response.status_code == 401

    def test_correct_key_is_accepted(self, api):
        assert api.get("/api/v1/clients", headers=AUTH).status_code == 200

    def test_onboarding_is_protected(self, api):
        # The most destructive route must not be reachable unauthenticated.
        response = api.post("/api/v1/clients/onboard", json=onboard_payload())
        assert response.status_code == 401

    def test_liveness_is_open(self, api):
        # Load balancers cannot send an admin key.
        assert api.get("/healthz").status_code == 200


# ------------------------------------------------------------- onboarding
class TestOnboard:
    def test_returns_201_with_usable_credentials(self, api):
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert response.status_code == 201
        body = response.json()
        assert body["subdomain"] == "acme.localhost"
        assert body["dashboard_username"] == "admin"
        assert body["dashboard_password"]
        assert body["api_key"].startswith("sk-acme.localhost-")
        assert body["dashboard_url"] == "http://acme.localhost"
        assert body["api_base_url"] == "http://acme.localhost/v1"
        assert body["status"] == "active"
        assert body["warning"] is None

    def test_derives_the_subdomain_from_the_company_name(self, api):
        body = api.post(
            "/api/v1/clients/onboard",
            json={
                "company_name": "Globex Corporation",
                "openrouter_api_key": "sk-or-v1-abcdefghijkl",
                "contact_email": "ops@globex.example.com",
            },
            headers=AUTH,
        ).json()
        assert body["subdomain"] == "globex-corporation.localhost"

    def test_duplicate_subdomain_is_409(self, api):
        api.post("/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH)
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert response.status_code == 409
        assert response.json()["error"] == "client_conflict"

    def test_reserved_subdomain_is_409(self, api):
        response = api.post(
            "/api/v1/clients/onboard",
            json=onboard_payload(subdomain="api"),
            headers=AUTH,
        )
        assert response.status_code == 409
        assert "reserved" in response.json()["detail"]

    def test_unhealthy_tenant_still_returns_credentials_with_a_warning(self, api):
        api.stub.healthy = False
        body = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        ).json()
        assert body["status"] == "failed"
        assert body["warning"] == "probe timed out"
        assert body["api_key"]  # the tenant exists; do not strand it

    @pytest.mark.parametrize(
        "bad",
        [
            {"company_name": "A"},                      # too short
            {"openrouter_api_key": "x"},                # too short
            {"contact_email": "not-an-email"},
        ],
    )
    def test_invalid_input_is_422(self, api, bad):
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(**bad), headers=AUTH
        )
        assert response.status_code == 422

    def test_openrouter_key_is_never_echoed_back(self, api):
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert "sk-or-v1-abcdefghijkl" not in response.text


class TestOnboardErrorMapping:
    """Domain exceptions must become the right status code, centrally."""

    def test_docker_failure_is_502(self, api):
        api.stub.error = OrchestratorError("daemon unreachable")
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert response.status_code == 502
        assert response.json()["error"] == "orchestrator_error"

    def test_port_exhaustion_is_503(self, api):
        # Capacity, not a client mistake: the same request succeeds later.
        api.stub.error = NoPortAvailableError("no free dashboard port")
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert response.status_code == 503
        assert response.json()["error"] == "no_port_available"

    def test_conflict_from_the_service_is_409(self, api):
        api.stub.error = ClientConflictError("slug taken")
        response = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        )
        assert response.status_code == 409


# --------------------------------------------------------------- teardown
class TestDelete:
    def _onboard(self, api) -> str:
        return api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        ).json()["client_id"]

    def test_archives_by_default(self, api):
        client_id = self._onboard(api)
        body = api.delete(f"/api/v1/clients/{client_id}", headers=AUTH).json()
        assert body["status"] == "archived"
        assert body["container_removed"] is True
        assert body["archive_path"]

    def test_archive_false_reports_no_archive(self, api):
        client_id = self._onboard(api)
        body = api.delete(
            f"/api/v1/clients/{client_id}?archive=false", headers=AUTH
        ).json()
        assert body["archive_path"] is None

    def test_unknown_client_is_404(self, api):
        response = api.delete(f"/api/v1/clients/{uuid.uuid4()}", headers=AUTH)
        assert response.status_code == 404
        assert response.json()["error"] == "client_not_found"

    def test_purge_removes_the_row(self, api):
        client_id = self._onboard(api)
        api.delete(f"/api/v1/clients/{client_id}?purge=true", headers=AUTH)
        assert api.get(f"/api/v1/clients/{client_id}", headers=AUTH).status_code == 404

    def test_without_purge_the_row_survives(self, api):
        # The audit history of a decommissioned tenant is worth keeping.
        client_id = self._onboard(api)
        api.delete(f"/api/v1/clients/{client_id}", headers=AUTH)
        assert api.get(f"/api/v1/clients/{client_id}", headers=AUTH).status_code == 200


# ----------------------------------------------------------------- health
class TestHealth:
    def test_reports_both_probes(self, api):
        client_id = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        ).json()["client_id"]
        body = api.get(f"/api/v1/clients/{client_id}/health", headers=AUTH).json()
        assert body["healthy"] is True
        assert body["container_state"] == "running"
        assert body["dashboard"]["status"] == 200
        assert body["api"]["status"] == 200

    def test_unknown_client_is_404(self, api):
        response = api.get(f"/api/v1/clients/{uuid.uuid4()}/health", headers=AUTH)
        assert response.status_code == 404


# ------------------------------------------------------------------ reads
class TestReads:
    def test_list_is_paginated_and_leaks_no_secrets(self, api):
        api.post("/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH)
        body = api.get("/api/v1/clients", headers=AUTH).json()
        assert body["total"] == 1
        item = body["items"][0]
        assert item["url"] == "http://acme.localhost"
        # ClientRead must never expose the hash, secret or bearer token.
        for leaked in ("api_key", "dashboard_password_hash", "dashboard_secret"):
            assert leaked not in item

    def test_search_filters_by_company_name(self, api):
        api.post("/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH)
        assert api.get("/api/v1/clients?q=acme", headers=AUTH).json()["total"] == 1
        assert api.get("/api/v1/clients?q=zzz", headers=AUTH).json()["total"] == 0

    def test_stats_is_not_parsed_as_a_client_id(self, api):
        # /stats is declared before /{client_id}; if that order regressed this
        # would 422 trying to coerce "stats" into a UUID.
        response = api.get("/api/v1/clients/stats", headers=AUTH)
        assert response.status_code == 200
        assert response.json()["running_containers"] == 1

    def test_audit_trail_is_readable(self, api):
        client_id = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        ).json()["client_id"]
        entries = api.get(f"/api/v1/clients/{client_id}/audit", headers=AUTH).json()
        assert any(e["action"] == "created" for e in entries)

    def test_logs_are_returned(self, api):
        client_id = api.post(
            "/api/v1/clients/onboard", json=onboard_payload(), headers=AUTH
        ).json()["client_id"]
        body = api.get(f"/api/v1/clients/{client_id}/logs", headers=AUTH).json()
        assert "[stage2] Setup complete; starting user services" in body["lines"]
