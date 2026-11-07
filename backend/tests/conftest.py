"""Shared fixtures, fakes and cleanup hooks for the hub test suite.

Three layers, three costs:

``test_unit.py``
    Pure functions: template rendering, file modes, subdomain normalisation,
    port allocation. No database, no Docker, no network. Everything that
    touches disk is confined to ``tmp_path``.

``test_orchestrator.py``
    The container lifecycle. The **Docker SDK** is replaced by
    :class:`FakeDockerClient`, which records exactly what the daemon would have
    been asked to do *and* synthesises the ``HostConfig`` the daemon would have
    produced from it. :func:`assert_hardened` then runs against that synthetic
    HostConfig — and against a real ``docker inspect`` payload in the opt-in
    live tests, so the same contract is checked both ways.

``test_e2e_api.py``
    The real FastAPI app, the real provisioner, the real renderer and a real
    database, driven over HTTP with ``TestClient``. Only two things are faked:
    the Docker SDK and the single outbound health probe.

Nothing here reaches the network, a Docker daemon or the real ``/srv`` tree
unless a test is explicitly opted in:

* ``HERMES_TEST_DOCKER=1`` enables the ``docker`` marked tests, which create
  and inspect a real (tiny) container.
* ``HERMES_TEST_POSTGRES=1`` swaps SQLite for a throwaway Postgres started with
  Testcontainers, so the schema is exercised on the engine production uses.
* ``HERMES_TEST_AGENT=1`` enables ``test_real_agent.py``, which onboards a tenant
  on the real agent image through the running stack.
"""

from __future__ import annotations

import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator

import pytest
import pytest_asyncio

# Make `src` importable the same way the application does.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from docker.errors import APIError, ImageNotFound, NotFound  # noqa: E402
from docker.utils import parse_bytes  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool  # noqa: E402

# Registered on Base.metadata here because db_engine creates the schema before
# any test has had a reason to import them.
from src.auth import models as _auth_models  # noqa: E402,F401
from src.clients.models import Client, ClientPlan, SubscriptionStatus  # noqa: E402
from src.clients.schemas import ClientCreate  # noqa: E402
from src.clients.service import create_client  # noqa: E402
from src.config.database import Base  # noqa: E402
from src.config.settings import Settings  # noqa: E402
from src.ops import models as _ops_models  # noqa: E402,F401
from src.orchestrator.credentials import generate_tenant_credentials  # noqa: E402
from src.orchestrator.docker_service import DockerService  # noqa: E402
from src.orchestrator.provisioner import Provisioner  # noqa: E402
from src.orchestrator.templates import TemplateRenderer  # noqa: E402
from src.proxy.service import ProxyService  # noqa: E402

# ---------------------------------------------------------------- opt-ins
LIVE_DOCKER = os.environ.get("HERMES_TEST_DOCKER") == "1"
LIVE_POSTGRES = os.environ.get("HERMES_TEST_POSTGRES") == "1"
#: Stand-in for the real multi-gigabyte agent image in the live tests. We are
#: verifying the *envelope* the hub asks for, which is image-independent.
LIVE_IMAGE = os.environ.get("HERMES_TEST_IMAGE", "alpine:3.20")
POSTGRES_IMAGE = os.environ.get("HERMES_TEST_POSTGRES_IMAGE", "postgres:16-alpine")

ADMIN_KEY = "test-admin-key"
AUTH = {"X-API-Key": ADMIN_KEY}

#: Exactly what the agent image's s6-overlay init needs, per Settings docs.
EXPECTED_CAP_ADD = {"CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"}
#: A sample of what `cap_drop: ALL` is there to remove. If any of these ever
#: show up in cap_add, a tenant can escape its envelope.
FORBIDDEN_CAPS = {
    "NET_RAW",
    "NET_ADMIN",
    "SYS_ADMIN",
    "SYS_PTRACE",
    "SYS_MODULE",
    "SYS_BOOT",
    "MKNOD",
}


