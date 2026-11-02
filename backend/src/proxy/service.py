"""Facade over the two routing backends.

Callers ask the proxy to register or unregister a client and never branch on
``proxy_mode`` themselves.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import TYPE_CHECKING, Iterable

from ..config.settings import Settings, get_settings
from ..orchestrator.docker_service import DockerService, get_docker_service
from ..orchestrator.templates import TemplateRenderer, get_renderer
from . import traefik
from .nginx import NginxProxy, ProxyError

if TYPE_CHECKING:
    from ..clients.models import Client

logger = logging.getLogger(__name__)

__all__ = [
    "NoPortAvailableError",
    "ProxyError",
    "ProxyService",
    "allocate_port_pair",
    "get_proxy_service",
]


class NoPortAvailableError(RuntimeError):
    """Every port in a configured range is already handed out."""


def _lowest_free(
    bounds: tuple[int, int], taken: set[int], label: str
) -> int:
    start, end = bounds
    for port in range(start, end + 1):
        if port not in taken:
            return port
    raise NoPortAvailableError(
        f"No free {label} port in {start}-{end}; "
        f"{len(taken)} port(s) are in use."
    )


def allocate_port_pair(
    settings: Settings,
    used: Iterable[int],
    *,
    exclude: Iterable[int] = (),
) -> tuple[int, int]:
    """Pick a free ``(dashboard, api)`` host port pair.

    ``used`` should combine the hub's database view with the ports Docker
    reports as published, so a crashed provision or a hand-started container
    cannot hand the same port out twice. ``exclude`` lets a caller skip a pair
    that just lost a race, making retries make progress instead of looping.

    The two ranges are validated as non-overlapping at settings load, so a
    single ``taken`` set is safe for both lookups.
    """
    taken = set(used) | set(exclude)
    dash = _lowest_free(settings.dash_port_range, taken, "dashboard")
    api = _lowest_free(settings.api_port_range, taken, "api")
    return dash, api


class ProxyService:
    def __init__(
        self,
        settings: Settings,
        docker: DockerService,
        renderer: TemplateRenderer,
    ) -> None:
        self.settings = settings
        self.nginx = NginxProxy(settings, docker)
        self.renderer = renderer

    @property
    def mode(self) -> str:
        return self.settings.proxy_mode

    @property
    def needs_host_port(self) -> bool:
        """Traefik reaches containers over the shared network; nginx may not.

        Ports are published regardless (for host-side debugging and the
        host-nginx deployment), so this reports whether routing *depends* on
        them rather than whether they exist.
        """
        return (
            self.settings.proxy_mode == "nginx"
            and self.settings.nginx_upstream_mode == "loopback"
        )

    def container_labels(self, client: "Client") -> dict[str, str]:
        if self.settings.proxy_mode == "traefik":
            return traefik.labels_for(self.settings, client)
        return {
            "hermes.hub.managed": "true",
            "hermes.client.slug": client.slug,
            "hermes.client.subdomain": client.subdomain,
            "hermes.client.plan": client.plan.value,
        }

    async def bootstrap(self) -> None:
        """Install the shared nginx directives. Safe to call repeatedly."""
        if self.settings.proxy_mode != "nginx":
            return
        await self.nginx.write_shared_config(self.renderer.render_nginx_shared())
        # Reload so a fresh deployment serves the catch-all default server
        # before any tenant exists. A failure here is logged, not raised: the
        # hub must still start so an operator can diagnose it over the API.
        try:
            await self.nginx.reload()
        except ProxyError as exc:
            logger.warning("Could not reload nginx during bootstrap: %s", exc)

    async def register(self, client: "Client") -> None:
        """Make ``client.subdomain`` resolve to the client's container."""
        if self.settings.proxy_mode == "traefik":
            logger.debug("Traefik routes %s via container labels", client.subdomain)
            return
        await self.nginx.write_site(client, self.renderer.render_nginx(client))
        await self.nginx.reload()

    async def unregister(self, client: "Client") -> None:
        """Remove a client's route. Idempotent; never raises on absence."""
        if self.settings.proxy_mode == "traefik":
            return
        if await self.nginx.remove_site(client.subdomain):
            try:
                await self.nginx.reload()
            except ProxyError as exc:
                # The site file is already gone, so the tenant is unreachable
                # either way. Teardown should not fail because nginx was down.
                logger.warning(
                    "Removed site for %s but could not reload nginx: %s",
                    client.subdomain,
                    exc,
                )


@lru_cache
def get_proxy_service() -> ProxyService:
    return ProxyService(get_settings(), get_docker_service(), get_renderer())
