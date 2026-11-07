"""The provisioning coordinator: the one place that knows the whole sequence.

``clients/service.py`` owns persistence and knows nothing about Docker;
``docker_service.py`` and ``proxy/`` own their respective resources and know
nothing about the database. This module is the only one that holds all of it at
once, which makes it the only place that can clean up after a partial failure.

Two invariants govern everything here:

**Never leave a half-provisioned tenant behind.** Provisioning touches four
kinds of state — a database row, a directory tree, a container, and an nginx
site. A failure at step 7 must not leave the artefacts of steps 1-6 lying
around pretending to work. :func:`provision_client` tracks what it created and
unwinds it in reverse on any exception.

**Never report success that is not true.** A container that started but failed
its health probe is recorded as ``FAILED`` with the probe output, not as
``ACTIVE``. The operator still receives the credentials — they are valid, and
withholding them would strand the tenant — but the response carries a warning.

This is also the one module that commits on the request's session. The request
dependency rolls back on any exception, which would erase the record of a failed
run along with the run, so :meth:`Provisioner.provision_client` commits once
before touching Docker and :meth:`Provisioner._record_failure` commits the
outcome before re-raising.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..clients import service as client_service
from ..clients import skills as skill_sync
from ..clients.models import AuditStatus, BusinessMode, Client, SubscriptionStatus
from ..config.settings import Settings, get_settings
from ..proxy.service import (
    NoPortAvailableError,
    ProxyError,
    ProxyService,
    allocate_port_pair,
    get_proxy_service,
)
from .credentials import TenantCredentials, generate_tenant_credentials, key_last4
from .docker_service import (
    DockerService,
    OrchestratorError,
    PortCollisionError,
    get_docker_service,
)
from .templates import TemplateRenderer, docker_environment, get_renderer

logger = logging.getLogger(__name__)

#: How many times to retry with a fresh port pair when the daemon reports a
#: collision. Each attempt excludes the pair that just lost, so the retries
#: make progress rather than re-rolling the same numbers.
PORT_RETRY_ATTEMPTS = 4


@dataclass
class ProvisionResult:
    """Outcome of a provisioning run."""

    credentials: TenantCredentials
    healthy: bool
    detail: str
    synced_skills: list[str] = field(default_factory=list)


@dataclass
class TeardownResult:
    container_removed: bool
    proxy_removed: bool
    archive_path: Path | None


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class Provisioner:
    def __init__(
        self,
        settings: Settings,
        docker: DockerService,
        proxy: ProxyService,
        renderer: TemplateRenderer,
    ) -> None:
        self.settings = settings
        self.docker = docker
        self.proxy = proxy
        self.renderer = renderer

    # ------------------------------------------------------------ startup
    async def bootstrap(self) -> None:
        """Prepare the shared state a tenant depends on. Idempotent.

        Runs on every hub start so a fresh deployment, a restarted container
        and a manually cleaned directory all converge on the same layout.
        """
        settings = self.settings
        await self.docker.ensure_networks()
        await self.docker.ensure_image()

        def _make_dirs() -> None:
            for directory in (
                settings.data_root,
                settings.tenant_root,
                settings.archive_root,
                settings.skills_publish_dir,
            ):
                if directory is not None:
                    directory.mkdir(parents=True, exist_ok=True)

        await asyncio.to_thread(_make_dirs)
        await self._publish_shared_skills()
        await self.proxy.bootstrap()

    async def _publish_shared_skills(self) -> None:
        """Copy the agency skill library to a daemon-visible location.

        The canonical library is mounted into the hub, at a path only this
        process can see. A bind mount source has to be resolvable by the Docker
        daemon, so the library is republished under ``data_root`` — which *is*
        path-identical on both sides — and that copy is what tenants mount.
        """
        settings = self.settings
        source = settings.shared_skills_dir
        target = settings.skills_publish_dir
        if target is None:
            return
        if not source.is_dir():
            logger.warning(
                "Shared skills directory %s does not exist; tenants will mount "
                "an empty agency library",
                source,
            )
            await asyncio.to_thread(target.mkdir, parents=True, exist_ok=True)
            return

        def _publish() -> None:
            target.mkdir(parents=True, exist_ok=True)
            for entry in source.iterdir():
                if not entry.is_dir():
                    continue
                destination = target / entry.name
                shutil.rmtree(destination, ignore_errors=True)
                shutil.copytree(entry, destination)

        await asyncio.to_thread(_publish)
        logger.info("Published shared skills from %s to %s", source, target)

    # --------------------------------------------------------- provision
    async def provision_client(
        self,
        session: AsyncSession,
        client: Client,
        openrouter_api_key: str,
    ) -> ProvisionResult:
        """Stand up a tenant end to end.

        On success the client is ``ACTIVE``. On a health-probe failure it is
        ``FAILED`` but its container and route are left in place for
        diagnosis. On any other failure everything created here is unwound and
        the exception propagates.
        """
        settings = self.settings
        # Held as plain values: a database error can leave ``client`` unreadable,
        # and the unwind must still know what to remove.
        subdomain = client.subdomain
        name = client.container_name or settings.container_name_for(client.slug)

        await client_service.set_status(
            session, client, SubscriptionStatus.PROVISIONING
        )
        await client_service.record_audit(
            session, client, "provision", AuditStatus.STARTED,
            f"Provisioning {subdomain}.",
        )
        # Durable before any slow or fallible work: a hub that dies from here on
        # leaves the lone STARTED row that reconciliation looks for.
        await session.commit()

        # Track what we create so a failure can unwind precisely rather than
        # guessing. Directories are deliberately NOT unwound: a tenant's data
        # is the one thing worth keeping after a failed run.
        created_container = False
        registered_proxy = False

        try:
            tenant_dir = settings.tenant_dir_for(subdomain)
            await asyncio.to_thread(
                _make_tenant_dir, tenant_dir, settings.tenant_dir_mode
            )

            credentials = generate_tenant_credentials(subdomain)
            await client_service.apply_credentials(
                session, client, credentials, key_last4=key_last4(openrouter_api_key)
            )

            requested = (client.config or {}).get("requested_skills")
            synced = await skill_sync.sync_skills(
                settings,
                subdomain,
                client.plan.value,
                client.business_mode.value,
                requested if isinstance(requested, list) else None,
            )
            client.synced_skills = synced
            # The whole library is also mounted read-only, so the copy above is
            # not enough to keep e-commerce skills away from a general business.
            client.config = _config_for_mode(settings, client)
            await session.flush()

            container_id = await self._create_container(
                session, client, credentials, openrouter_api_key
            )
            created_container = True
            client.container_id = container_id
            await session.flush()

            await self.proxy.register(client)
            registered_proxy = True

            healthy, detail = await self.docker.wait_until_healthy(client)
            if healthy:
                await client_service.set_status(
                    session, client, SubscriptionStatus.ACTIVE, detail
                )
                await client_service.record_audit(
                    session, client, "provision", AuditStatus.SUCCEEDED, detail,
                    payload={
                        "container_id": container_id[:12],
                        "port_dash": client.container_port_dash,
                        "port_api": client.container_port_api,
                        "skills": synced,
                    },
                )
                logger.info("Provisioned %s successfully", subdomain)
            else:
                # The tenant exists and its credentials are real; it simply is
                # not answering yet. Keep the container and route so the
                # operator can read `docker logs`, but do not claim success.
                await client_service.set_status(
                    session, client, SubscriptionStatus.FAILED, detail
                )
                await client_service.record_audit(
                    session, client, "provision", AuditStatus.FAILED, detail,
                )
                logger.warning("Provisioned %s but it is unhealthy: %s", subdomain, detail)

            return ProvisionResult(
                credentials=credentials,
                healthy=healthy,
                detail=detail,
                synced_skills=synced,
            )

        except Exception as exc:
            await self._recover_session(session, client)
            await self._rollback(
                client,
                name=name,
                subdomain=subdomain,
                container=created_container,
                proxy=registered_proxy,
                reason=str(exc),
            )
            await self._record_failure(session, client, exc)
            logger.exception("Provisioning %s failed", subdomain)
            raise

    async def _create_container(
        self,
        session: AsyncSession,
        client: Client,
        credentials: TenantCredentials,
        openrouter_api_key: str,
    ) -> str:
        """Render the tenant's files and start its container.

        Retries on a port collision. The rendered ``.env`` embeds nothing
        port-dependent, but it is rewritten on each attempt anyway so the
        recorded ports and the files on disk never disagree.
        """
        settings = self.settings
        tried: set[int] = set()
        last_error: Exception | None = None

        for attempt in range(1, PORT_RETRY_ATTEMPTS + 1):
            db_ports = await client_service.used_ports(session)
            live_ports = await self.docker.published_ports()
            dash_port, api_port = allocate_port_pair(
                settings, db_ports | live_ports, exclude=tried
            )
            client.container_port_dash = dash_port
            client.container_port_api = api_port
            await session.flush()

            env_text = await self.renderer.write_client_files(
                client,
                credentials=credentials,
                openrouter_api_key=openrouter_api_key,
            )

            try:
                return await self.docker.create_and_start(
                    name=client.container_name
                    or settings.container_name_for(client.slug),
                    image=client.image,
                    environment=docker_environment(env_text),
                    labels=self.proxy.container_labels(client),
                    volumes=self._volumes_for(client),
                    ports=self.docker.port_bindings(dash_port, api_port),
                    cpus=client.cpu_limit,
                    memory=client.memory_limit,
                )
            except PortCollisionError as exc:
                last_error = exc
                tried.update({dash_port, api_port})
                logger.warning(
                    "Port pair %s/%s collided for %s (attempt %d/%d); retrying",
                    dash_port, api_port, client.subdomain,
                    attempt, PORT_RETRY_ATTEMPTS,
                )

        # Out of attempts: surface the collision rather than a vague failure.
        raise OrchestratorError(
            f"Could not find a free port pair for {client.subdomain} after "
            f"{PORT_RETRY_ATTEMPTS} attempts: {last_error}"
        )

    def _volumes_for(self, client: Client) -> dict[str, dict[str, str]]:
        """Bind mounts for a tenant container.

        Both sources are translated to the daemon's view — these are the paths
        Docker resolves, not paths this process reads.

        The shared library mounts read-only *inside* the tenant's own skills
        directory, so the agent discovers agency skills alongside its own
        without being able to modify them. The tenant's writable copy and the
        shared copy therefore coexist under one tree.
        """
        settings = self.settings
        return {
            str(settings.tenant_source_for(client.subdomain)): {
                "bind": "/opt/data",
                "mode": "rw",
            },
            str(settings.skills_source()): {
                "bind": settings.shared_skills_mount,
                "mode": "ro",
            },
        }

    async def _recover_session(self, session: AsyncSession, client: Client) -> None:
        """Discard a failed run's writes and make ``client`` readable again.

        This drops partial state (credentials for a tenant that does not exist)
        and clears a session that a database error left unusable. Everything
        after it depends on the session working, but none of it may hide the
        original failure, so this logs rather than raises.
        """
        try:
            await session.rollback()
            await session.refresh(client)
        except Exception:  # noqa: BLE001 - never mask the original error
            logger.exception("Could not recover the session after a failed provision")

    async def _rollback(
        self,
        client: Client,
        *,
        name: str,
        subdomain: str,
        container: bool,
        proxy: bool,
        reason: str,
    ) -> None:
        """Undo what a failed provisioning run created, in reverse order.

        Every step is independently guarded: a rollback that raises would mask
        the original failure, which is the thing the operator actually needs to
        see. The tenant directory is intentionally preserved.
        """
        logger.warning("Rolling back provisioning of %s: %s", subdomain, reason)

        if proxy:
            try:
                await self.proxy.unregister(client)
            except Exception:  # noqa: BLE001 - never mask the original error
                logger.exception("Rollback: could not unregister proxy for %s",
                                 subdomain)

        if container:
            try:
                await self.docker.remove(name, force=True)
            except Exception:  # noqa: BLE001
                logger.exception("Rollback: could not remove container %s", name)

    async def _record_failure(
        self, session: AsyncSession, client: Client, exc: Exception
    ) -> None:
        """Commit a failed run's outcome so it outlives the request's rollback.

        Guarded like :meth:`_rollback`: failing to write the record must not
        mask the failure it describes.
        """
        try:
            # Release the ports so the next attempt can reuse them.
            client.container_port_dash = None
            client.container_port_api = None
            client.container_id = None
            await client_service.set_status(
                session, client, SubscriptionStatus.FAILED, str(exc)
            )
            await client_service.record_audit(
                session, client, "provision", AuditStatus.FAILED,
                f"Provisioning failed: {exc}",
                payload={"error_type": type(exc).__name__},
            )
            await session.commit()
        except Exception:  # noqa: BLE001 - never mask the original error
            logger.exception("Could not record the failed provision of a client")

    # ---------------------------------------------------------- teardown
    async def teardown_client(
        self, session: AsyncSession, client: Client, *, archive: bool = True
    ) -> TeardownResult:
        """Stop and remove a tenant, archiving its data.

        Idempotent and deliberately forgiving: a tenant whose container or
        route is already gone still tears down cleanly. Teardown must be able
        to finish on a partially broken deployment — that is usually *why* it
        is being called.
        """
        settings = self.settings
        subdomain = client.subdomain
        name = client.container_name or settings.container_name_for(client.slug)

        await client_service.record_audit(
            session, client, "teardown", AuditStatus.STARTED,
            f"Tearing down {subdomain} (archive={archive}).",
        )

        # Stop before unregistering so in-flight requests finish against a
        # draining container rather than hitting a dead upstream.
        try:
            await self.docker.stop(name, timeout=30)
        except OrchestratorError as exc:
            logger.warning("Could not stop %s cleanly: %s", name, exc)

        proxy_removed = False
        try:
            await self.proxy.unregister(client)
            proxy_removed = True
        except ProxyError as exc:
            logger.warning("Could not unregister proxy for %s: %s", subdomain, exc)

        container_removed = False
        try:
            container_removed = await self.docker.remove(name, force=True)
        except OrchestratorError as exc:
            logger.warning("Could not remove container %s: %s", name, exc)

        archive_path: Path | None = None
        tenant_dir = settings.tenant_dir_for(subdomain)
        if archive:
            archive_path = await asyncio.to_thread(
                _archive_dir, tenant_dir, settings.archive_dir_for(subdomain, _utc_stamp())
            )
        else:
            await asyncio.to_thread(shutil.rmtree, tenant_dir, True)

        client.container_id = None
        client.container_port_dash = None
        client.container_port_api = None
        await client_service.set_status(
            session,
            client,
            SubscriptionStatus.ARCHIVED,
            f"Torn down; data at {archive_path}" if archive_path else "Torn down.",
        )
        await client_service.record_audit(
            session, client, "teardown", AuditStatus.SUCCEEDED,
            f"Tore down {subdomain}.",
            payload={
                "container_removed": container_removed,
                "proxy_removed": proxy_removed,
                "archive_path": str(archive_path) if archive_path else None,
            },
        )
        logger.info("Tore down %s", subdomain)

        return TeardownResult(
            container_removed=container_removed,
            proxy_removed=proxy_removed,
            archive_path=archive_path,
        )

    # ------------------------------------------------------------ health
    async def health_check(self, client: Client) -> dict[str, Any]:
        """Report a tenant's container state and service reachability.

        Never raises: a health endpoint that errors out is useless precisely
        when it matters. An unreachable daemon surfaces as ``state="unknown"``
        with the probes marked unreachable.
        """
        name = client.container_name or self.settings.container_name_for(client.slug)
        try:
            state = await self.docker.status(name)
        except OrchestratorError as exc:
            state = {
                "container_id": None,
                "state": "unknown",
                "health": None,
                "started_at": None,
                "restart_count": 0,
            }
            logger.warning("Could not read container state for %s: %s", name, exc)

        dash_probe: dict[str, Any] | None = None
        api_probe: dict[str, Any] | None = None
        if state["state"] == "running":
            dash_url, api_url = self.docker.health_urls(client)
            # Probe both concurrently; they are independent services.
            dash_probe, api_probe = await asyncio.gather(
                self.docker.probe(dash_url), self.docker.probe(api_url)
            )

        healthy = bool(
            state["state"] == "running"
            and dash_probe
            and api_probe
            and dash_probe["reachable"]
            and api_probe["reachable"]
        )
        return {
            "container_state": state["state"],
            "container_id": state["container_id"],
            "container_health": state["health"],
            "started_at": state["started_at"],
            "restart_count": state["restart_count"],
            "dashboard": dash_probe,
            "api": api_probe,
            "healthy": healthy,
        }


# --------------------------------------------------------------- helpers
def _config_for_mode(settings: Settings, client: Client) -> dict[str, Any]:
    """``client.config`` with e-commerce skills disabled unless the client is one."""
    config = dict(client.config or {})
    disabled = set(config.get("disabled_skills") or [])
    if client.business_mode is BusinessMode.ECOMMERCE:
        disabled -= skill_sync.ECOMMERCE_SKILLS
    else:
        disabled |= skill_sync.ECOMMERCE_SKILLS & set(skill_sync.available_skills(settings))
    if disabled:
        config["disabled_skills"] = sorted(disabled)
    else:
        config.pop("disabled_skills", None)
    return config


def _make_tenant_dir(path: Path, mode: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(mode)
    except (OSError, NotImplementedError):  # pragma: no cover - platform
        # Windows bind mounts have synthetic permissions; not fatal.
        pass


def _archive_dir(source: Path, destination: Path) -> Path | None:
    """Move a tenant directory aside, returning where it landed.

    A move is preferred over a copy so the operation is atomic within a
    filesystem and cannot leave two authoritative copies. Falls back to a copy
    when the archive lives on a different device.
    """
    if not source.exists():
        return None
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        source.rename(destination)
    except OSError:
        shutil.copytree(source, destination, dirs_exist_ok=True)
        shutil.rmtree(source, ignore_errors=True)
    return destination


_provisioner: Provisioner | None = None


def get_provisioner() -> Provisioner:
    """Process-wide provisioner.

    Not ``lru_cache``d like the other factories: it composes three cached
    singletons, and a plain module global keeps the dependency direction
    obvious when reading a traceback.
    """
    global _provisioner
    if _provisioner is None:
        _provisioner = Provisioner(
            get_settings(), get_docker_service(), get_proxy_service(), get_renderer()
        )
    return _provisioner