# ======================================================================
# settings
# ======================================================================
def make_settings(root: Path, **overrides: Any) -> Settings:
    """Settings pinned to ``root``, with every asserted value made explicit.

    Two deliberate choices:

    ``_env_file=None``
        A developer's ``.env`` at the repo root must not be able to change what
        the suite asserts. Explicit init arguments also outrank real process
        environment variables in pydantic-settings, so a shell with
        ``CLIENT_MEMORY`` exported cannot skew a resource-limit test either.

    Pinning the envelope
        ``client_cpus`` and friends are passed rather than inherited so the
        tests state the contract they check instead of restating whatever the
        defaults happen to be.
    """
    values: dict[str, Any] = {
        "_env_file": None,
        "environment": "local",
        "admin_api_key": ADMIN_KEY,
        "hub_public_url": "http://localhost:8080",
        "base_domain": "localhost",
        # filesystem
        "data_root": root / "hermes-multi",
        "shared_skills_dir": root / "shared-skills",
        "templates_dir": BACKEND_ROOT / "templates",
        # proxy inert by default; individual tests opt into "docker" mode
        "proxy_mode": "nginx",
        "nginx_control_mode": "none",
        "nginx_upstream_mode": "network",
        # containers
        # Pinned so an exported DOCKER_HOST (Testcontainers' environment, or a
        # developer's shell) cannot route a from_env test to a real daemon.
        "docker_host": None,
        "client_image": "hermes/test-agent:latest",
        # never: no test may trigger a multi-gigabyte pull by accident
        "client_image_pull_policy": "never",
        "client_container_prefix": "hermes-client",
        "client_network": "hermes-clients",
        "client_restart_policy": "unless-stopped",
        "client_bind_host": "127.0.0.1",
        "dash_internal_port": 9119,
        "api_internal_port": 8642,
        "dash_port_range": (19000, 19499),
        "api_port_range": (19500, 19999),
        # the hard envelope under test
        "client_cpus": 1.0,
        "client_memory": "2g",
        "client_pids_limit": 200,
        "client_cap_drop": ["ALL"],
        "client_cap_add": sorted(EXPECTED_CAP_ADD),
        "client_security_opt": ["no-new-privileges:true"],
        "client_uid": 10000,
        "client_gid": 10000,
        # health: short, because the fake probe answers instantly and a real
        # failure must not sit in a 180s retry loop during a test run
        "client_health_timeout_seconds": 5,
        "probe_mode": "network",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings pointed entirely at a temp directory.

    ``nginx_control_mode="none"`` keeps the proxy layer inert; every path hangs
    off ``data_root`` so nothing touches the real /srv tree.
    """
    return make_settings(tmp_path)


@pytest.fixture
def settings_factory(tmp_path: Path) -> Callable[..., Settings]:
    """For tests that need a *variant* of the standard settings."""

    def _factory(**overrides: Any) -> Settings:
        return make_settings(tmp_path, **overrides)

    return _factory


@pytest.fixture(autouse=True)
def _reset_module_singletons() -> Iterator[None]:
    """Drop every cached singleton and dependency override between tests.

    ``get_settings``, ``get_renderer``, ``get_docker_service`` and
    ``get_proxy_service`` are ``lru_cache``d and ``get_provisioner`` keeps a
    module global. One test that touches any of them would otherwise hand its
    configuration to the next, which shows up as an order-dependent failure
    long after the cause.
    """
    yield

    from src.config.settings import get_settings
    from src.orchestrator import provisioner as provisioner_module
    from src.orchestrator.docker_service import get_docker_service
    from src.orchestrator.templates import get_renderer
    from src.proxy.service import get_proxy_service

    for cached in (get_settings, get_renderer, get_docker_service, get_proxy_service):
        cached.cache_clear()
    provisioner_module._provisioner = None

    if "src.main" in sys.modules:
        sys.modules["src.main"].app.dependency_overrides.clear()


# ======================================================================
# a stand-in for the ORM model
# ======================================================================
class FakeClient:
    """A stand-in for the ORM model.

    The renderer only reads attributes, so a plain object avoids dragging a
    database into tests about string output.
    """

    def __init__(self, **overrides: object) -> None:
        self.id = uuid.uuid4()
        self.company_name = "Acme Widgets"
        self.slug = "acme"
        self.subdomain = "acme.localhost"
        self.contact_email = "ops@acme.test"
        self.plan = ClientPlan.STARTER
        self.subscription_status = SubscriptionStatus.PROVISIONING
        self.image = "nousresearch/hermes-agent:latest"
        self.container_id = None
        self.container_name = "hermes-client-acme"
        self.container_port_dash = 19000
        self.container_port_api = 19500
        self.cpu_limit = 1.0
        self.memory_limit = "2g"
        self.database_name = None
        self.internal_token = "internal-token"
        self.api_key = "sk-acme.localhost-stored"
        self.dashboard_password_hash = "scrypt$16384$8$1$c3RvcmVk$c3RvcmVk"
        self.dashboard_username = "admin"
        self.dashboard_secret = "stored-secret"
        self.openrouter_key_last4 = None
        self.config = {}
        self.channels = {}
        self.synced_skills = []
        for key, value in overrides.items():
            setattr(self, key, value)


@pytest.fixture
def client() -> FakeClient:
    return FakeClient()


@pytest.fixture
def renderer(settings: Settings) -> TemplateRenderer:
    return TemplateRenderer(settings)


@pytest.fixture
def credentials():
    return generate_tenant_credentials("acme.localhost")


@pytest.fixture
def skills_library(settings: Settings) -> Path:
    """A minimal shared skill library on disk.

    Two skills, only one of which the starter plan is entitled to, so the
    filtering is observable.
    """
    for name in ("lead-qualification", "ecommerce-lookup"):
        directory = settings.shared_skills_dir / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")
    return settings.shared_skills_dir


# ======================================================================
# the Docker SDK fake
# ======================================================================
def _host_config_from(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Synthesise the ``HostConfig`` the daemon would build from these kwargs.

    This is the part that makes the fake worth having. Asserting on the kwargs
    alone proves we *passed* ``mem_limit="2g"``; asserting on a HostConfig
    proves that lands as 2 GiB, in the same shape ``docker inspect`` returns —
    which is why :func:`assert_hardened` can run unchanged against a real
    daemon in the live tests.
    """
    bindings: dict[str, list[dict[str, str]]] = {}
    for container_port, target in (kwargs.get("ports") or {}).items():
        if isinstance(target, (tuple, list)):
            host_ip, host_port = target
        else:
            host_ip, host_port = "0.0.0.0", target
        bindings[container_port] = [
            {"HostIp": host_ip, "HostPort": str(host_port)}
        ]

    binds = [
        f"{source}:{spec['bind']}:{spec.get('mode', 'rw')}"
        for source, spec in (kwargs.get("volumes") or {}).items()
    ]

    memory = kwargs.get("mem_limit")
    return {
        "Memory": parse_bytes(memory) if isinstance(memory, str) else (memory or 0),
        "NanoCpus": kwargs.get("nano_cpus", 0),
        "PidsLimit": kwargs.get("pids_limit"),
        "CapDrop": list(kwargs.get("cap_drop") or []),
        "CapAdd": list(kwargs.get("cap_add") or []),
        "SecurityOpt": list(kwargs.get("security_opt") or []),
        "RestartPolicy": {
            "Name": (kwargs.get("restart_policy") or {}).get("Name", ""),
            "MaximumRetryCount": 0,
        },
        "PortBindings": bindings,
        "Binds": binds,
        "NetworkMode": kwargs.get("network") or "default",
        "Privileged": False,
        "ReadonlyRootfs": False,
    }


class FakeContainer:
    """Mirrors the slice of ``docker.models.containers.Container`` we use."""

    def __init__(
        self,
        owner: "FakeDockerClient",
        *,
        name: str,
        image: str = "",
        labels: dict[str, str] | None = None,
        host_config: dict[str, Any] | None = None,
        state: str = "created",
        log_lines: tuple[str, ...] = (),
        exec_result: tuple[int, bytes] = (0, b"ok"),
    ) -> None:
        self._owner = owner
        self.id = uuid.uuid4().hex * 2  # 64 hex chars, like a real container id
        self.name = name
        self.image = image
        self.labels = labels or {}
        self.log_lines = log_lines
        self.exec_result = exec_result
        self.start_count = 0
        self.stop_calls: list[int] = []
        self.restart_calls: list[int] = []
        self.removed = False
        self.attrs: dict[str, Any] = {
            "Name": f"/{name}",
            "State": {
                "Status": state,
                "Health": None,
                "StartedAt": "2026-11-02T00:00:00.000000000Z",
            },
            "RestartCount": 0,
            "HostConfig": host_config or {},
            "Config": {"Image": image, "Labels": self.labels},
        }

    # -- introspection ------------------------------------------------
    @property
    def short_id(self) -> str:
        return self.id[:12]

    @property
    def status(self) -> str:
        return self.attrs["State"]["Status"]

    @property
    def host_config(self) -> dict[str, Any]:
        return self.attrs["HostConfig"]

    def set_state(self, status: str, *, health: str | None = None, restarts: int = 0):
        self.attrs["State"]["Status"] = status
        self.attrs["State"]["Health"] = {"Status": health} if health else None
        self.attrs["RestartCount"] = restarts
        return self

    # -- operations ---------------------------------------------------
    def start(self) -> None:
        self._owner.events.append(f"start:{self.name}")
        error = self._owner.start_error_for(self)
        if error is not None:
            raise error
        self.start_count += 1
        self.attrs["State"]["Status"] = "running"

    def stop(self, timeout: int = 10) -> None:
        self._owner.events.append(f"stop:{self.name}")
        self.stop_calls.append(timeout)
        self.attrs["State"]["Status"] = "exited"

    def restart(self, timeout: int = 10) -> None:
        self._owner.events.append(f"restart:{self.name}")
        self.restart_calls.append(timeout)
        self.attrs["State"]["Status"] = "running"

    def remove(self, force: bool = False) -> None:
        self._owner.events.append(f"remove:{self.name}")
        self.removed = True
        self._owner.removed.append(self.name)
        self._owner.containers_by_name.pop(self.name, None)

    def logs(self, tail: int = 200, timestamps: bool = False) -> bytes:
        return "\n".join(self.log_lines[-tail:]).encode("utf-8")

    def exec_run(self, command: Any) -> tuple[int, bytes]:
        self._owner.events.append(f"exec:{self.name}")
        self._owner.exec_calls.append((self.name, command))
        return self.exec_result


class FakeImageCollection:
    def __init__(self, present: Iterator[str] = ()) -> None:
        self.present = set(present)
        self.pulled: list[str] = []
        self.get_calls: list[str] = []
        #: When set, ``pull`` raises instead of succeeding.
        self.pull_error: Exception | None = None

    def get(self, name: str) -> Any:
        self.get_calls.append(name)
        if name not in self.present:
            raise ImageNotFound(f"no such image: {name}")
        return SimpleNamespace(id=f"sha256:{uuid.uuid4().hex}", tags=[name])

    def pull(self, name: str, **_: Any) -> Any:
        self.pulled.append(name)
        if self.pull_error is not None:
            raise self.pull_error
        self.present.add(name)
        return SimpleNamespace(id=f"sha256:{uuid.uuid4().hex}", tags=[name])


class FakeNetwork:
    def __init__(self, name: str) -> None:
        self.name = name
        self.connected: list[str] = []

    def connect(self, container: Any) -> None:
        self.connected.append(getattr(container, "name", str(container)))


class FakeNetworkCollection:
    def __init__(self, existing: Iterator[str] = ()) -> None:
        self.networks = {name: FakeNetwork(name) for name in existing}
        self.created: list[str] = []

    def get(self, name: str) -> FakeNetwork:
        if name not in self.networks:
            raise NotFound(f"network {name} not found")
        return self.networks[name]

    def create(self, name: str, driver: str = "bridge", **_: Any) -> FakeNetwork:
        self.created.append(name)
        network = FakeNetwork(name)
        self.networks[name] = network
        return network


class FakeContainerCollection:
    def __init__(self, owner: "FakeDockerClient") -> None:
        self._owner = owner

    def get(self, key: str) -> FakeContainer:
        owner = self._owner
        if key in owner.containers_by_name:
            return owner.containers_by_name[key]
        for container in owner.containers_by_name.values():
            if container.id.startswith(key):
                return container
        raise NotFound(f"no such container: {key}")

    def create(self, **kwargs: Any) -> FakeContainer:
        owner = self._owner
        owner.events.append(f"create:{kwargs.get('name')}")
        owner.create_calls.append(kwargs)
        if owner.create_error is not None:
            raise owner.create_error
        container = FakeContainer(
            owner,
            name=kwargs["name"],
            image=kwargs.get("image", ""),
            labels=kwargs.get("labels") or {},
            host_config=_host_config_from(kwargs),
            log_lines=owner.default_log_lines,
        )
        owner.containers_by_name[container.name] = container
        return container

    def list(
        self, all: bool = False, filters: dict[str, Any] | None = None, **_: Any
    ) -> list[FakeContainer]:
        if self._owner.list_error is not None:
            raise self._owner.list_error
        filters = filters or {}
        results = []
        for container in self._owner.containers_by_name.values():
            name_filter = filters.get("name")
            if name_filter and name_filter not in container.name:
                continue
            status_filter = filters.get("status")
            if status_filter and container.status != status_filter:
                continue
            if not all and container.status != "running":
                continue
            results.append(container)
        return results


class FakeDockerClient:
    """A recording stand-in for ``docker.DockerClient``.

    Injected by assigning :attr:`DockerService._client`, which is the seam the
    real client is cached in — so every call goes through the production
    ``DockerService`` code path, including the ``asyncio.to_thread`` hop.

    Failure injection:

    ``create_error``
        Raised from ``containers.create``.
    ``start_error``
        Raised from ``container.start()``. This is where a real daemon reports
        a port conflict, so it is the faithful place to simulate one.
    ``taken_host_ports``
        Host ports an unrelated process already holds. ``start()`` raises the
        daemon's real "port is already allocated" ``APIError`` for these, which
        is what drives the provisioner's retry loop.
    """

    def __init__(
        self,
        *,
        images: Iterator[str] = (),
        networks: Iterator[str] = (),
        nginx_container: str | None = "hermes-nginx",
    ) -> None:
        self.images = FakeImageCollection(images)
        self.networks = FakeNetworkCollection(networks)
        self.containers = FakeContainerCollection(self)
        self.containers_by_name: dict[str, FakeContainer] = {}

        #: Ordered log of every operation, for asserting sequences such as
        #: "stop before unregister before remove" during teardown.
        self.events: list[str] = []
        self.create_calls: list[dict[str, Any]] = []
        self.exec_calls: list[tuple[str, Any]] = []
        self.removed: list[str] = []
        self.ping_calls = 0

        self.create_error: Exception | None = None
        self.start_error: Exception | None = None
        self.list_error: Exception | None = None
        self.ping_error: Exception | None = None
        self.taken_host_ports: set[int] = set()
        self.default_log_lines: tuple[str, ...] = (
            "[stage2] Setup complete; starting user services",
        )

        if nginx_container:
            # A containerized nginx the hub can `docker exec` into. Present by
            # default so nginx_control_mode="docker" works without extra setup.
            self.containers_by_name[nginx_container] = FakeContainer(
                self, name=nginx_container, image="nginx:alpine", state="running"
            )

    # -- failure injection -------------------------------------------
    def start_error_for(self, container: FakeContainer) -> Exception | None:
        if self.start_error is not None:
            return self.start_error
        for entries in (container.host_config.get("PortBindings") or {}).values():
            for entry in entries:
                if int(entry["HostPort"]) in self.taken_host_ports:
                    return APIError(
                        "driver failed programming external connectivity on "
                        f"endpoint {container.name}: Bind for "
                        f"{entry['HostIp']}:{entry['HostPort']} failed: "
                        "port is already allocated"
                    )
        return None

    # -- client surface ----------------------------------------------
    def ping(self) -> bool:
        self.ping_calls += 1
        if self.ping_error is not None:
            raise self.ping_error
        return True

    # -- convenience for tests ---------------------------------------
    def created_for(self, name: str) -> dict[str, Any]:
        """The most recent ``containers.create`` kwargs for ``name``."""
        matches = [call for call in self.create_calls if call.get("name") == name]
        assert matches, f"no container was created named {name!r}"
        return matches[-1]

    def seed_container(self, name: str, **kwargs: Any) -> FakeContainer:
        """Pre-existing container, e.g. a stale one left by a crashed run."""
        container = FakeContainer(self, name=name, **kwargs)
        self.containers_by_name[name] = container
        return container


@pytest.fixture
def fake_docker() -> FakeDockerClient:
    return FakeDockerClient()


@pytest.fixture
def docker_service(settings: Settings, fake_docker: FakeDockerClient) -> DockerService:
    """A real :class:`DockerService` wired to the fake SDK client."""
    service = DockerService(settings)
    service._client = fake_docker  # the seam the real client is cached in
    return service


class ProbeStub:
    """Stands in for the only outbound HTTP call in the provisioning path.

    ``DockerService.probe`` is the single place the hub talks to a tenant over
    the network. Replacing just this keeps the rest of the health logic — the
    container-state check, the concurrent gather, the ``healthy`` rollup — under
    test rather than mocked away.
    """

    def __init__(self, *, reachable: bool = True, status: int = 200) -> None:
        self.reachable = reachable
        self.status = status
        self.calls: list[str] = []

    async def __call__(self, url: str, timeout: float = 5.0) -> dict[str, Any]:
        self.calls.append(url)
        return {
            "url": url,
            "reachable": self.reachable,
            "status": self.status if self.reachable else None,
            "latency_ms": 1.0,
            "error": None if self.reachable else "connection refused",
        }


@pytest.fixture
def probe() -> ProbeStub:
    return ProbeStub()


@pytest.fixture
def provisioner(
    settings: Settings, docker_service: DockerService, probe: ProbeStub
) -> Provisioner:
    """The real provisioner over the fake SDK: only the probe is stubbed."""
    docker_service.probe = probe  # type: ignore[method-assign]
    renderer = TemplateRenderer(settings)
    proxy = ProxyService(settings, docker_service, renderer)
    return Provisioner(settings, docker_service, proxy, renderer)


def build_provisioner(
    settings: Settings, docker: Any, *, probe_stub: ProbeStub | None = None
) -> Provisioner:
    """Compose a provisioner by hand, for tests that need a variant.

    ``docker`` may be a :class:`DockerService` over a fake SDK client or any
    object satisfying the surface the provisioner uses.
    """
    if probe_stub is not None and hasattr(docker, "probe"):
        docker.probe = probe_stub
    renderer = TemplateRenderer(settings)
    proxy = ProxyService(settings, docker, renderer)
    return Provisioner(settings, docker, proxy, renderer)


# ======================================================================
# database
# ======================================================================
@pytest.fixture(scope="session")
def database_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str | None]:
    """Base URL for the test database, or ``None`` for per-test SQLite.

    With ``HERMES_TEST_POSTGRES=1`` a throwaway Postgres is started with
    Testcontainers and shared for the session, so the schema is exercised on
    the engine production actually uses (native UUID columns, real unique
    constraints on the port columns). Without it the suite stays hermetic on
    SQLite and needs no daemon at all.
    """
    if not LIVE_POSTGRES:
        yield None
        return

    try:
        # Newer testcontainers releases moved the module; keep both working.
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        try:
            from testcontainers.postgres import PostgresContainer
        except ImportError:  # pragma: no cover - opt-in path
            pytest.skip(
                "HERMES_TEST_POSTGRES=1 requires "
                "`pip install testcontainers[postgres] asyncpg`"
            )

    with PostgresContainer(POSTGRES_IMAGE, driver="asyncpg") as container:
        yield container.get_connection_url()


