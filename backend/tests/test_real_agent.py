"""A real tenant on the real agent image, through the running stack.

Every other layer fakes the Docker SDK or substitutes a small stand-in image, so
none of them can notice that the agent itself fails to come up. The contract with
the image's s6 scripts is only checkable here: which settings they read from the
container environment, and what keeps the supervision tree alive. So is the
compose file's half of the job, such as the skill library reaching the hub.

This drives the stack over HTTP rather than building a hub in-process, because
tenant files must live where the Docker daemon sees real permissions. A host temp
directory does not qualify on Docker Desktop, where it mounts as 0777 and the
agent refuses to run.

Opt in with the stack running and the agent image pulled:

    HERMES_TEST_AGENT=1 HERMES_TEST_ADMIN_KEY=<key> pytest -m agent

``HERMES_TEST_HUB_URL`` and ``HERMES_TEST_NGINX_URL`` override where to find it.
"""

from __future__ import annotations

import os
import time
from typing import Any, Iterator

import httpx
import pytest

from conftest import assert_hardened

pytestmark = [pytest.mark.agent, pytest.mark.slow]

LIVE_AGENT = os.environ.get("HERMES_TEST_AGENT") == "1"
HUB_URL = os.environ.get("HERMES_TEST_HUB_URL", "http://localhost:8080")
NGINX_URL = os.environ.get("HERMES_TEST_NGINX_URL", "http://localhost")
ADMIN_KEY = os.environ.get("HERMES_TEST_ADMIN_KEY", "")
#: Longer than the hub's own health timeout, so the hub reports that failure itself.
ONBOARD_TIMEOUT_SECONDS = 300
#: Bare `hermes` took about 15s to exit and bring the services down with it, after
#: both had already answered a probe, so one healthy probe proves too little.
SETTLE_SECONDS = 30
SLUG = "agent-image-check"
CONTAINER = f"hermes-client-{SLUG}"


@pytest.fixture
def hub() -> Iterator[httpx.Client]:
    """The admin API. Having opted in, a missing stack fails instead of skipping."""
    if not LIVE_AGENT:
        pytest.skip("real agent tests are opt-in: set HERMES_TEST_AGENT=1")
    if not ADMIN_KEY:
        pytest.fail("HERMES_TEST_AGENT=1 also needs HERMES_TEST_ADMIN_KEY")
    with httpx.Client(
        base_url=f"{HUB_URL}/api/v1", headers={"X-API-Key": ADMIN_KEY}, timeout=30
    ) as client:
        try:
            client.get("/clients", params={"limit": 1}).raise_for_status()
        except httpx.HTTPError as exc:
            pytest.fail(f"The hub at {HUB_URL} is not usable; is the stack up? {exc}")
        yield client


def _remove_tenant(hub: httpx.Client) -> None:
    for item in hub.get("/clients", params={"q": SLUG}).json()["items"]:
        if item["slug"] == SLUG:
            hub.delete(
                f"/clients/{item['id']}",
                params={"archive": "false", "purge": "true"},
                timeout=120,
            ).raise_for_status()


@pytest.fixture
def tenant(hub: httpx.Client) -> Iterator[dict[str, Any]]:
    """A freshly onboarded tenant, removed again however the test ends."""
    _remove_tenant(hub)  # left behind by a run that was killed partway
    try:
        response = hub.post(
            "/clients/onboard",
            json={
                "company_name": "Agent Image Check",
                "subdomain": SLUG,
                "contact_email": "ops@acme.com",
                "openrouter_api_key": "sk-or-v1-notarealkey",
            },
            timeout=ONBOARD_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        yield response.json()
    finally:
        _remove_tenant(hub)


@pytest.fixture
def container() -> Iterator[Any]:
    import docker as docker_sdk

    client = docker_sdk.from_env()
    try:
        yield client.containers.get(CONTAINER)
    finally:
        client.close()


def _logs(container: Any) -> str:
    return container.logs(tail=30).decode("utf-8", errors="replace")


def test_a_new_tenant_comes_up_and_stays_up(
    hub: httpx.Client, tenant: dict[str, Any], container: Any
):
    assert tenant["status"] == "active", f"{tenant['warning']}\n{_logs(container)}"
    assert tenant["warning"] is None
    assert "lead-qualification" in tenant["synced_skills"]

    time.sleep(SETTLE_SECONDS)

    # s6 keeps answering "up" during its shutdown, and only "want down" gives it
    # away, so a probe alone would pass while the supervisor was going down.
    for service in ("dashboard", "gateway-default"):
        exit_code, output = container.exec_run(["/command/s6-svstat", f"/run/service/{service}"])
        status = output.decode("utf-8", errors="replace")
        assert exit_code == 0 and status.startswith("up"), f"{service}: {status}\n{_logs(container)}"
        assert "want down" not in status, f"{service}: {status}\n{_logs(container)}"

    health = hub.get(f"/clients/{tenant['client_id']}/health").json()
    assert health["healthy"] is True, health

    container.reload()
    dash_port, api_port = tenant["container_port_dash"], tenant["container_port_api"]
    assert_hardened(
        container.attrs["HostConfig"],
        expected_ports={"9119/tcp": dash_port, "8642/tcp": api_port},
    )

    with httpx.Client(timeout=15) as http:
        # The hub's scrypt hash, verified by the image's own provider.
        accepted = http.post(
            f"http://127.0.0.1:{dash_port}/auth/password-login",
            json={
                "provider": "basic",
                "username": tenant["dashboard_username"],
                "password": tenant["dashboard_password"],
            },
        )
        refused = http.post(
            f"http://127.0.0.1:{dash_port}/auth/password-login",
            json={"provider": "basic", "username": "admin", "password": "wrong-password"},
        )
        authorized = http.get(
            f"http://127.0.0.1:{api_port}/v1/models",
            headers={"Authorization": f"Bearer {tenant['api_key']}"},
        )
        anonymous = http.get(f"http://127.0.0.1:{api_port}/v1/models")
        routed = http.get(
            f"{NGINX_URL}/api/health", headers={"Host": f"{SLUG}.localhost"}
        )

        token = hub.post(f"/clients/{tenant['client_id']}/portal-token").json()["token"]
        # Reads files the agent keeps at 0600, which only works when the hub and
        # the tenant share a uid, and needs the skill library to have reached the hub.
        vault = http.get(
            f"{HUB_URL}/api/v1/portal/{SLUG}/skills-and-memory",
            headers={"X-Client-Portal-Token": token},
        )

    assert accepted.status_code == 200
    assert refused.status_code == 401
    assert authorized.status_code == 200
    assert anonymous.status_code == 401
    assert routed.status_code == 200
    assert routed.headers["X-Hermes-Tenant"] == SLUG
    assert vault.status_code == 200
    assert "lead-qualification" in [
        skill["id"] for skill in vault.json()["agency_verified_skills"]
    ]
