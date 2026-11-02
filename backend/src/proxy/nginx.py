"""Nginx site management for tenant subdomains.

Each tenant gets one file in the sites-available directory and a symlink into
sites-enabled. Writes are atomic and always validated before a reload, because
a broken configuration takes down *every* tenant, not just the one being
provisioned. :meth:`NginxProxy.write_site` therefore rolls its own change back
if ``nginx -t`` fails, leaving the running config untouched.

Three control modes, selected by ``nginx_control_mode``:

``docker``
    nginx runs as a container (the default, local and production). Config lives
    on a path shared with that container; test and reload go through
    ``docker exec``.
``systemctl``
    nginx is installed on the host. Requires the hub to run outside Docker — a
    containerized hub has no host systemd to talk to.
``none``
    Skip writing, testing and reloading entirely. For unit tests and for
    exercising the provisioning flow where no nginx exists.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

from ..config.settings import Settings
from ..orchestrator.docker_service import DockerService, OrchestratorError

if TYPE_CHECKING:
    from ..clients.models import Client

logger = logging.getLogger(__name__)

#: Shared http-level directives (the websocket upgrade map and a catch-all
#: default server). Prefixed so it is clearly not a tenant.
SHARED_CONFIG_NAME = "00-hermes-shared"


class ProxyError(RuntimeError):
    """Nginx rejected a configuration, or could not be reached to reload."""


class NginxProxy:
    def __init__(self, settings: Settings, docker: DockerService) -> None:
        self.settings = settings
        self.docker = docker

    @property
    def enabled(self) -> bool:
        return self.settings.nginx_control_mode != "none"

    # -------------------------------------------------------------- paths
    def config_path(self, subdomain: str) -> Path:
        return self.settings.nginx_sites_available / (
            f"{subdomain}{self.settings.nginx_site_suffix}"
        )

    def enabled_path(self, subdomain: str) -> Path:
        return self.settings.nginx_sites_enabled / (
            f"{subdomain}{self.settings.nginx_site_suffix}"
        )

    def shared_config_path(self) -> Path:
        return self.settings.nginx_sites_enabled / (
            f"{SHARED_CONFIG_NAME}{self.settings.nginx_site_suffix}"
        )

    async def ensure_dirs(self) -> None:
        if not self.enabled:
            return
        for directory in (
            self.settings.nginx_sites_available,
            self.settings.nginx_sites_enabled,
        ):
            await asyncio.to_thread(
                lambda d=directory: d.mkdir(parents=True, exist_ok=True)
            )

    async def write_shared_config(self, content: str) -> None:
        """Install the http-level directives every tenant site depends on.

        Written on startup rather than at provisioning time: the tenant sites
        reference ``$connection_upgrade`` from this file, so it must exist
        before the first site is enabled, and it must survive a deployment
        that has no tenants yet.
        """
        if not self.enabled:
            logger.info("nginx_control_mode=none; skipping shared config")
            return
        await self.ensure_dirs()
        path = self.shared_config_path()
        await asyncio.to_thread(_atomic_write, path, content)
        logger.info("Wrote shared nginx config %s", path)

    # -------------------------------------------------------------- sites
    async def write_site(self, client: "Client", content: str) -> Path | None:
        """Write and enable a tenant site, validating before anything reloads.

        On a failed ``nginx -t`` the new file and symlink are removed and the
        error is raised, so a bad render can never be the reason an unrelated
        tenant goes down.
        """
        if not self.enabled:
            logger.info(
                "nginx_control_mode=none; skipping site for %s", client.subdomain
            )
            return None

        await self.ensure_dirs()
        available = self.config_path(client.subdomain)
        link = self.enabled_path(client.subdomain)

        await asyncio.to_thread(_atomic_write, available, content)
        await asyncio.to_thread(_link, available, link)

        ok, output = await self.test_config()
        if not ok:
            # Roll back before anyone reloads. Re-test afterwards so a
            # pre-existing unrelated breakage is not blamed on this tenant.
            await asyncio.to_thread(_unlink, link)
            await asyncio.to_thread(_unlink, available)
            still_broken, after = await self.test_config()
            if not still_broken:
                logger.error(
                    "nginx config for %s was rejected and has been rolled back",
                    client.subdomain,
                )
            raise ProxyError(
                f"nginx rejected the config for {client.subdomain} "
                f"(rolled back): {output.strip()}"
            )

        logger.info("Wrote and validated nginx site %s", available)
        return available

    async def remove_site(self, subdomain: str) -> bool:
        """Remove a tenant's site and symlink. Idempotent."""
        if not self.enabled:
            return False
        link_removed = await asyncio.to_thread(_unlink, self.enabled_path(subdomain))
        file_removed = await asyncio.to_thread(_unlink, self.config_path(subdomain))
        if link_removed or file_removed:
            logger.info("Removed nginx site for %s", subdomain)
        return link_removed or file_removed

    # ----------------------------------------------------- test & reload
    async def test_config(self) -> tuple[bool, str]:
        """Run ``nginx -t``. Returns ``(ok, combined_output)``.

        nginx writes ``-t`` results to stderr even on success, so both streams
        are captured and merged.
        """
        if not self.enabled:
            return True, "nginx_control_mode=none"
        return await self._run(self.settings.nginx_test_command)

    async def reload(self) -> None:
        """Ask nginx to pick up the new configuration.

        Raises :class:`ProxyError` on failure. Callers treat that as fatal for
        the operation in progress: a tenant whose site is on disk but not
        loaded is not actually reachable, and reporting success would be a lie.
        """
        if not self.enabled:
            return
        ok, output = await self._run(self.settings.nginx_reload_command)
        if not ok:
            raise ProxyError(f"nginx reload failed: {output.strip()}")
        logger.info("Reloaded nginx")

    async def _run(self, command: list[str]) -> tuple[bool, str]:
        """Execute an nginx command through the configured control channel."""
        mode = self.settings.nginx_control_mode
        if mode == "docker":
            return await self._run_in_container(command)
        if mode == "systemctl":
            return await self._run_on_host(command)
        return True, f"nginx_control_mode={mode}"

    async def _run_in_container(self, command: list[str]) -> tuple[bool, str]:
        try:
            exit_code, output = await self.docker.exec_run(
                self.settings.nginx_container_name, command
            )
        except OrchestratorError as exc:
            # A missing nginx container is a deployment problem, not a
            # transient one; surface it rather than silently continuing.
            return False, (
                f"could not exec into nginx container "
                f"'{self.settings.nginx_container_name}': {exc}"
            )
        return exit_code == 0, output

    async def _run_on_host(self, command: list[str]) -> tuple[bool, str]:
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except (OSError, ValueError) as exc:
            return False, f"could not run {' '.join(command)}: {exc}"
        stdout, _ = await process.communicate()
        return process.returncode == 0, stdout.decode("utf-8", errors="replace")