def _make_engine(url: str):
    # NullPool because the schema is created on pytest-asyncio's loop while
    # TestClient drives the app on its own: a pooled connection would be
    # reused across event loops, which asyncpg and aiosqlite both reject.
    return create_async_engine(url, poolclass=NullPool)


@pytest_asyncio.fixture
async def db_engine(database_url: str | None, tmp_path: Path):
    """A fresh schema per test, on SQLite or the session's Postgres."""
    url = database_url or f"sqlite+aiosqlite:///{tmp_path / 'hub.db'}"
    engine = _make_engine(url)
    async with engine.begin() as connection:
        if database_url:  # a shared Postgres keeps state between tests
            await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)
    try:
        yield engine
    finally:
        if database_url:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest_asyncio.fixture
async def session_factory(db_engine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(db_engine, expire_on_commit=False, class_=AsyncSession)


@pytest_asyncio.fixture
async def session(session_factory) -> AsyncSession:
    async with session_factory() as open_session:
        yield open_session


@pytest_asyncio.fixture
async def make_db_client(session: AsyncSession, settings: Settings):
    """Factory for persisted clients, so tests do not repeat the payload."""

    async def _make(slug: str = "acme", **overrides: Any) -> Client:
        payload = {
            "company_name": overrides.pop("company_name", "Acme Widgets"),
            # Not a .test TLD: email-validator rejects reserved names.
            "contact_email": overrides.pop("contact_email", "ops@acme.example.com"),
            "plan": overrides.pop("plan", ClientPlan.STARTER),
            "slug": slug,
        }
        payload.update(overrides)
        return await create_client(session, settings, ClientCreate(**payload))

    return _make


# ======================================================================
# the end-to-end harness
# ======================================================================
@dataclass
class Hub:
    """Everything an E2E test needs to drive and then inspect the hub."""

    http: Any  # fastapi.testclient.TestClient
    settings: Settings
    docker: FakeDockerClient
    docker_service: DockerService
    provisioner: Provisioner
    probe: ProbeStub
    onboarded: list[str] = field(default_factory=list)

    # -- helpers --------------------------------------------------
    def onboard(self, **overrides: Any):
        """POST a valid onboarding payload with the admin key."""
        body = {
            "company_name": "Acme Widgets",
            "subdomain": "acme",
            "openrouter_api_key": "sk-or-v1-tenant-secret-key",
            "contact_email": "ops@acme.example.com",
        }
        body.update(overrides)
        response = self.http.post("/api/v1/clients/onboard", json=body, headers=AUTH)
        if response.status_code == 201:
            self.onboarded.append(response.json()["client_id"])
        return response

    def tenant_dir(self, subdomain: str) -> Path:
        return self.settings.tenant_dir_for(subdomain)

    def env_text(self, subdomain: str) -> str:
        return (self.tenant_dir(subdomain) / ".env").read_text(encoding="utf-8")


@pytest_asyncio.fixture
async def hub(tmp_path: Path, session_factory, monkeypatch) -> Hub:
    """The real app with the real provisioner, over a fake daemon.

    Four seams are replaced and nothing else:

    * ``get_session`` -> the test database.
    * ``get_settings`` -> tmp-path settings (also what ``get_principal`` reads).
    * the Docker SDK client -> :class:`FakeDockerClient`.
    * ``DockerService.probe`` -> :class:`ProbeStub`.

    Everything in between is production code: slug derivation, credential
    generation, template rendering to disk, port allocation, the provisioning
    sequence, rollback, status transitions and the audit trail.

    Deliberately not used as a context manager: that would run the real
    lifespan, which tries to reach Docker and prepare ``/srv``.
    """
    from fastapi.testclient import TestClient

    from src.config.database import get_session
    from src.config.settings import get_settings
    from src.main import app
    from src.orchestrator import docker_service as docker_module
    from src.orchestrator.docker_service import get_docker_service
    from src.orchestrator.provisioner import get_provisioner

    test_settings = make_settings(tmp_path)

    # A shared skill library, so onboarding has something real to sync.
    for name in ("lead-qualification", "ecommerce-lookup"):
        skill_dir = test_settings.shared_skills_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(f"# {name}\n", encoding="utf-8")

    fake_client = FakeDockerClient()
    service = DockerService(test_settings)
    service._client = fake_client
    probe_stub = ProbeStub()
    service.probe = probe_stub  # type: ignore[method-assign]

    renderer = TemplateRenderer(test_settings)
    proxy = ProxyService(test_settings, service, renderer)
    real_provisioner = Provisioner(test_settings, service, proxy, renderer)

    async def _session():
        async with session_factory() as open_session:
            try:
                yield open_session
                await open_session.commit()
            except Exception:
                await open_session.rollback()
                raise

    # /healthz resolves the docker service by calling the factory directly
    # rather than through Depends, so it needs patching at the module.
    monkeypatch.setattr(docker_module, "get_docker_service", lambda: service)

    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_settings] = lambda: test_settings
    app.dependency_overrides[get_provisioner] = lambda: real_provisioner
    app.dependency_overrides[get_docker_service] = lambda: service

    http = TestClient(app, raise_server_exceptions=False)
    try:
        yield Hub(
            http=http,
            settings=test_settings,
            docker=fake_client,
            docker_service=service,
            provisioner=real_provisioner,
            probe=probe_stub,
        )
    finally:
        http.close()
        app.dependency_overrides.clear()


