"""End-to-end provisioning against a fake daemon and a real database.

The provisioner is the only module that holds the database, Docker, the
filesystem and nginx at once, so it is the only one that can leave a mess. The
rollback and retry paths below are the ones that are hard to exercise against
a real daemon and expensive to get wrong.

A real SQLAlchemy session (SQLite) is used rather than a mock: the status
transitions and audit rows are part of the behaviour under test.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.clients.models import (
    AuditStatus,
    Client,
    ClientPlan,
    SubscriptionStatus,
)
from src.clients.schemas import ClientCreate
from src.clients.service import create_client, list_audit_logs
from src.config.database import Base
from src.orchestrator.docker_service import OrchestratorError, PortCollisionError
from src.orchestrator.provisioner import Provisioner
from src.orchestrator.templates import TemplateRenderer
from src.proxy.service import ProxyService


# --------------------------------------------------------------- fake docker
class FakeDocker:
    """Records what it was asked to do; fails on demand.

    Mirrors only the surface the provisioner touches. ``fail_starts`` makes the
    first N create calls raise, which is how the port-collision retry and the
    rollback paths are driven.
    """

    def __init__(
        self,
        *,
        fail_starts: int = 0,
        failure: type[Exception] = PortCollisionError,
        healthy: bool = True,
    ) -> None:
        self.fail_starts = fail_starts
        self.failure = failure
        self.healthy = healthy
        self.created: list[dict] = []
        self.removed: list[str] = []
        self.stopped: list[str] = []
        self.start_attempts = 0
        self.existing_ports: set[int] = set()

    async def ensure_networks(self) -> None:
        return None

    async def ensure_image(self, image=None) -> bool:
        return True

    async def published_ports(self) -> set[int]:
        return set(self.existing_ports)

    def port_bindings(self, dash_port: int, api_port: int) -> dict:
        return {
            "9119/tcp": ("127.0.0.1", dash_port),
            "8642/tcp": ("127.0.0.1", api_port),
        }

    async def create_and_start(self, **kwargs) -> str:
        self.start_attempts += 1
        if self.start_attempts <= self.fail_starts:
            raise self.failure(f"synthetic failure {self.start_attempts}")
        self.created.append(kwargs)
        return f"container-{uuid.uuid4().hex[:12]}"

    async def stop(self, name, timeout: int = 30) -> bool:
        self.stopped.append(name)
        return True

    async def remove(self, name, force: bool = True) -> bool:
        self.removed.append(name)
        return True

    async def wait_until_healthy(self, client) -> tuple[bool, str]:
        return (True, "ok") if self.healthy else (False, "probe timed out")

    async def status(self, name) -> dict:
        return {
            "container_id": "abc123",
            "state": "running" if self.created else "absent",
            "health": None,
            "started_at": "2026-11-02T00:00:00Z",
            "restart_count": 0,
        }

    def health_urls(self, client) -> tuple[str, str]:
        return ("http://dash/api/health", "http://api/health")

    async def probe(self, url, timeout: float = 5.0) -> dict:
        return {
            "url": url,
            "reachable": self.healthy,
            "status": 200 if self.healthy else None,
            "latency_ms": 1.0,
            "error": None if self.healthy else "refused",
        }


# ------------------------------------------------------------------ fixtures
@pytest_asyncio.fixture
async def session(tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'hub.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture
def skills_library(settings):
    """A minimal shared skill library on disk."""
    for name in ("lead-qualification", "ecommerce-lookup"):
        directory = settings.shared_skills_dir / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
    return settings.shared_skills_dir


@pytest.fixture
def docker():
    return FakeDocker()


def build_provisioner(settings, docker) -> Provisioner:
    renderer = TemplateRenderer(settings)
    proxy = ProxyService(settings, docker, renderer)
    return Provisioner(settings, docker, proxy, renderer)


async def make_client(session, settings, slug="acme") -> Client:
    return await create_client(
        session,
        settings,
        ClientCreate(
            company_name="Acme Widgets",
            # Not a .test TLD: email-validator rejects reserved names.
            contact_email="ops@acme.example.com",
            plan=ClientPlan.STARTER,
            slug=slug,
        ),
    )


# ------------------------------------------------------------- happy path
class TestProvisionSuccess:
    async def test_client_ends_active(self, session, settings, docker, skills_library):
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-tenant-key"
        )
        assert result.healthy
        assert client.subscription_status is SubscriptionStatus.ACTIVE
        assert client.container_id

    async def test_ports_allocated_from_the_configured_ranges(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert 19000 <= client.container_port_dash <= 19499
        assert 19500 <= client.container_port_api <= 19999

    async def test_security_envelope_reaches_docker(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        call = docker.created[0]
        # Loopback-only publishing: a 0.0.0.0 binding here would expose every
        # tenant dashboard on the public interface.
        for host, _ in call["ports"].values():
            assert host == "127.0.0.1"
        assert call["cpus"] == 1.0
        assert call["memory"] == "2g"
        # The image's s6 init must stay PID 1.
        assert "entrypoint" not in call

    async def test_volumes_use_daemon_visible_paths(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        volumes = docker.created[0]["volumes"]
        tenant_src = str(settings.tenant_source_for(client.subdomain))
        skills_src = str(settings.skills_source())
        assert volumes[tenant_src]["bind"] == "/opt/data"
        assert volumes[tenant_src]["mode"] == "rw"
        # The shared agency library must never be writable by a tenant.
        assert volumes[skills_src]["bind"] == settings.shared_skills_mount
        assert volumes[skills_src]["mode"] == "ro"

    async def test_secrets_stay_out_of_the_container_environment(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-super-secret"
        )
        env_blob = repr(docker.created[0]["environment"])
        assert "sk-or-super-secret" not in env_blob
        assert result.credentials.api_key not in env_blob
        assert result.credentials.dashboard_secret not in env_blob

    async def test_tenant_files_written_with_the_key(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-super-secret"
        )
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert "sk-or-super-secret" in (tenant_dir / ".env").read_text()
        assert (tenant_dir / "config.yaml").is_file()

    async def test_plaintext_password_is_never_persisted(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        password = result.credentials.dashboard_password
        assert password not in repr(vars(client))
        assert password not in (
            settings.tenant_dir_for(client.subdomain) / ".env"
        ).read_text()
        # Only the hash is stored, and it must verify the returned password.
        from src.orchestrator.credentials import verify_dashboard_password

        assert verify_dashboard_password(password, client.dashboard_password_hash)

    async def test_only_plan_entitled_skills_are_synced(
        self, session, settings, docker, skills_library
    ):
        # The starter plan lists lead-qualification only.
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert result.synced_skills == ["lead-qualification"]

    async def test_openrouter_key_recorded_only_as_a_fragment(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-abcdwxyz"
        )
        assert client.openrouter_key_last4 == "wxyz"

    async def test_audit_trail_records_start_and_success(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        entries = await list_audit_logs(session, client.id)
        provision = [e for e in entries if e.action == "provision"]
        assert {e.status for e in provision} == {
            AuditStatus.STARTED,
            AuditStatus.SUCCEEDED,
        }


# ------------------------------------------------------- unhealthy tenant
class TestUnhealthyTenant:
    async def test_marked_failed_but_left_running_for_diagnosis(
        self, session, settings, skills_library
    ):
        docker = FakeDocker(healthy=False)
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert not result.healthy
        assert client.subscription_status is SubscriptionStatus.FAILED
        assert "probe timed out" in client.status_detail
        # Deliberately NOT cleaned up: the operator needs `docker logs`.
        assert docker.removed == []

    async def test_credentials_are_still_returned(
        self, session, settings, skills_library
    ):
        # Withholding them would strand a tenant that exists.
        docker = FakeDocker(healthy=False)
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert result.credentials.api_key
        assert result.credentials.dashboard_password


# --------------------------------------------------------- port collisions
class TestPortRetry:
    async def test_retries_onto_a_fresh_pair(self, session, settings, skills_library):
        docker = FakeDocker(fail_starts=2)
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert result.healthy
        assert docker.start_attempts == 3
        # Each retry must move on, not re-pick the pair that just lost.
        assert client.container_port_dash == 19002

    async def test_gives_up_with_a_clear_error(self, session, settings, skills_library):
        docker = FakeDocker(fail_starts=99)
        client = await make_client(session, settings)
        with pytest.raises(OrchestratorError, match="free port pair"):
            await build_provisioner(settings, docker).provision_client(
                session, client, "sk-or-key"
            )
        assert client.subscription_status is SubscriptionStatus.FAILED

    async def test_avoids_ports_docker_already_published(
        self, session, settings, skills_library
    ):
        # Reality can drift from the database after a crashed run; the
        # allocator unions both views.
        docker = FakeDocker()
        docker.existing_ports = {19000, 19001, 19500}
        client = await make_client(session, settings)
        await build_provisioner(settings, docker).provision_client(
            session, client, "sk-or-key"
        )
        assert client.container_port_dash == 19002
        assert client.container_port_api == 19501

    async def test_second_tenant_gets_different_ports(
        self, session, settings, skills_library
    ):
        docker = FakeDocker()
        provisioner = build_provisioner(settings, docker)
        first = await make_client(session, settings, slug="acme")
        await provisioner.provision_client(session, first, "sk-or-key")
        second = await make_client(session, settings, slug="globex")
        await provisioner.provision_client(session, second, "sk-or-key")
        assert first.container_port_dash != second.container_port_dash
        assert first.container_port_api != second.container_port_api


# ----------------------------------------------------------------- rollback
class TestRollback:
    async def test_container_removed_and_ports_released(
        self, session, settings, skills_library
    ):
        docker = FakeDocker(fail_starts=99, failure=OrchestratorError)
        client = await make_client(session, settings)
        with pytest.raises(OrchestratorError):
            await build_provisioner(settings, docker).provision_client(
                session, client, "sk-or-key"
            )
        assert client.container_port_dash is None
        assert client.container_port_api is None
        assert client.container_id is None

    async def test_failure_is_audited(self, session, settings, skills_library):
        docker = FakeDocker(fail_starts=99, failure=OrchestratorError)
        client = await make_client(session, settings)
        with pytest.raises(OrchestratorError):
            await build_provisioner(settings, docker).provision_client(
                session, client, "sk-or-key"
            )
        entries = await list_audit_logs(session, client.id)
        assert any(
            e.action == "provision" and e.status is AuditStatus.FAILED
            for e in entries
        )

    async def test_tenant_directory_is_preserved(
        self, session, settings, skills_library
    ):
        # A tenant's data is the one thing worth keeping after a failed run.
        docker = FakeDocker(fail_starts=99, failure=OrchestratorError)
        client = await make_client(session, settings)
        with pytest.raises(OrchestratorError):
            await build_provisioner(settings, docker).provision_client(
                session, client, "sk-or-key"
            )
        assert settings.tenant_dir_for(client.subdomain).is_dir()

    async def test_released_ports_are_reusable(
        self, session, settings, skills_library
    ):
        failing = FakeDocker(fail_starts=99, failure=OrchestratorError)
        client = await make_client(session, settings)
        with pytest.raises(OrchestratorError):
            await build_provisioner(settings, failing).provision_client(
                session, client, "sk-or-key"
            )
        # A retry on a healthy daemon must get the lowest ports back.
        working = FakeDocker()
        await build_provisioner(settings, working).provision_client(
            session, client, "sk-or-key"
        )
        assert client.container_port_dash == 19000
        assert client.subscription_status is SubscriptionStatus.ACTIVE


# ----------------------------------------------------------------- teardown
class TestTeardown:
    async def test_stops_then_removes_and_archives(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, client, "sk-or-key")

        result = await provisioner.teardown_client(session, client)

        assert docker.stopped and docker.removed
        assert result.container_removed
        assert client.subscription_status is SubscriptionStatus.ARCHIVED
        assert result.archive_path and Path(result.archive_path).is_dir()
        # Data moved, not copied: no second authoritative location.
        assert not settings.tenant_dir_for(client.subdomain).exists()

    async def test_archived_data_still_contains_the_env(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, client, "sk-or-key")
        result = await provisioner.teardown_client(session, client)
        assert (Path(result.archive_path) / ".env").is_file()

    async def test_purge_mode_deletes_instead(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, client, "sk-or-key")
        result = await provisioner.teardown_client(session, client, archive=False)
        assert result.archive_path is None
        assert not settings.tenant_dir_for(client.subdomain).exists()

    async def test_ports_are_released_for_reuse(
        self, session, settings, docker, skills_library
    ):
        first = await make_client(session, settings, slug="acme")
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, first, "sk-or-key")
        await provisioner.teardown_client(session, first)

        second = await make_client(session, settings, slug="globex")
        await provisioner.provision_client(session, second, "sk-or-key")
        assert second.container_port_dash == 19000

    async def test_is_idempotent_on_a_never_provisioned_client(
        self, session, settings, docker
    ):
        # Teardown must work on a partially broken deployment — that is
        # usually why it is being called.
        client = await make_client(session, settings)
        result = await build_provisioner(settings, docker).teardown_client(
            session, client
        )
        assert client.subscription_status is SubscriptionStatus.ARCHIVED
        assert result.archive_path is None


# ------------------------------------------------------------------- health
class TestHealthCheck:
    async def test_healthy_when_running_and_both_services_answer(
        self, session, settings, docker, skills_library
    ):
        client = await make_client(session, settings)
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, client, "sk-or-key")
        report = await provisioner.health_check(client)
        assert report["healthy"]
        assert report["container_state"] == "running"
        assert report["dashboard"]["reachable"]
        assert report["api"]["reachable"]

    async def test_unhealthy_when_a_service_is_down(
        self, session, settings, skills_library
    ):
        docker = FakeDocker(healthy=False)
        client = await make_client(session, settings)
        provisioner = build_provisioner(settings, docker)
        await provisioner.provision_client(session, client, "sk-or-key")
        report = await provisioner.health_check(client)
        assert not report["healthy"]

    async def test_absent_container_skips_probing(self, session, settings, docker):
        client = await make_client(session, settings)
        report = await build_provisioner(settings, docker).health_check(client)
        assert report["container_state"] == "absent"
        assert not report["healthy"]
        # No point probing a container that does not exist.
        assert report["dashboard"] is None