# --------------------------------------------------------------- helpers
def _atomic_write(path: Path, content: str) -> None:
    """Write via a temp file in the same directory, then rename over.

    nginx may be reading the directory concurrently; a rename is atomic within
    a filesystem, so a reader sees either the old file or the new one, never a
    half-written config.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(content, encoding="utf-8")
    os.replace(temp, path)


def _link(source: Path, link: Path) -> None:
    """Point ``link`` at ``source``, replacing whatever was there.

    Falls back to copying on filesystems that refuse symlinks (notably Windows
    without developer mode), so the enabled directory always ends up with
    usable content.

    The identity check comes FIRST and must stay there. When
    sites-available and sites-enabled are the same directory — the normal
    arrangement for a containerized nginx reading conf.d, and the default this
    module ships with — ``source`` and ``link`` are the same file, and the file
    ``_atomic_write`` just created *is* the enabled site. Unlinking before
    checking deleted that config, and because the file was then absent
    ``nginx -t`` had nothing to reject and the reload succeeded, so
    provisioning reported success for a tenant that had no route at all.
    """
    link.parent.mkdir(parents=True, exist_ok=True)
    if source == link or source.resolve() == link.resolve():
        return
    if link.is_symlink() or link.exists():
        _unlink(link)
    try:
        link.symlink_to(source)
    except (OSError, NotImplementedError):
        link.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def _unlink(path: Path) -> bool:
    # is_symlink() first: a dangling symlink reports exists() == False but
    # still occupies the name and still has to be removed.
    if path.is_symlink() or path.exists():
        try:
            path.unlink()
            return True
        except OSError as exc:  # pragma: no cover - permissions
            logger.warning("Could not remove %s: %s", path, exc)
    return False