# ======================================================================
# shared assertions
# ======================================================================
def assert_hardened(
    host_config: dict[str, Any],
    *,
    cpus: float = 1.0,
    memory: str = "2g",
    pids_limit: int | None = 200,
    bind_host: str | None = "127.0.0.1",
    expected_ports: dict[str, int] | None = None,
) -> None:
    """Assert a container's ``HostConfig`` carries the tenant envelope.

    Runs against both the fake's synthesised HostConfig and a real
    ``docker inspect`` payload, so the mocked and live tests check one contract
    rather than two similar-looking ones.
    """
    # --- resource caps ---------------------------------------------
    assert host_config["NanoCpus"] == int(cpus * 1_000_000_000), (
        "CPU cap missing: an uncapped tenant can starve every other tenant "
        "on the box"
    )
    assert host_config["Memory"] == parse_bytes(memory), "memory cap missing"
    if pids_limit is not None:
        assert host_config["PidsLimit"] == pids_limit, (
            "pids_limit missing: a fork bomb in one tenant takes down the host"
        )

    # --- security envelope ------------------------------------------
    assert [cap.upper() for cap in host_config["CapDrop"]] == ["ALL"], (
        "cap_drop must be ALL; adding back is the only safe direction"
    )
    cap_add = {cap.upper() for cap in host_config["CapAdd"]}
    assert cap_add == EXPECTED_CAP_ADD, (
        f"cap_add drifted from the s6-overlay minimum: {cap_add}"
    )
    assert not cap_add & FORBIDDEN_CAPS, (
        f"dangerous capability granted: {cap_add & FORBIDDEN_CAPS}"
    )
    assert "no-new-privileges:true" in host_config["SecurityOpt"], (
        "no-new-privileges missing: a setuid binary inside the image could "
        "regain the capabilities we just dropped"
    )
    assert host_config.get("Privileged") is False

    # --- publishing -------------------------------------------------
    if bind_host is not None:
        bindings = host_config["PortBindings"]
        assert bindings, "no ports published"
        for entries in bindings.values():
            for entry in entries:
                assert entry["HostIp"] == bind_host, (
                    f"published on {entry['HostIp']} instead of {bind_host}: "
                    "every tenant dashboard would be on the public interface"
                )
    if expected_ports is not None:
        actual = {
            port: int(entries[0]["HostPort"])
            for port, entries in host_config["PortBindings"].items()
        }
        assert actual == expected_ports


def assert_no_secrets(blob: Any, *secrets: str) -> None:
    """Assert none of ``secrets`` appears anywhere in ``blob``."""
    text = blob if isinstance(blob, str) else repr(blob)
    for secret in secrets:
        if secret:
            assert secret not in text, f"secret leaked into {type(blob).__name__}"


# ======================================================================
# live-Docker gating
# ======================================================================
@pytest.fixture(scope="session")
def live_docker_client():
    """A real Docker client, or skip. Opt in with ``HERMES_TEST_DOCKER=1``."""
    if not LIVE_DOCKER:
        pytest.skip("live Docker tests are opt-in: set HERMES_TEST_DOCKER=1")
    import docker as docker_sdk

    try:
        client = docker_sdk.from_env()
        client.ping()
    except Exception as exc:  # noqa: BLE001 - any failure means "no daemon"
        pytest.skip(f"no reachable Docker daemon: {exc}")
    try:
        yield client
    finally:
        client.close()
