"""Container lifecycle: what the hub actually asks the Docker daemon to do.

Two layers, deliberately separate:

:class:`TestDockerSdkCalls` and friends drive the **real** ``DockerService``
over a fake SDK client. This is the layer nothing else covers — a test that
stubs ``DockerService`` itself proves the provisioner called it, not that the
resulting container is capped and hardened. The fake synthesises the
``HostConfig`` a daemon would build, so :func:`conftest.assert_hardened` checks
the same contract here as it does against a real ``docker inspect`` in
:class:`TestLiveDockerEnvelope`.

The rest drive the **real** provisioner over that same fake, with a real
database and a real filesystem, because the provisioning sequence, its rollback
and its teardown are the only places all four kinds of state meet.

Opt in to the live-daemon tests with ``HERMES_TEST_DOCKER=1``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from docker.errors import APIError, DockerException, ImageNotFound
from requests.exceptions import ConnectionError as RequestsConnectionError

from conftest import (
    EXPECTED_CAP_ADD,
    FORBIDDEN_CAPS,
    LIVE_IMAGE,
    FakeDockerClient,
    assert_hardened,
    assert_no_secrets,
    build_provisioner,
)
from src.clients.models import AuditStatus, Client, SubscriptionStatus
from src.clients.service import list_audit_logs, used_ports
from src.orchestrator import docker_service as docker_module
from src.orchestrator.docker_service import (
    DockerService,
    OrchestratorError,
    PortCollisionError,
)

CONTAINER = "hermes-client-acme"
VOLUMES = {
    "/srv/hermes-multi/tenants/acme.localhost": {"bind": "/opt/data", "mode": "rw"},
    "/srv/hermes-multi/shared-skills": {
        "bind": "/opt/data/skills/agency_core",
        "mode": "ro",
    },
}


async def create_container(service: DockerService, **overrides):
    """Start a container through the production code path."""
    kwargs = {
        "name": CONTAINER,
        "image": "hermes/test-agent:latest",
        "environment": {"HERMES_HOME": "/opt/data"},
        "labels": {"hermes.hub.managed": "true"},
        "volumes": VOLUMES,
        "ports": service.port_bindings(19000, 19500),
    }
    kwargs.update(overrides)
    return await service.create_and_start(**kwargs)


# ======================================================================
# 1. the Docker SDK call surface
# ======================================================================
class TestDockerSdkCalls:
    async def test_the_full_envelope_reaches_the_daemon(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        container = fake_docker.containers_by_name[CONTAINER]
        assert_hardened(
            container.host_config,
            expected_ports={"9119/tcp": 19000, "8642/tcp": 19500},
        )

    async def test_resource_caps_are_passed_as_the_sdk_expects(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        call = fake_docker.created_for(CONTAINER)
        # nano_cpus, not `cpus`: the SDK has no high-level cpus argument, and
        # passing the wrong key silently leaves the container uncapped.
        assert call["nano_cpus"] == 1_000_000_000
        assert call["mem_limit"] == "2g"
        assert call["pids_limit"] == 200

    @pytest.mark.parametrize(
        ("cpus", "nano_cpus"),
        [(0.25, 250_000_000), (0.5, 500_000_000), (1.0, 1_000_000_000), (4, 4_000_000_000)],
    )
    async def test_fractional_cpu_caps_convert_without_rounding_to_zero(
        self, docker_service, fake_docker, cpus, nano_cpus
    ):
        # int(0.25 * 1e9) must not become 0 — an accidental 0 means "unlimited".
        await create_container(docker_service, cpus=cpus)
        assert fake_docker.created_for(CONTAINER)["nano_cpus"] == nano_cpus
        assert fake_docker.containers_by_name[CONTAINER].host_config["NanoCpus"] > 0

    @pytest.mark.parametrize(
        ("memory", "expected_bytes"),
        [("512m", 512 * 1024**2), ("2g", 2 * 1024**3), ("4g", 4 * 1024**3)],
    )
    async def test_memory_strings_resolve_to_the_intended_byte_count(
        self, docker_service, fake_docker, memory, expected_bytes
    ):
        await create_container(docker_service, memory=memory)
        assert (
            fake_docker.containers_by_name[CONTAINER].host_config["Memory"]
            == expected_bytes
        )

    async def test_per_plan_overrides_reach_the_daemon(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service, cpus=2.0, memory="4g")
        assert_hardened(
            fake_docker.containers_by_name[CONTAINER].host_config,
            cpus=2.0,
            memory="4g",
        )

    async def test_omitted_limits_fall_back_to_the_hard_caps(
        self, docker_service, fake_docker
    ):
        # A caller that forgets to pass limits must not get an uncapped tenant.
        await create_container(docker_service, cpus=None, memory=None)
        assert_hardened(fake_docker.containers_by_name[CONTAINER].host_config)

    async def test_capabilities_are_dropped_then_minimally_restored(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        call = fake_docker.created_for(CONTAINER)
        assert call["cap_drop"] == ["ALL"]
        assert set(call["cap_add"]) == EXPECTED_CAP_ADD
        assert not set(call["cap_add"]) & FORBIDDEN_CAPS

    async def test_no_new_privileges_is_set(self, docker_service, fake_docker):
        # Without it a setuid binary inside the image can regain exactly the
        # capabilities cap_drop just removed.
        assert "no-new-privileges:true" in (
            await _created(docker_service, fake_docker)
        )["security_opt"]

    async def test_ports_are_published_on_loopback_only(
        self, docker_service, fake_docker
    ):
        call = await _created(docker_service, fake_docker)
        assert call["ports"] == {
            "9119/tcp": ("127.0.0.1", 19000),
            "8642/tcp": ("127.0.0.1", 19500),
        }

    async def test_the_bind_host_comes_from_settings(
        self, settings_factory, fake_docker
    ):
        settings = settings_factory(client_bind_host="0.0.0.0")
        service = DockerService(settings)
        service._client = fake_docker
        bindings = service.port_bindings(19000, 19500)
        assert all(host == "0.0.0.0" for host, _ in bindings.values())

    async def test_the_s6_entrypoint_is_never_overridden(
        self, docker_service, fake_docker
    ):
        # The image's ENTRYPOINT is s6-overlay's /init, which must stay PID 1:
        # it runs the UID remap, volume chown, config seeding and supervision
        # tree before any service starts. Overriding either skips all of that.
        call = await _created(docker_service, fake_docker)
        assert "entrypoint" not in call
        assert "command" not in call
        assert call["detach"] is True
        assert call["hostname"] == CONTAINER

    async def test_the_restart_policy_survives_a_host_reboot(
        self, docker_service, fake_docker
    ):
        call = await _created(docker_service, fake_docker)
        assert call["restart_policy"] == {"Name": "unless-stopped"}

    async def test_bind_mounts_keep_the_shared_library_read_only(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        container = fake_docker.containers_by_name[CONTAINER]
        binds = container.host_config["Binds"]
        assert any(bind.endswith(":/opt/data:rw") for bind in binds)
        # A tenant that can write the agency library can rewrite every other
        # tenant's skills on the next sync.
        assert any(bind.endswith(":ro") for bind in binds)


async def _created(service: DockerService, fake: FakeDockerClient) -> dict:
    await create_container(service)
    return fake.created_for(CONTAINER)


# ======================================================================
# 2. images and networks
# ======================================================================
class TestImagePolicy:
    async def test_never_does_not_contact_the_registry(
        self, docker_service, fake_docker
    ):
        # The agent image is multi-gigabyte; an accidental pull inside a
        # request makes onboarding look hung for several minutes.
        await create_container(docker_service)
        assert fake_docker.images.pulled == []

    async def test_missing_pulls_only_when_absent(
        self, settings_factory, fake_docker
    ):
        settings = settings_factory(client_image_pull_policy="missing")
        service = DockerService(settings)
        service._client = fake_docker

        await create_container(service)
        assert fake_docker.images.pulled == ["hermes/test-agent:latest"]

        fake_docker.images.pulled.clear()
        await create_container(service, name="hermes-client-globex")
        assert fake_docker.images.pulled == []

    async def test_always_pulls_every_time(self, settings_factory, fake_docker):
        settings = settings_factory(client_image_pull_policy="always")
        service = DockerService(settings)
        service._client = fake_docker
        await create_container(service)
        await create_container(service, name="hermes-client-globex")
        assert len(fake_docker.images.pulled) == 2

    async def test_an_unpullable_image_explains_the_policy(
        self, settings_factory, fake_docker
    ):
        settings = settings_factory(client_image_pull_policy="missing")
        fake_docker.images.pull_error = ImageNotFound("manifest unknown")
        service = DockerService(settings)
        service._client = fake_docker
        with pytest.raises(OrchestratorError, match="pull policy=missing"):
            await create_container(service)

    async def test_ensure_image_reports_presence_without_pulling(
        self, docker_service, fake_docker
    ):
        assert await docker_service.ensure_image("absent:latest") is False
        fake_docker.images.present.add("present:latest")
        assert await docker_service.ensure_image("present:latest") is True
        assert fake_docker.images.pulled == []


class TestNetworks:
    async def test_the_client_network_is_created_when_missing(
        self, docker_service, fake_docker
    ):
        await docker_service.ensure_networks()
        assert fake_docker.networks.created == ["hermes-clients"]

    async def test_an_existing_network_is_reused(self, settings, fake_docker):
        existing = FakeDockerClient(networks=["hermes-clients"])
        service = DockerService(settings)
        service._client = existing
        await service.ensure_networks()
        assert existing.networks.created == []

    async def test_nginx_mode_uses_one_network(self, docker_service, fake_docker):
        await create_container(docker_service)
        assert fake_docker.created_for(CONTAINER)["network"] == "hermes-clients"

    async def test_traefik_mode_also_joins_the_edge_network(
        self, settings_factory, fake_docker
    ):
        settings = settings_factory(proxy_mode="traefik")
        service = DockerService(settings)
        service._client = fake_docker
        await create_container(service)
        # Primary network at create time, the edge network connected after.
        assert fake_docker.created_for(CONTAINER)["network"] == "hermes-clients"
        assert fake_docker.networks.get("hermes-edge").connected == [CONTAINER]


# ======================================================================
# 3. daemon failures
# ======================================================================
class TestDaemonFailures:
    @pytest.mark.parametrize(
        "message",
        [
            "Bind for 127.0.0.1:19000 failed: port is already allocated",
            "listen tcp 127.0.0.1:19000: bind: address already in use",
            "bind: an attempt was made to access a socket in a way forbidden",
            # Verbatim from Docker Desktop on Windows, captured by
            # TestLiveDockerEnvelope against a port held by another process.
            "ports are not available: exposing port TCP 127.0.0.1:19000 "
            "-> 127.0.0.1:0: listen tcp4 127.0.0.1:19000: bind: Only one "
            "usage of each socket address (protocol/network address/port) "
            "is normally permitted.",
            # The OS text after "bind:" is localised, so Docker's own prefix
            # has to be enough on a non-English Windows.
            "ports are not available: exposing port TCP 127.0.0.1:19000 "
            "-> 127.0.0.1:0: listen tcp4 127.0.0.1:19000: bind: Normalerweise "
            "darf jede Socketadresse nur jeweils einmal verwendet werden.",
        ],
    )
    async def test_port_conflicts_are_distinguishable_so_a_retry_can_help(
        self, docker_service, fake_docker, message
    ):
        fake_docker.start_error = APIError(message)
        with pytest.raises(PortCollisionError):
            await create_container(docker_service)

    async def test_a_held_host_port_surfaces_at_start_like_the_real_daemon(
        self, docker_service, fake_docker
    ):
        # A real daemon accepts `create` and fails the bind on `start`.
        fake_docker.taken_host_ports = {19000}
        with pytest.raises(PortCollisionError, match="already allocated"):
            await create_container(docker_service)

    async def test_other_api_errors_are_not_mistaken_for_port_conflicts(
        self, docker_service, fake_docker
    ):
        # Retrying on a fresh port pair would never fix this one.
        fake_docker.create_error = APIError("no space left on device")
        with pytest.raises(OrchestratorError) as caught:
            await create_container(docker_service)
        assert not isinstance(caught.value, PortCollisionError)

    async def test_a_stale_container_is_replaced_not_duplicated(
        self, docker_service, fake_docker
    ):
        # Left behind by a crashed run; `create` would otherwise fail on the
        # name conflict and block every retry.
        fake_docker.seed_container(CONTAINER, state="exited")
        await create_container(docker_service)
        assert fake_docker.removed == [CONTAINER]
        assert fake_docker.containers_by_name[CONTAINER].start_count == 1

    def test_an_unreachable_daemon_is_reported_as_an_orchestrator_error(
        self, settings, monkeypatch
    ):
        # A missing socket raises a bare DockerException, not an APIError.
        def refuse():
            raise DockerException("Error while fetching server API version")

        monkeypatch.setattr(docker_module.docker, "from_env", refuse)
        with pytest.raises(OrchestratorError, match="Cannot reach Docker daemon"):
            _ = DockerService(settings).client

    async def test_a_daemon_lost_after_connecting_is_an_orchestrator_error(
        self, docker_service, fake_docker, monkeypatch
    ):
        # The client is cached, so this path never re-enters from_env, and what
        # surfaces here is a requests error rather than a DockerException.
        def refuse(_):
            raise RequestsConnectionError("connection aborted")

        monkeypatch.setattr(fake_docker.networks, "get", refuse)
        with pytest.raises(OrchestratorError, match="connection aborted"):
            await create_container(docker_service)

        monkeypatch.setattr(fake_docker.containers, "get", refuse)
        with pytest.raises(OrchestratorError, match="connection aborted"):
            await docker_service.status(CONTAINER)

    async def test_ping_degrades_instead_of_raising(self, docker_service, fake_docker):
        assert await docker_service.ping() is True
        fake_docker.ping_error = APIError("daemon gone")
        assert await docker_service.ping() is False


# ======================================================================
# 4. container state and introspection
# ======================================================================
class TestContainerState:
    async def test_an_absent_container_is_reported_not_raised(self, docker_service):
        state = await docker_service.status("nope")
        assert state["state"] == "absent"
        assert state["container_id"] is None

    async def test_a_running_container_reports_its_health(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        fake_docker.containers_by_name[CONTAINER].set_state(
            "running", health="healthy", restarts=2
        )
        state = await docker_service.status(CONTAINER)
        assert state["state"] == "running"
        assert state["health"] == "healthy"
        assert state["restart_count"] == 2

    async def test_published_ports_are_read_back_from_the_daemon(
        self, docker_service, fake_docker
    ):
        # The database records what the hub allocated; this is what is really
        # bound. Unioning them is what makes the allocator self-healing.
        await create_container(docker_service)
        await create_container(
            docker_service,
            name="hermes-client-globex",
            ports=docker_service.port_bindings(19001, 19501),
        )
        assert await docker_service.published_ports() == {19000, 19500, 19001, 19501}

    async def test_published_ports_ignores_containers_we_do_not_manage(
        self, docker_service, fake_docker
    ):
        fake_docker.seed_container(
            "someone-elses-postgres",
            state="running",
            host_config={
                "PortBindings": {"5432/tcp": [{"HostIp": "", "HostPort": "5432"}]}
            },
        )
        await create_container(docker_service)
        assert await docker_service.published_ports() == {19000, 19500}

    async def test_published_ports_degrades_to_the_database_view(
        self, docker_service, fake_docker
    ):
        # An unreachable daemon must not block allocation entirely.
        fake_docker.list_error = APIError("daemon gone")
        assert await docker_service.published_ports() == set()

    async def test_running_count_only_counts_hub_managed_containers(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        fake_docker.seed_container("someone-elses-redis", state="running")
        assert await docker_service.running_count() == 1

    async def test_running_count_degrades_to_zero(self, docker_service, fake_docker):
        fake_docker.list_error = APIError("daemon gone")
        assert await docker_service.running_count() == 0

    async def test_logs_are_decoded_and_split(self, docker_service, fake_docker):
        await create_container(docker_service)
        assert await docker_service.logs(CONTAINER) == [
            "[stage2] Setup complete; starting user services"
        ]

    async def test_logs_for_an_absent_container_are_empty(self, docker_service):
        assert await docker_service.logs("nope") == []

    @pytest.mark.parametrize("operation", ["stop", "start", "restart", "remove"])
    async def test_operations_on_an_absent_container_report_false(
        self, docker_service, operation
    ):
        # Teardown has to finish on a partially broken deployment.
        assert await getattr(docker_service, operation)("nope") is False

    async def test_stop_gives_the_supervision_tree_time_to_shut_down(
        self, docker_service, fake_docker
    ):
        await create_container(docker_service)
        await docker_service.stop(CONTAINER, timeout=30)
        assert fake_docker.containers_by_name[CONTAINER].stop_calls == [30]

    async def test_exec_run_against_an_absent_container_raises(self, docker_service):
        with pytest.raises(OrchestratorError, match="not found"):
            await docker_service.exec_run("nope", ["nginx", "-t"])


class TestHealthProbing:
    async def test_a_probe_never_raises(self, docker_service):
        # A health endpoint that errors out is useless precisely when it
        # matters. An unreachable port is a report, not an exception.
        result = await docker_service.probe("http://127.0.0.1:1/health", timeout=0.25)
        assert result["reachable"] is False
        assert result["status"] is None
        assert result["latency_ms"] >= 0
        # NB: `error` is str(exc), and httpx raises ConnectError with an empty
        # message on some platforms (Windows among them), so only its presence
        # is contractual here. See the next test for the message path.
        assert "error" in result

    async def test_a_probe_reports_why_it_failed(self, docker_service, monkeypatch):
        # The detail string lands on the client row, so an operator diagnoses
        # a failed provision without a log dive. It has to say something.
        import httpx

        async def refuse(self, url, **kwargs):
            raise httpx.ConnectError("All connection attempts failed")

        monkeypatch.setattr(httpx.AsyncClient, "get", refuse)
        result = await docker_service.probe("http://tenant:9119/api/health")
        assert result["reachable"] is False
        assert result["error"] == "All connection attempts failed"

    async def test_an_authenticated_dashboard_counts_as_reachable(
        self, docker_service, monkeypatch
    ):
        # The dashboard answers 401 on its health path once the auth gate is
        # engaged. Treating that as "down" would fail every healthy tenant.
        import httpx

        async def unauthorized(self, url, **kwargs):
            return httpx.Response(401, request=httpx.Request("GET", url))

        monkeypatch.setattr(httpx.AsyncClient, "get", unauthorized)
        result = await docker_service.probe("http://tenant:9119/api/health")
        assert result["reachable"] is True
        assert result["status"] == 401

    async def test_a_server_error_does_not_count_as_reachable(
        self, docker_service, monkeypatch
    ):
        import httpx

        async def broken(self, url, **kwargs):
            return httpx.Response(502, request=httpx.Request("GET", url))

        monkeypatch.setattr(httpx.AsyncClient, "get", broken)
        assert (await docker_service.probe("http://tenant:9119/x"))["reachable"] is False

    async def test_probe_urls_follow_the_configured_mode(
        self, settings_factory, fake_docker, client
    ):
        network = DockerService(settings_factory())
        network._client = fake_docker
        dash, api = network.health_urls(client)
        assert dash == "http://hermes-client-acme:9119/api/health"
        assert api == "http://hermes-client-acme:8642/health"

        loopback = DockerService(settings_factory(probe_mode="loopback"))
        loopback._client = fake_docker
        dash, api = loopback.health_urls(client)
        assert dash.startswith("http://host.docker.internal:19000")
        assert api.startswith("http://host.docker.internal:19500")

    async def test_a_crash_looping_container_is_reported_before_the_timeout(
        self, docker_service, fake_docker, client, probe
    ):
        # Waiting the full 180s to learn the container exited at second two
        # wastes the operator's time and holds the request open.
        docker_service.probe = probe
        probe.reachable = False
        await create_container(docker_service)
        fake_docker.containers_by_name[CONTAINER].set_state("exited", restarts=5)

        healthy, detail = await asyncio.wait_for(
            docker_service.wait_until_healthy(client), timeout=5
        )
        assert healthy is False
        assert "exited during startup" in detail
        assert "restart_count=5" in detail

    async def test_both_services_must_answer(
        self, docker_service, fake_docker, client, probe
    ):
        docker_service.probe = probe
        await create_container(docker_service)
        healthy, detail = await docker_service.wait_until_healthy(client)
        assert healthy is True
        assert "dashboard 200" in detail and "api 200" in detail


# ======================================================================
# 5. provisioning: directories, limits, security flags
# ======================================================================
class TestBootstrap:
    async def test_creates_every_directory_a_tenant_depends_on(
        self, provisioner, settings, skills_library
    ):
        await provisioner.bootstrap()
        for directory in (
            settings.data_root,
            settings.tenant_root,
            settings.archive_root,
            settings.skills_publish_dir,
        ):
            assert directory.is_dir(), directory

    async def test_publishes_the_shared_library_where_the_daemon_can_see_it(
        self, provisioner, settings, skills_library
    ):
        # The canonical library is baked into the hub image at a path the
        # daemon cannot resolve, so it cannot be a bind source directly.
        await provisioner.bootstrap()
        published = settings.skills_publish_dir / "lead-qualification" / "SKILL.md"
        assert published.is_file()

    async def test_is_idempotent(self, provisioner, settings, skills_library):
        await provisioner.bootstrap()
        await provisioner.bootstrap()
        assert (settings.skills_publish_dir / "lead-qualification").is_dir()

    async def test_survives_a_missing_shared_library(self, provisioner, settings):
        # A fresh deployment that has not populated shared-skills/ yet must
        # still start; tenants just mount an empty agency library.
        await provisioner.bootstrap()
        assert settings.skills_publish_dir.is_dir()


class TestProvisioningCreatesState:
    async def test_the_data_directory_is_created_and_populated(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert tenant_dir.is_dir()
        assert (tenant_dir / ".env").is_file()
        assert (tenant_dir / "config.yaml").is_file()
        assert (tenant_dir / "skills" / "lead-qualification" / "SKILL.md").is_file()

    async def test_only_plan_entitled_skills_are_synced(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        result = await provisioner.provision_client(session, client, "sk-or-key")
        assert result.synced_skills == ["lead-qualification"]
        assert not (
            settings.tenant_dir_for(client.subdomain) / "skills" / "ecommerce-lookup"
        ).exists()

    async def test_the_resource_envelope_reaches_the_daemon(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        container = fake_docker.containers_by_name[client.container_name]
        assert_hardened(
            container.host_config,
            expected_ports={
                "9119/tcp": client.container_port_dash,
                "8642/tcp": client.container_port_api,
            },
        )

    async def test_the_security_flags_reach_the_daemon(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        call = fake_docker.created_for(client.container_name)
        assert call["cap_drop"] == ["ALL"]
        assert set(call["cap_add"]) == EXPECTED_CAP_ADD
        assert call["security_opt"] == ["no-new-privileges:true"]
        assert call["pids_limit"] == 200

    async def test_bind_sources_are_the_paths_the_daemon_resolves(
        self, provisioner, settings, session, make_db_client, fake_docker, skills_library
    ):
        # The hub creates sibling containers, so a path it can write is not
        # necessarily a path the daemon can see.
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        volumes = fake_docker.created_for(client.container_name)["volumes"]
        tenant_source = str(settings.tenant_source_for(client.subdomain))
        skills_source = str(settings.skills_source())
        assert volumes[tenant_source] == {"bind": "/opt/data", "mode": "rw"}
        assert volumes[skills_source] == {
            "bind": settings.shared_skills_mount,
            "mode": "ro",
        }

    async def test_secrets_reach_the_file_and_not_the_environment(
        self, provisioner, settings, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        result = await provisioner.provision_client(
            session, client, "sk-or-super-secret"
        )
        env_file = (settings.tenant_dir_for(client.subdomain) / ".env").read_text(
            encoding="utf-8"
        )
        assert "sk-or-super-secret" in env_file
        assert result.credentials.api_key in env_file
        assert_no_secrets(
            fake_docker.created_for(client.container_name)["environment"],
            "sk-or-super-secret",
            result.credentials.api_key,
            result.credentials.dashboard_secret,
        )

    async def test_the_plaintext_password_is_never_persisted(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        from src.orchestrator.credentials import verify_dashboard_password

        client = await make_db_client()
        result = await provisioner.provision_client(session, client, "sk-or-key")
        password = result.credentials.dashboard_password

        assert_no_secrets(vars(client), password)
        assert_no_secrets(
            (settings.tenant_dir_for(client.subdomain) / ".env").read_text("utf-8"),
            password,
        )
        # Only the hash is stored, and it must verify the returned password.
        assert verify_dashboard_password(password, client.dashboard_password_hash)

    async def test_the_provider_key_is_recorded_only_as_a_fragment(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-abcdwxyz")
        assert client.openrouter_key_last4 == "wxyz"

    async def test_the_run_is_audited_from_start_to_success(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        statuses = {
            entry.status
            for entry in await list_audit_logs(session, client.id)
            if entry.action == "provision"
        }
        assert statuses == {AuditStatus.STARTED, AuditStatus.SUCCEEDED}

    async def test_an_unhealthy_tenant_is_kept_for_diagnosis(
        self, provisioner, session, make_db_client, fake_docker, probe, skills_library
    ):
        probe.reachable = False
        client = await make_db_client()
        result = await provisioner.provision_client(session, client, "sk-or-key")

        assert result.healthy is False
        assert client.subscription_status is SubscriptionStatus.FAILED
        # Deliberately NOT cleaned up: the operator needs `docker logs`.
        assert fake_docker.removed == []
        # The tenant exists and the credentials are real; withholding them
        # would strand it.
        assert result.credentials.api_key and result.credentials.dashboard_password


# ======================================================================
# 6. port allocation under the real provisioner
# ======================================================================
class TestPortAllocationAcrossTenants:
    async def test_ports_come_from_the_configured_ranges(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        assert 19000 <= client.container_port_dash <= 19499
        assert 19500 <= client.container_port_api <= 19999

    async def test_ten_tenants_collide_zero_times(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        """The increment property, end to end through the database.

        Each run re-reads both the database view and what the daemon reports as
        published, so this would catch an allocator that forgot either.
        """
        assigned: list[tuple[int, int]] = []
        for index in range(10):
            client = await make_db_client(slug=f"tenant-{index}")
            await provisioner.provision_client(session, client, "sk-or-key")
            assigned.append((client.container_port_dash, client.container_port_api))

        flat = [port for pair in assigned for port in pair]
        assert len(set(flat)) == 20, "a port was handed to two tenants"
        assert await used_ports(session) == set(flat)
        # And the daemon agrees with the database.
        assert await provisioner.docker.published_ports() == set(flat)

    async def test_a_collision_retries_onto_a_fresh_pair(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        # Something outside the hub holds the two lowest dashboard ports.
        fake_docker.taken_host_ports = {19000, 19001}
        client = await make_db_client()
        result = await provisioner.provision_client(session, client, "sk-or-key")
        assert result.healthy
        assert client.container_port_dash == 19002

    async def test_retries_are_bounded_and_explain_themselves(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        fake_docker.start_error = APIError("port is already allocated")
        client = await make_db_client()
        with pytest.raises(OrchestratorError, match="free port pair"):
            await provisioner.provision_client(session, client, "sk-or-key")
        assert client.subscription_status is SubscriptionStatus.FAILED

    async def test_ports_held_outside_the_database_are_avoided(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        # Reality drifts from the database after a crashed run.
        fake_docker.seed_container(
            "hermes-client-ghost",
            state="running",
            host_config={
                "PortBindings": {
                    "9119/tcp": [{"HostIp": "127.0.0.1", "HostPort": "19000"}],
                    "8642/tcp": [{"HostIp": "127.0.0.1", "HostPort": "19500"}],
                }
            },
        )
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        assert (client.container_port_dash, client.container_port_api) == (19001, 19501)

    async def test_exhaustion_is_capacity_not_a_crash(
        self, settings_factory, session, make_db_client, probe, skills_library
    ):
        from src.proxy.service import NoPortAvailableError

        settings = settings_factory(dash_port_range=(19000, 19000))
        service = DockerService(settings)
        service._client = FakeDockerClient()
        provisioner = build_provisioner(settings, service, probe_stub=probe)

        first = await make_db_client(slug="first")
        await provisioner.provision_client(session, first, "sk-or-key")
        second = await make_db_client(slug="second")
        with pytest.raises(NoPortAvailableError):
            await provisioner.provision_client(session, second, "sk-or-key")


# ======================================================================
# 7. rollback
# ======================================================================
class TestRollback:
    @pytest.fixture
    def broken(self, fake_docker):
        fake_docker.create_error = APIError("no space left on device")
        return fake_docker

    async def test_the_container_is_removed_and_the_ports_released(
        self, provisioner, session, make_db_client, broken, skills_library
    ):
        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await provisioner.provision_client(session, client, "sk-or-key")
        assert client.container_port_dash is None
        assert client.container_port_api is None
        assert client.container_id is None

    async def test_the_tenant_directory_is_preserved(
        self, provisioner, settings, session, make_db_client, broken, skills_library
    ):
        # A tenant's data is the one thing worth keeping after a failed run.
        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await provisioner.provision_client(session, client, "sk-or-key")
        assert settings.tenant_dir_for(client.subdomain).is_dir()

    async def test_the_failure_is_audited_with_its_type(
        self, provisioner, session, make_db_client, broken, skills_library
    ):
        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await provisioner.provision_client(session, client, "sk-or-key")
        failures = [
            entry
            for entry in await list_audit_logs(session, client.id)
            if entry.action == "provision" and entry.status is AuditStatus.FAILED
        ]
        assert failures
        assert failures[0].payload["error_type"] == "OrchestratorError"

    async def test_released_ports_are_reusable_by_a_retry(
        self, settings, session, make_db_client, probe, skills_library
    ):
        failing = FakeDockerClient()
        failing.create_error = APIError("no space left on device")
        failing_service = DockerService(settings)
        failing_service._client = failing

        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await build_provisioner(
                settings, failing_service, probe_stub=probe
            ).provision_client(session, client, "sk-or-key")

        working_service = DockerService(settings)
        working_service._client = FakeDockerClient()
        await build_provisioner(
            settings, working_service, probe_stub=probe
        ).provision_client(session, client, "sk-or-key")

        assert client.container_port_dash == 19000
        assert client.subscription_status is SubscriptionStatus.ACTIVE

    async def test_the_failure_survives_the_requests_rollback(
        self, provisioner, session, session_factory, make_db_client, broken, skills_library
    ):
        # What get_session() does next: roll back. The record must already be
        # committed, so it has to be visible from an unrelated session.
        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await provisioner.provision_client(session, client, "sk-or-key")
        await session.rollback()

        async with session_factory() as other:
            stored = await other.get(Client, client.id)
            assert stored.subscription_status is SubscriptionStatus.FAILED
            assert "no space left" in stored.status_detail
            statuses = [
                entry.status
                for entry in await list_audit_logs(other, client.id)
                if entry.action == "provision"
            ]
        assert sorted(statuses, key=lambda s: s.value) == [
            AuditStatus.FAILED,
            AuditStatus.STARTED,
        ]

    async def test_a_failed_run_stores_no_credentials(
        self, provisioner, session, session_factory, make_db_client, broken, skills_library
    ):
        # They were never handed to anyone, and no container uses them.
        client = await make_db_client()
        with pytest.raises(OrchestratorError):
            await provisioner.provision_client(session, client, "sk-or-key")

        async with session_factory() as other:
            stored = await other.get(Client, client.id)
            assert stored.api_key == ""
            assert stored.dashboard_password_hash == ""
            assert stored.dashboard_secret == ""

    async def test_a_database_error_mid_run_is_still_unwound_and_recorded(
        self,
        provisioner,
        session,
        session_factory,
        make_db_client,
        fake_docker,
        skills_library,
        monkeypatch,
    ):
        # A failed flush leaves the session unusable and `client` unreadable
        # until it is rolled back. Injected once a container exists, so an
        # unwind that reads `client` too early would leave that container behind
        # and raise something other than the real error.
        from sqlalchemy.exc import IntegrityError

        client = await make_db_client()
        client_id, container_name = client.id, client.container_name

        async def corrupt(target):
            target.slug = None  # NOT NULL
            await session.flush()

        monkeypatch.setattr(provisioner.docker, "wait_until_healthy", corrupt)
        with pytest.raises(IntegrityError):
            await provisioner.provision_client(session, client, "sk-or-key")

        assert fake_docker.removed == [container_name]
        async with session_factory() as other:
            stored = await other.get(Client, client_id)
            assert stored.slug == "acme"
            assert stored.subscription_status is SubscriptionStatus.FAILED
            assert stored.container_port_dash is None

    async def test_a_failure_to_record_does_not_hide_the_real_error(
        self, provisioner, session, make_db_client, broken, skills_library, monkeypatch
    ):
        async def unavailable(*args, **kwargs):
            raise RuntimeError("database went away")

        client = await make_db_client()
        monkeypatch.setattr(session, "refresh", unavailable)
        with pytest.raises(OrchestratorError, match="no space left"):
            await provisioner.provision_client(session, client, "sk-or-key")

    async def test_a_hub_killed_mid_run_leaves_a_lone_started_row(
        self, provisioner, session, session_factory, make_db_client, fake_docker, skills_library
    ):
        # The audit design's reconciliation signal. CancelledError is not an
        # Exception, so no failure handling runs, as in a killed process.
        client = await make_db_client()
        client_id = client.id
        fake_docker.create_error = asyncio.CancelledError()
        with pytest.raises(asyncio.CancelledError):
            await provisioner.provision_client(session, client, "sk-or-key")
        await session.rollback()

        async with session_factory() as other:
            stored = await other.get(Client, client_id)
            assert stored.subscription_status is SubscriptionStatus.PROVISIONING
            entries = [
                entry
                for entry in await list_audit_logs(other, client_id)
                if entry.action == "provision"
            ]
        assert [entry.status for entry in entries] == [AuditStatus.STARTED]


# ======================================================================
# 8. the nginx route
# ======================================================================
class TestProxyRegistration:
    @pytest.fixture
    def nginx_settings(self, settings_factory):
        return settings_factory(nginx_control_mode="docker")

    async def test_the_config_is_validated_and_reloaded_through_the_container(
        self, nginx_settings, session, make_db_client, probe, skills_library
    ):
        fake = FakeDockerClient()
        service = DockerService(nginx_settings)
        service._client = fake
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        # Validated before anything reloaded: a bad render must never be the
        # reason an unrelated tenant goes down.
        commands = [command for _, command in fake.exec_calls]
        assert commands.index(["nginx", "-t"]) < commands.index(
            ["nginx", "-s", "reload"]
        )
        assert all(name == "hermes-nginx" for name, _ in fake.exec_calls)

    async def test_a_site_file_is_left_on_disk_for_nginx_to_serve(
        self, nginx_settings, session, make_db_client, probe, skills_library
    ):
        # The default layout, where sites-available IS sites-enabled. nginx -t
        # and the reload both pass with no file present, so only this assertion
        # can tell a routed tenant from an unrouted one.
        assert nginx_settings.nginx_sites_available == nginx_settings.nginx_sites_enabled
        fake = FakeDockerClient()
        service = DockerService(nginx_settings)
        service._client = fake
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        site = nginx_settings.nginx_sites_enabled / f"{client.subdomain}.conf"
        assert site.is_file(), "the tenant has no nginx route"
        assert f"server_name {client.subdomain};" in site.read_text(encoding="utf-8")

    async def test_re_provisioning_keeps_the_site(
        self, nginx_settings, session, make_db_client, probe, skills_library
    ):
        service = DockerService(nginx_settings)
        service._client = FakeDockerClient()
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        await provisioner.provision_client(session, client, "sk-or-key")
        assert (nginx_settings.nginx_sites_enabled / f"{client.subdomain}.conf").is_file()

    async def test_the_two_directory_layout_links_the_site(
        self, settings_factory, tmp_path, session, make_db_client, probe, skills_library
    ):
        # The Debian layout a host nginx uses. Windows without developer mode
        # falls back to a copy, so assert on what nginx would read.
        settings = settings_factory(
            nginx_control_mode="docker",
            nginx_sites_available=tmp_path / "sites-available",
            nginx_sites_enabled=tmp_path / "sites-enabled",
        )
        service = DockerService(settings)
        service._client = FakeDockerClient()
        provisioner = build_provisioner(settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        name = f"{client.subdomain}.conf"
        assert (settings.nginx_sites_available / name).is_file()
        assert f"server_name {client.subdomain};" in (
            settings.nginx_sites_enabled / name
        ).read_text(encoding="utf-8")

        await provisioner.teardown_client(session, client)
        assert not (settings.nginx_sites_available / name).exists()
        assert not (settings.nginx_sites_enabled / name).exists()

    async def test_teardown_removes_the_site_and_reloads(
        self, nginx_settings, session, make_db_client, probe, skills_library
    ):
        fake = FakeDockerClient()
        service = DockerService(nginx_settings)
        service._client = fake
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        fake.exec_calls.clear()
        await provisioner.teardown_client(session, client)

        assert not (
            nginx_settings.nginx_sites_enabled / f"{client.subdomain}.conf"
        ).exists()
        assert ["nginx", "-s", "reload"] in [command for _, command in fake.exec_calls]

    async def test_the_rendered_site_is_what_nginx_would_need(
        self, nginx_settings, client
    ):
        # The dashboard depends on the websocket upgrade headers.
        from src.orchestrator.templates import TemplateRenderer

        conf = TemplateRenderer(nginx_settings).render_nginx(client)
        assert f"server_name {client.subdomain};" in conf
        assert "location /v1/" in conf
        assert "proxy_set_header Upgrade    $http_upgrade;" in conf
        assert f"server {client.container_name}:9119;" in conf
        assert f"server {client.container_name}:8642;" in conf

    async def test_a_rejected_config_is_rolled_back(
        self, nginx_settings, session, make_db_client, probe, skills_library
    ):
        from src.proxy.service import ProxyError

        fake = FakeDockerClient()
        fake.containers_by_name["hermes-nginx"].exec_result = (
            1,
            b"nginx: [emerg] unknown directive",
        )
        service = DockerService(nginx_settings)
        service._client = fake
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        with pytest.raises(ProxyError):
            await provisioner.provision_client(session, client, "sk-or-key")

        assert not (
            nginx_settings.nginx_sites_available / f"{client.subdomain}.conf"
        ).exists()
        # The container the route pointed at is gone too.
        assert fake.removed == [client.container_name]

    async def test_control_mode_none_writes_nothing(
        self, provisioner, settings, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        assert not (
            settings.nginx_sites_available / f"{client.subdomain}.conf"
        ).exists()
        assert fake_docker.exec_calls == []


# ======================================================================
# 9. teardown and data persistence
# ======================================================================
class TestTeardown:
    async def test_stops_before_unregistering_and_removes_last(
        self, settings_factory, session, make_db_client, probe, skills_library
    ):
        """Ordering is the behaviour, not an implementation detail.

        Removing the route before the container stops would drop in-flight
        requests; removing the container before the route leaves nginx proxying
        to a dead upstream.
        """
        nginx_settings = settings_factory(nginx_control_mode="docker")
        fake = FakeDockerClient()
        service = DockerService(nginx_settings)
        service._client = fake
        provisioner = build_provisioner(nginx_settings, service, probe_stub=probe)

        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        # Spy on the proxy rather than on nginx's exec calls: this asserts the
        # provisioner's own ordering, independent of whether unregister finds a
        # site file to remove.
        unregister = provisioner.proxy.unregister

        async def record(target):
            fake.events.append("proxy:unregister")
            return await unregister(target)

        provisioner.proxy.unregister = record  # type: ignore[method-assign]
        fake.events.clear()
        await provisioner.teardown_client(session, client)

        order = fake.events
        stop = order.index(f"stop:{client.container_name}")
        unregistered = order.index("proxy:unregister")
        removed = order.index(f"remove:{client.container_name}")
        assert stop < unregistered < removed

    async def test_archives_the_data_directory_by_moving_it(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        result = await provisioner.teardown_client(session, client)

        assert result.container_removed and result.archive_path
        assert Path(result.archive_path).is_dir()
        # Moved, not copied: no second authoritative copy of a tenant's secrets.
        assert not settings.tenant_dir_for(client.subdomain).exists()

    async def test_archived_data_still_contains_the_tenants_files(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-super-secret")
        result = await provisioner.teardown_client(session, client)

        archive = Path(result.archive_path)
        assert (archive / ".env").is_file()
        assert (archive / "config.yaml").is_file()
        assert (archive / "skills" / "lead-qualification").is_dir()
        assert "sk-or-super-secret" in (archive / ".env").read_text(encoding="utf-8")

    async def test_conversation_data_survives_the_archive(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        # Everything the agent wrote under /opt/data is the tenant's, not ours.
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        (tenant_dir / "conversations").mkdir()
        (tenant_dir / "conversations" / "thread.json").write_text(
            '{"messages": []}', encoding="utf-8"
        )

        result = await provisioner.teardown_client(session, client)
        assert (
            Path(result.archive_path) / "conversations" / "thread.json"
        ).read_text(encoding="utf-8") == '{"messages": []}'

    async def test_archive_false_deletes_instead(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        result = await provisioner.teardown_client(session, client, archive=False)
        assert result.archive_path is None
        assert not settings.tenant_dir_for(client.subdomain).exists()

    async def test_the_archive_is_named_for_the_tenant_under_the_archive_root(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        first = await provisioner.teardown_client(session, client)
        assert Path(first.archive_path).name.startswith(f"{client.subdomain}-")
        assert Path(first.archive_path).parent == settings.archive_root

    async def test_the_row_is_archived_and_the_ports_released(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        await provisioner.teardown_client(session, client)

        assert client.subscription_status is SubscriptionStatus.ARCHIVED
        assert client.container_id is None
        assert client.container_port_dash is None
        assert await used_ports(session) == set()

    async def test_released_ports_go_back_into_circulation(
        self, provisioner, session, make_db_client, skills_library
    ):
        first = await make_db_client(slug="acme")
        await provisioner.provision_client(session, first, "sk-or-key")
        await provisioner.teardown_client(session, first)

        second = await make_db_client(slug="globex")
        await provisioner.provision_client(session, second, "sk-or-key")
        assert second.container_port_dash == 19000

    async def test_is_idempotent_on_a_never_provisioned_client(
        self, provisioner, session, make_db_client
    ):
        # Teardown must work on a partially broken deployment — that is
        # usually why it is being called.
        client = await make_db_client()
        result = await provisioner.teardown_client(session, client)
        assert client.subscription_status is SubscriptionStatus.ARCHIVED
        assert result.container_removed is False
        assert result.archive_path is None

    async def test_survives_a_container_that_is_already_gone(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        fake_docker.containers_by_name.pop(client.container_name)

        result = await provisioner.teardown_client(session, client)
        assert result.container_removed is False
        assert client.subscription_status is SubscriptionStatus.ARCHIVED

    async def test_is_audited(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        await provisioner.teardown_client(session, client)
        teardowns = [
            entry
            for entry in await list_audit_logs(session, client.id)
            if entry.action == "teardown"
        ]
        assert {entry.status for entry in teardowns} == {
            AuditStatus.STARTED,
            AuditStatus.SUCCEEDED,
        }


class TestDataPersistenceAcrossReprovision:
    async def test_existing_tenant_data_survives_a_re_provision(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        (tenant_dir / "conversations").mkdir()
        (tenant_dir / "conversations" / "thread.json").write_text("{}", "utf-8")

        await provisioner.provision_client(session, client, "sk-or-key")
        assert (tenant_dir / "conversations" / "thread.json").is_file()

    async def test_re_provisioning_rotates_the_credentials_in_place(
        self, provisioner, settings, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        first = await provisioner.provision_client(session, client, "sk-or-key")
        second = await provisioner.provision_client(session, client, "sk-or-key")

        assert first.credentials.api_key != second.credentials.api_key
        env_text = (settings.tenant_dir_for(client.subdomain) / ".env").read_text(
            encoding="utf-8"
        )
        # The file must agree with what the operator was just handed.
        assert second.credentials.api_key in env_text
        assert first.credentials.api_key not in env_text

    async def test_a_re_provision_replaces_the_stale_container(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        await provisioner.provision_client(session, client, "sk-or-key")
        # Exactly one container with that name survives.
        assert (
            len([c for c in fake_docker.containers_by_name if c == client.container_name])
            == 1
        )
        assert fake_docker.removed == [client.container_name]


# ======================================================================
# 10. health reporting
# ======================================================================
class TestHealthCheck:
    async def test_healthy_only_when_running_and_both_services_answer(
        self, provisioner, session, make_db_client, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        report = await provisioner.health_check(client)
        assert report["healthy"] is True
        assert report["container_state"] == "running"
        assert report["dashboard"]["reachable"] and report["api"]["reachable"]

    async def test_a_running_container_with_a_dead_service_is_unhealthy(
        self, provisioner, session, make_db_client, probe, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")
        probe.reachable = False
        report = await provisioner.health_check(client)
        assert report["healthy"] is False
        assert report["container_state"] == "running"

    async def test_an_absent_container_skips_probing(
        self, provisioner, session, make_db_client
    ):
        client = await make_db_client()
        report = await provisioner.health_check(client)
        assert report["container_state"] == "absent"
        assert report["healthy"] is False
        assert report["dashboard"] is None

    async def test_an_unreachable_daemon_reports_unknown_rather_than_raising(
        self, provisioner, session, make_db_client, fake_docker, skills_library
    ):
        client = await make_db_client()
        await provisioner.provision_client(session, client, "sk-or-key")

        async def refuse(name):
            raise OrchestratorError("daemon gone")

        provisioner.docker.status = refuse  # type: ignore[method-assign]
        report = await provisioner.health_check(client)
        assert report["container_state"] == "unknown"
        assert report["healthy"] is False


# ======================================================================
# 11. live Docker (opt-in)
# ======================================================================
@pytest.mark.docker
class TestLiveDockerEnvelope:
    """The same envelope assertions, against a real daemon.

    The mocked tests prove the hub *asks* for the right HostConfig. These prove
    the daemon *applies* it — that the `cap_add` names are accepted and that the
    caps and `no-new-privileges` are what `docker inspect` reports. Enable with
    ``HERMES_TEST_DOCKER=1``; a small image (``$HERMES_TEST_IMAGE``, default
    ``alpine:3.20``) is pulled once if absent.
    """

    @pytest.fixture
    def live_service(self, live_docker_client, settings_factory):
        settings = settings_factory(
            client_image=LIVE_IMAGE,
            client_image_pull_policy="missing",
            client_network="hermes-test-net",
        )
        service = DockerService(settings)
        service._client = live_docker_client
        yield service
        # Tests request this before live_container_name, so the container is
        # already gone by now and the network is free to remove.
        for network in live_docker_client.networks.list(names=[settings.client_network]):
            network.remove()

    @pytest.fixture
    def live_container_name(self, live_docker_client):
        # Inside client_container_prefix, or published_ports() will not see it.
        name = "hermes-client-test-envelope"
        yield name
        try:
            live_docker_client.containers.get(name).remove(force=True)
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass

    async def test_the_daemon_applies_the_full_envelope(
        self, live_service, live_container_name, live_docker_client, tmp_path
    ):
        data_dir = tmp_path / "tenant"
        data_dir.mkdir()

        await live_service.create_and_start(
            name=live_container_name,
            image=LIVE_IMAGE,
            environment={"HERMES_HOME": "/opt/data"},
            labels={"hermes.hub.managed": "true"},
            volumes={str(data_dir): {"bind": "/opt/data", "mode": "rw"}},
            ports=live_service.port_bindings(19998, 19999),
        )

        container = live_docker_client.containers.get(live_container_name)
        container.reload()
        # Exactly the helper the mocked tests use, against docker inspect.
        assert_hardened(
            container.attrs["HostConfig"],
            expected_ports={"9119/tcp": 19998, "8642/tcp": 19999},
        )

    async def test_a_published_port_is_readable_back_from_the_daemon(
        self, live_service, live_container_name, tmp_path
    ):
        data_dir = tmp_path / "tenant"
        data_dir.mkdir()
        await live_service.create_and_start(
            name=live_container_name,
            image=LIVE_IMAGE,
            environment={},
            labels={},
            volumes={str(data_dir): {"bind": "/opt/data", "mode": "rw"}},
            ports=live_service.port_bindings(19998, 19999),
        )
        assert {19998, 19999} <= await live_service.published_ports()

    async def test_a_real_port_conflict_is_classified_as_retryable(
        self, live_service, live_container_name, live_docker_client, tmp_path
    ):
        import socket

        data_dir = tmp_path / "tenant"
        data_dir.mkdir()
        holder = socket.socket()
        holder.bind(("127.0.0.1", 0))
        held_port = holder.getsockname()[1]
        holder.listen(1)
        try:
            with pytest.raises(PortCollisionError):
                await live_service.create_and_start(
                    name=live_container_name,
                    image=LIVE_IMAGE,
                    environment={},
                    labels={},
                    volumes={str(data_dir): {"bind": "/opt/data", "mode": "rw"}},
                    ports=live_service.port_bindings(held_port, 19999),
                )
        finally:
            holder.close()


@pytest.mark.docker
class TestLiveNginxConfig:
    """A real ``nginx -t`` over what the hub renders, mounted as compose does.

    Nothing else parses these files: the fake's ``nginx -t`` always passes.
    """

    NGINX_IMAGE = "nginx:alpine"

    def _test_config(self, docker_client, conf_dir, **kwargs) -> tuple[int, str]:
        """``(exit_code, output)`` of ``nginx -t``, which reports on stderr."""
        container = docker_client.containers.run(
            self.NGINX_IMAGE,
            command=["nginx", "-t"],
            volumes={str(conf_dir): {"bind": "/etc/nginx/conf.d", "mode": "ro"}},
            detach=True,
            **kwargs,
        )
        try:
            exit_code = container.wait()["StatusCode"]
            return exit_code, container.logs().decode("utf-8", errors="replace")
        finally:
            container.remove(force=True)

    @pytest.fixture
    def conf_dir(self, settings_factory, tmp_path, client):
        from src.orchestrator.templates import TemplateRenderer

        renderer = TemplateRenderer(settings_factory())
        directory = tmp_path / "conf.d"
        directory.mkdir()
        (directory / "00-hermes-shared.conf").write_text(
            renderer.render_nginx_shared(), encoding="utf-8"
        )
        (directory / f"{client.subdomain}.conf").write_text(
            renderer.render_nginx(client), encoding="utf-8"
        )
        return directory

    def test_nginx_accepts_the_rendered_configuration(
        self, live_docker_client, conf_dir, client
    ):
        # The upstream name has to resolve for nginx to load the config, as it
        # does on the shared network when the tenant is running.
        exit_code, output = self._test_config(
            live_docker_client,
            conf_dir,
            extra_hosts={client.container_name: "127.0.0.1"},
        )
        assert exit_code == 0, output
        assert "syntax is ok" in output
        assert "test is successful" in output

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "DEFECT: the upstream blocks name the tenant's container, and nginx "
            "resolves those names when it loads its config. One stopped tenant "
            "makes `nginx -t` fail for the whole conf.d: every later onboarding "
            "is rejected and rolled back, and nginx itself cannot restart. Fix "
            "needs a template change, e.g. `resolver 127.0.0.11` with "
            "proxy_pass through a variable so names resolve per request."
        ),
    )
    def test_one_stopped_tenant_does_not_break_the_shared_config(
        self, live_docker_client, conf_dir
    ):
        exit_code, output = self._test_config(live_docker_client, conf_dir)
        assert exit_code == 0, output
