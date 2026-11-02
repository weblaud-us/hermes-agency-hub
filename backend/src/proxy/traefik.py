"""Traefik label generation for dynamic subdomain routing.

Under Traefik nothing has to be written to disk: the labels on the container
*are* the routing config, so a client appears and disappears with its container.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..config.settings import Settings

if TYPE_CHECKING:
    from ..clients.models import Client

LOCAL_DOMAINS = {"localhost", "127.0.0.1"}


def router_name(slug: str) -> str:
    return f"hermes-{slug}"


def labels_for(settings: Settings, client: "Client") -> dict[str, str]:
    """Traefik labels routing ``<slug>.<base_domain>`` to the container.

    Two routers per tenant, mirroring the nginx site: the dashboard on the bare
    host and the OpenAI-compatible API under ``/v1``. The API router carries a
    higher priority so its path prefix wins over the catch-all host rule.
    """
    dash = router_name(client.slug)
    api = f"{dash}-api"
    local = settings.base_domain in LOCAL_DOMAINS
    entrypoint = "web" if local else settings.traefik_entrypoint
    host_rule = f"Host(`{client.subdomain}`)"

    labels = {
        "traefik.enable": "true",
        "traefik.docker.network": settings.traefik_network,
        # --- dashboard (default route) ---
        f"traefik.http.routers.{dash}.rule": host_rule,
        f"traefik.http.routers.{dash}.entrypoints": entrypoint,
        f"traefik.http.routers.{dash}.service": dash,
        f"traefik.http.services.{dash}.loadbalancer.server.port": str(
            settings.dash_internal_port
        ),
        # --- OpenAI-compatible API ---
        f"traefik.http.routers.{api}.rule": f"{host_rule} && PathPrefix(`/v1`)",
        f"traefik.http.routers.{api}.entrypoints": entrypoint,
        f"traefik.http.routers.{api}.service": api,
        f"traefik.http.routers.{api}.priority": "100",
        f"traefik.http.services.{api}.loadbalancer.server.port": str(
            settings.api_internal_port
        ),
        # Ownership metadata — handy for `docker ps --filter label=...`
        "hermes.hub.managed": "true",
        "hermes.client.slug": client.slug,
        "hermes.client.subdomain": client.subdomain,
        "hermes.client.plan": client.plan.value,
    }

    if not local:
        for router in (dash, api):
            labels[f"traefik.http.routers.{router}.tls"] = "true"
            labels[f"traefik.http.routers.{router}.tls.certresolver"] = (
                settings.traefik_cert_resolver
            )

    return labels
