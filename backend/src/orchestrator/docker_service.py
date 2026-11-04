"""Docker container lifecycle for client Hermes instances.

The Docker SDK is synchronous, so every call is pushed onto a worker thread.
Nothing here knows about the database — callers own persistence.

The hub normally runs *inside* a container with the Docker socket mounted, so
it creates sibling containers rather than children. Two consequences run
through this module:

* **Bind-mount sources are resolved by the daemon, not by this process.** Paths
  handed to :meth:`create_and_start` must come from
  ``Settings.tenant_source_for``, never from ``tenant_dir_for``.
* **Published ports land on the host's loopback, not ours.** Health probing
  therefore defaults to reaching the container by name over the shared Docker
  network; see :meth:`wait_until_healthy`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterator
from functools import lru_cache
from typing import Any

import docker
import httpx
from docker.errors import APIError, DockerException, ImageNotFound, NotFound
from docker.models.containers import Container
from requests.exceptions import RequestException

from ..config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: Docker reports a port collision as a 500 with this phrase. Matching on it
#: lets the provisioner retry with a different port instead of failing the
#: whole onboarding — see PortCollisionError.
_PORT_COLLISION_MARKERS = (
    "port is already allocated",
    "address already in use",
    # Docker Desktop's prefix for any failed publish. It comes from Docker, so
    # unlike the OS text after it, it is not localised on Windows.
    "ports are not available",
    "only one usage of each socket address",  # Windows: WSAEADDRINUSE
    "bind: an attempt was made to access a socket",  # Windows: WSAEACCES
)

#: How an unreachable daemon surfaces. ``docker.from_env`` raises a bare
#: DockerException on first contact; once the client is cached, a daemon that
#: went away raises a requests error instead, which is not a DockerException.
_DAEMON_ERRORS = (DockerException, RequestException)

#: What /init runs as the container's main program. When that program exits, s6
#: shuts every service down. With no command it is the interactive `hermes` CLI,
#: which exits at once without a terminal, so a tenant needs a program that only
#: waits. The gateway and dashboard run as supervised services alongside it.
TENANT_MAIN_COMMAND = ["sleep", "infinity"]


class OrchestratorError(RuntimeError):
    """Raised when the Docker daemon refuses an operation."""


class PortCollisionError(OrchestratorError):
    """A requested host port was taken between allocation and container start.

    Distinct from the generic error so the provisioner can retry on a fresh
    port pair rather than giving up. This happens in practice whenever the
    database's view of allocated ports drifts from reality — a crashed run, a
    manually started container, or something outside the hub holding the port.
    """


def _is_port_collision(exc: APIError) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _PORT_COLLISION_MARKERS)


class DockerService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: docker.DockerClient | None = None

    # ------------------------------------------------------------- client
    @property
    def client(self) -> docker.DockerClient:
        if self._client is None:
            try:
                if self.settings.docker_host:
                    self._client = docker.DockerClient(
                        base_url=self.settings.docker_host
                    )
                else:
                    self._client = docker.from_env()
            except _DAEMON_ERRORS as exc:
                raise OrchestratorError(f"Cannot reach Docker daemon: {exc}") from exc
        return self._client

    async def ping(self) -> bool:
        try:
            return bool(await asyncio.to_thread(self.client.ping))
        except Exception:  # noqa: BLE001 - health check must never raise
            return False

    # ----------------------------------------------------------- networks
    def _ensure_network_sync(self, name: str) -> None:
        try:
            self.client.networks.get(name)
        except NotFound:
            logger.info("Creating Docker network %s", name)
            self.client.networks.create(name, driver="bridge")

    async def ensure_networks(self) -> None:
        """Create the client network (and the edge network under Traefik)."""
        names = [self.settings.client_network]
        if self.settings.proxy_mode == "traefik":
            names.append(self.settings.traefik_network)
        for name in names:
            await asyncio.to_thread(self._ensure_network_sync, name)

    # -------------------------------------------------------------- images
    async def has_image(self, image: str | None = None) -> bool:
        image = image or self.settings.client_image

        def _check() -> bool:
            try:
                self.client.images.get(image)
                return True
            except (ImageNotFound, APIError):
                return False

        return await asyncio.to_thread(_check)

    async def ensure_image(self, image: str | None = None) -> bool:
        """Report whether the agent image is present locally.

        Called at startup purely to warn: the agent image is multi-gigabyte, so
        pulling it lazily inside the first onboarding request makes that request
        look hung for several minutes. Operators should pre-pull.
        """
        image = image or self.settings.client_image
        if await self.has_image(image):
            return True
        logger.warning(
            "Agent image %s is not present locally. The first onboarding will "
            "block while Docker pulls it (several GB). Pre-pull with: "
            "docker pull %s",
            image,
            image,
        )
        return False

    def _pull_if_needed_sync(self, image: str) -> None:
        """Apply ``client_image_pull_policy`` before creating a container."""
        policy = self.settings.client_image_pull_policy
        if policy == "never":
            return
        if policy == "missing":
            try:
                self.client.images.get(image)
                return
            except ImageNotFound:
                pass
        logger.info("Pulling image %s (policy=%s)", image, policy)
        self.client.images.pull(image)

    # --------------------------------------------------------- containers
    def _get_sync(self, name_or_id: str) -> Container | None:
        try:
            return self.client.containers.get(name_or_id)
        except NotFound:
            return None
        except _DAEMON_ERRORS as exc:
            raise OrchestratorError(
                f"Could not look up container {name_or_id}: {exc}"
            ) from exc

    async def get(self, name_or_id: str) -> Container | None:
        return await asyncio.to_thread(self._get_sync, name_or_id)

    def _create_sync(
        self,
        *,
        name: str,
        image: str,
        environment: dict[str, str],
        labels: dict[str, str],
        volumes: dict[str, dict[str, str]],
        ports: dict[str, Any] | None,
        cpus: float,
        memory: str,
        networks: list[str],
    ) -> Container:
        # Replace any stale container left behind by a failed run.
        existing = self._get_sync(name)
        if existing is not None:
            logger.info("Removing stale container %s", name)
            existing.remove(force=True)

        self._pull_if_needed_sync(image)

        settings = self.settings
        primary, *extra = networks
        container = self.client.containers.create(
            image=image,
            name=name,
            detach=True,
            environment=environment,
            labels=labels,
            volumes=volumes,
            ports=ports or None,
            # --- resource envelope -------------------------------------
            nano_cpus=int(cpus * 1_000_000_000),
            mem_limit=memory,
            pids_limit=settings.client_pids_limit,
            # --- security envelope -------------------------------------
            # Drop everything, then add back exactly what the image's
            # s6-overlay init needs to chown the data volume and drop each
            # supervised service to the unprivileged `hermes` user. See
            # Settings.client_cap_add for the per-capability rationale.
            cap_drop=settings.client_cap_drop,
            cap_add=settings.client_cap_add,
            security_opt=settings.client_security_opt,
            restart_policy={"Name": settings.client_restart_policy},
            network=primary,
            hostname=name,
            # NOTE: no `entrypoint`. The image's ENTRYPOINT is s6-overlay's
            # /init, which must stay PID 1 — it runs the UID remap, volume
            # chown, config seeding and supervision tree before any service
            # starts. Overriding it skips all of that and the gateway will not
            # work.
            command=TENANT_MAIN_COMMAND,
        )
        for network_name in extra:
            self.client.networks.get(network_name).connect(container)
        container.start()
        return container

    async def create_and_start(
        self,
        *,
        name: str,
        image: str,
        environment: dict[str, str],
        labels: dict[str, str],
        volumes: dict[str, dict[str, str]],
        ports: dict[str, Any] | None = None,
        cpus: float | None = None,
        memory: str | None = None,
    ) -> str:
        """Build, wire up and start a client container; returns its id.

        Raises :class:`PortCollisionError` when a requested host port is taken,
        so the caller can retry on a different pair, and
        :class:`OrchestratorError` for every other daemon failure.
        """
        networks = [self.settings.client_network]
        if self.settings.proxy_mode == "traefik":
            networks.append(self.settings.traefik_network)

        try:
            await self.ensure_networks()
            container = await asyncio.to_thread(
                self._create_sync,
                name=name,
                image=image,
                environment=environment,
                labels=labels,
                volumes=volumes,
                ports=ports,
                cpus=cpus if cpus is not None else self.settings.client_cpus,
                memory=memory or self.settings.client_memory,
                networks=networks,
            )
        except ImageNotFound as exc:
            raise OrchestratorError(
                f"Image {image} not found locally and could not be pulled "
                f"(pull policy={self.settings.client_image_pull_policy}): {exc}"
            ) from exc
        except APIError as exc:
            if _is_port_collision(exc):
                raise PortCollisionError(
                    f"Host port for {name} is already allocated: {exc}"
                ) from exc
            raise OrchestratorError(f"Failed to start {name}: {exc}") from exc
        except _DAEMON_ERRORS as exc:
            raise OrchestratorError(f"Failed to start {name}: {exc}") from exc

        logger.info("Started container %s (%s)", name, container.short_id)
        return container.id

    def port_bindings(
        self, dash_port: int, api_port: int
    ) -> dict[str, tuple[str, int]]:
        """Loopback-only port bindings for the two supervised services.

        Binding to ``client_bind_host`` (127.0.0.1) rather than 0.0.0.0 keeps
        tenant dashboards off the public interface: the only public door is the
        reverse proxy. These published ports exist for host-side debugging and
        for the host-nginx deployment; the hub and a containerized nginx reach
        tenants over the shared Docker network instead.
        """
        host = self.settings.client_bind_host
        return {
            f"{self.settings.dash_internal_port}/tcp": (host, dash_port),
            f"{self.settings.api_internal_port}/tcp": (host, api_port),
        }

    async def stop(self, name_or_id: str, timeout: int = 30) -> bool:
        """Stop a container, giving the supervision tree time to shut down."""
        container = await self.get(name_or_id)
        if container is None:
            return False
        await asyncio.to_thread(container.stop, timeout=timeout)
        return True

    async def start(self, name_or_id: str) -> bool:
        container = await self.get(name_or_id)
        if container is None:
            return False
        await asyncio.to_thread(container.start)
        return True

    async def restart(self, name_or_id: str, timeout: int = 30) -> bool:
        container = await self.get(name_or_id)
        if container is None:
            return False
        await asyncio.to_thread(container.restart, timeout=timeout)
        return True

    async def remove(self, name_or_id: str, force: bool = True) -> bool:
        container = await self.get(name_or_id)
        if container is None:
            return False
        await asyncio.to_thread(container.remove, force=force)
        logger.info("Removed container %s", name_or_id)
        return True

    # ------------------------------------------------------------- status
    async def status(self, name_or_id: str) -> dict[str, Any]:
        container = await self.get(name_or_id)
        if container is None:
            return {"container_id": None, "state": "absent", "health": None,
                    "started_at": None, "finished_at": None, "restart_count": 0}
        state = container.attrs.get("State", {})
        return {
            "container_id": container.id,
            "state": state.get("Status", "unknown"),
            "health": (state.get("Health") or {}).get("Status"),
            "started_at": state.get("StartedAt"),
            "finished_at": state.get("FinishedAt"),
            "restart_count": container.attrs.get("RestartCount", 0),
        }

    async def logs(self, name_or_id: str, tail: int = 200) -> list[str]:
        container = await self.get(name_or_id)
        if container is None:
            return []
        raw: bytes = await asyncio.to_thread(container.logs, tail=tail, timestamps=True)
        return raw.decode("utf-8", errors="replace").splitlines()

    async def running_count(self) -> int:
        def _count() -> int:
            prefix = self.settings.client_container_prefix
            containers = self.client.containers.list(
                filters={"status": "running", "name": prefix}
            )
            return len(containers)

        try:
            return await asyncio.to_thread(_count)
        except Exception:  # noqa: BLE001 - dashboards should degrade, not fail
            return 0

    async def published_ports(self) -> set[int]:
        """Host ports currently published by hub-managed containers.

        The database is the hub's record of what it allocated, but reality can
        drift: a crashed provision, a hand-started container, or a port taken
        by something else entirely. Unioning this with the database view before
        allocating makes the allocator self-healing.
        """

        def _collect() -> set[int]:
            found: set[int] = set()
            containers = self.client.containers.list(
                all=True, filters={"name": self.settings.client_container_prefix}
            )
            for container in containers:
                bindings = (
                    container.attrs.get("HostConfig", {}).get("PortBindings") or {}
                )
                for entries in bindings.values():
                    for entry in entries or []:
                        raw = (entry or {}).get("HostPort")
                        if raw:
                            try:
                                found.add(int(raw))
                            except ValueError:
                                continue
            return found

        try:
            return await asyncio.to_thread(_collect)
        except Exception as exc:  # noqa: BLE001 - fall back to the DB view
            logger.warning("Could not enumerate published ports: %s", exc)
            return set()

    async def exec_run(
        self, name_or_id: str, command: str | list[str]
    ) -> tuple[int, str]:
        container = await self.get(name_or_id)
        if container is None:
            raise OrchestratorError(f"Container {name_or_id} not found")
        exit_code, output = await asyncio.to_thread(container.exec_run, command)
        return exit_code, output.decode("utf-8", errors="replace")

    def exec_lines_sync(
        self,
        name_or_id: str,
        command: list[str],
        *,
        user: str,
        environment: dict[str, str] | None = None,
    ) -> Iterator[str]:
        """Run a long-lived command and yield its output line by line. Blocking.

        For a dedicated worker thread: the iterator waits on the process for as
        long as the process runs.
        """
        container = self._get_sync(name_or_id)
        if container is None:
            raise OrchestratorError(f"Container {name_or_id} not found")
        try:
            result = container.exec_run(
                command, stream=True, user=user, environment=environment
            )
        except (APIError, *_DAEMON_ERRORS) as exc:
            raise OrchestratorError(f"Could not exec in {name_or_id}: {exc}") from exc

        buffer = ""
        for chunk in result.output:
            buffer += chunk.decode("utf-8", errors="replace")
            *lines, buffer = buffer.split("\n")
            yield from lines
        if buffer:
            yield buffer

    def restart_sync(self, name_or_id: str, timeout: int = 30) -> bool:
        """:meth:`restart` for a caller already on a worker thread."""
        container = self._get_sync(name_or_id)
        if container is None:
            return False
        container.restart(timeout=timeout)
        return True

    # ------------------------------------------------------------- health
    async def probe(self, url: str, timeout: float = 5.0) -> dict[str, Any]:
        """Single HTTP probe, reporting reachability rather than raising.

        Any status below 500 counts as reachable: the dashboard answers 401 on
        its health path once the auth gate is engaged, which still proves the
        service is up and correctly protected.
        """
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout) as http:
                response = await http.get(url)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            return {
                "url": url,
                "reachable": response.status_code < 500,
                "status": response.status_code,
                "latency_ms": elapsed_ms,
                "error": None,
            }
        except Exception as exc:  # noqa: BLE001 - probes never raise
            return {
                "url": url,
                "reachable": False,
                "status": None,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "error": str(exc),
            }

    def health_urls(self, client: Any) -> tuple[str, str]:
        """``(dashboard_url, api_url)`` to probe for ``client``."""
        settings = self.settings
        host, dash_port, api_port = settings.probe_targets_for(client)
        return (
            f"http://{host}:{dash_port}{settings.dash_health_path}",
            f"http://{host}:{api_port}{settings.api_health_path}",
        )

    async def wait_until_healthy(self, client: Any) -> tuple[bool, str]:
        """Poll a tenant's two services until both answer or time runs out.

        Returns ``(healthy, detail)``. The detail string is stored on the
        client row so a failed provision explains itself without a log dive.

        The container is re-checked each round: a crash-looping tenant is
        reported immediately rather than after the full timeout.
        """
        settings = self.settings
        name = client.container_name or settings.container_name_for(client.slug)
        dash_url, api_url = self.health_urls(client)
        deadline = asyncio.get_running_loop().time() + settings.client_health_timeout_seconds
        last = "no probe attempted"

        while asyncio.get_running_loop().time() < deadline:
            state = await self.status(name)
            if state["state"] in {"exited", "dead"}:
                return False, (
                    f"Container {name} {state['state']} during startup "
                    f"(restart_count={state['restart_count']}). Check "
                    f"`docker logs {name}`."
                )

            dash = await self.probe(dash_url)
            api = await self.probe(api_url)
            if dash["reachable"] and api["reachable"]:
                return True, (
                    f"dashboard {dash['status']} in {dash['latency_ms']}ms, "
                    f"api {api['status']} in {api['latency_ms']}ms"
                )
            last = (
                f"dashboard={dash['status'] or dash['error']}, "
                f"api={api['status'] or api['error']}"
            )
            await asyncio.sleep(3)

        return False, (
            f"Container {name} did not become healthy within "
            f"{settings.client_health_timeout_seconds}s ({last})"
        )


@lru_cache
def get_docker_service() -> DockerService:
    return DockerService(get_settings())
