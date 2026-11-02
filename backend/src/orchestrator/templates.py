"""Render the per-client artefacts: .env, config.yaml and the nginx site.

The templates under ``backend/templates/`` are the source of truth for what a
tenant container is configured with.

Secrets flow one way only. The hub holds a tenant's scrypt password hash, its
session secret and its bearer token; it renders them into ``<tenant>/.env`` at
mode 0600 and does **not** also pass them through the Docker ``environment``
dict. That is deliberate: the agent loads ``$HERMES_HOME/.env`` with
``override=True``, so a value in both places resolves to the file anyway while
emitting a confusing "set in both" warning at boot. One channel, one answer.

The OpenRouter key is the clearest case — it is written here and nowhere else,
including the hub's own database.
"""

from __future__ import annotations

import asyncio
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from ..config.settings import Settings, get_settings

if TYPE_CHECKING:  # avoid a circular import at runtime
    from ..clients.models import Client
    from .credentials import TenantCredentials

logger = logging.getLogger(__name__)

ENV_TEMPLATE = "client-env.template"
CONFIG_TEMPLATE = "client-config.yaml"
NGINX_TEMPLATE = "nginx-subdomain.conf"
NGINX_SHARED_TEMPLATE = "nginx-shared.conf"

#: Long enough for a streamed agent turn that pauses between tokens.
DEFAULT_PROXY_READ_TIMEOUT = 600
#: Dashboard session lifetime; the image refreshes via a 30-day refresh token,
#: so this controls refresh frequency rather than how long a login lasts.
DEFAULT_DASHBOARD_TTL_SECONDS = 12 * 60 * 60


def parse_env(text: str) -> dict[str, str]:
    """Parse a rendered .env file into a mapping.

    Used to derive the small non-secret subset handed to Docker (see
    :func:`docker_environment`) and by tests asserting the render round-trips.
    """
    env: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env[key.strip()] = value
    return env


#: Keys safe to pass via `docker run -e`. Everything else in the rendered .env
#: is either a secret or redundant with it. HERMES_UID/GID are here because the
#: image's s6 init reads them from the *process* environment during stage2,
#: before the .env file is loaded by the application.
DOCKER_ENV_KEYS = frozenset(
    {
        "HERMES_HOME",
        "HERMES_UID",
        "HERMES_GID",
        "AGENCY_CLIENT_SLUG",
        "AGENCY_CLIENT_PLAN",
        "AGENCY_ENVIRONMENT",
    }
)


def docker_environment(env_text: str) -> dict[str, str]:
    """The non-secret subset of a rendered .env, for the container env.

    Secrets stay out: they live in the 0600 file the container mounts, which
    takes precedence anyway. Keeping them out of the container environment also
    keeps them out of ``docker inspect`` output.
    """
    return {
        key: value
        for key, value in parse_env(env_text).items()
        if key in DOCKER_ENV_KEYS
    }


class TemplateRenderer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.env = Environment(
            loader=FileSystemLoader(str(settings.templates_dir)),
            # StrictUndefined: a template referencing a context key we forgot
            # to supply must fail loudly at provisioning time rather than
            # silently rendering an empty credential.
            undefined=StrictUndefined,
            autoescape=select_autoescape(enabled_extensions=(), default=False),
            keep_trailing_newline=True,
            trim_blocks=True,
            lstrip_blocks=True,
        )

    # ------------------------------------------------------------ context
    def context_for(
        self,
        client: "Client",
        *,
        credentials: "TenantCredentials | None" = None,
        openrouter_api_key: str = "",
    ) -> dict[str, Any]:
        """Build the render context for one tenant.

        ``credentials`` is supplied during provisioning, when the freshly
        minted set is still in memory. Re-renders outside provisioning (e.g.
        regenerating an nginx site) pass ``None`` and fall back to the stored
        hash and secret — which is why the plaintext password is never needed
        to rebuild a tenant's files.
        """
        settings = self.settings
        plan = settings.plan_for(client.plan.value)
        upstream_host, upstream_dash, upstream_api = settings.upstream_for(client)

        return {
            # identity
            "client": client,
            "slug": client.slug,
            # nginx upstream names must not contain hyphens in all versions;
            # underscores are universally safe.
            "slug_underscored": client.slug.replace("-", "_"),
            "company_name": client.company_name,
            "contact_email": client.contact_email,
            "plan": client.plan.value,
            "subdomain": client.subdomain,
            "public_url": settings.client_url_for(client.slug),
            # ports
            "dash_internal_port": settings.dash_internal_port,
            "api_internal_port": settings.api_internal_port,
            "container_port_dash": client.container_port_dash,
            "container_port_api": client.container_port_api,
            # credentials — prefer the in-memory set, else what is stored
            "dashboard_username": (
                credentials.dashboard_username
                if credentials
                else client.dashboard_username
            ),
            "dashboard_password_hash": (
                credentials.dashboard_password_hash
                if credentials
                else client.dashboard_password_hash
            ),
            "dashboard_secret": (
                credentials.dashboard_secret if credentials else client.dashboard_secret
            ),
            "api_key": credentials.api_key if credentials else client.api_key,
            "openrouter_api_key": openrouter_api_key,
            "dashboard_session_ttl_seconds": DEFAULT_DASHBOARD_TTL_SECONDS,
            # runtime
            "client_uid": settings.client_uid,
            "client_gid": settings.client_gid,
            "model": client.config.get("model", settings.client_model),
            "effort": client.config.get("effort", settings.client_effort),
            "system_prompt": client.config.get("system_prompt", ""),
            "max_conversations": plan.max_conversations,
            "skills": client.synced_skills or [],
            "channels": client.channels or {},
            "config": client.config or {},
            # proxy
            "upstream_host": upstream_host,
            "upstream_dash_port": upstream_dash,
            "upstream_api_port": upstream_api,
            "upstream_mode": settings.nginx_upstream_mode,
            "proxy_read_timeout": DEFAULT_PROXY_READ_TIMEOUT,
            # hub
            "hub_url": settings.hub_public_url,
            "internal_token": client.internal_token,
            "environment": settings.environment,
        }

    # ------------------------------------------------------------- render
    def render(self, template_name: str, context: dict[str, Any]) -> str:
        return self.env.get_template(template_name).render(**context)

    async def write_client_files(
        self,
        client: "Client",
        *,
        credentials: "TenantCredentials | None" = None,
        openrouter_api_key: str = "",
    ) -> str:
        """Render .env + config.yaml into the tenant directory.

        Returns the rendered env text so the caller can derive the container
        environment without re-reading the file off disk.
        """
        context = self.context_for(
            client, credentials=credentials, openrouter_api_key=openrouter_api_key
        )
        env_text = self.render(ENV_TEMPLATE, context)
        config_text = self.render(CONFIG_TEMPLATE, context)
        tenant_dir = self.settings.tenant_dir_for(client.subdomain)

        await asyncio.to_thread(
            _write_tenant_files,
            tenant_dir,
            env_text,
            config_text,
            dir_mode=self.settings.tenant_dir_mode,
            env_mode=self.settings.tenant_env_mode,
        )
        logger.info("Rendered tenant files for %s into %s", client.slug, tenant_dir)
        return env_text

    def render_nginx(self, client: "Client") -> str:
        return self.render(NGINX_TEMPLATE, self.context_for(client))

    def render_nginx_shared(self) -> str:
        return self.render(NGINX_SHARED_TEMPLATE, {})


def _write_tenant_files(
    directory: Path,
    env_text: str,
    config_text: str,
    *,
    dir_mode: int,
    env_mode: int,
) -> None:
    """Blocking half of the tenant file write.

    ``.env`` is created with a restrictive umask rather than written and then
    chmod'ed, so the secrets are never briefly world-readable. ``chmod`` is
    best-effort: on a Windows bind mount the modes are synthetic and the call
    is a no-op, which must not fail provisioning.
    """
    directory.mkdir(parents=True, exist_ok=True)
    _try_chmod(directory, dir_mode)

    env_path = directory / ".env"
    # O_CREAT with an explicit mode closes the window where the file exists
    # with default permissions. An existing file keeps its inode (and mode),
    # so re-provisioning does not loosen a tightened .env.
    fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, env_mode)
    try:
        handle = os.fdopen(fd, "w", encoding="utf-8")
    except Exception:
        # fdopen did not take ownership, so the descriptor is still ours.
        os.close(fd)
        raise
    with handle:
        handle.write(env_text)
    _try_chmod(env_path, env_mode)

    (directory / "config.yaml").write_text(config_text, encoding="utf-8")


def _try_chmod(path: Path, mode: int) -> None:
    """chmod that tolerates filesystems without POSIX permissions."""
    try:
        path.chmod(mode)
    except (OSError, NotImplementedError) as exc:  # pragma: no cover - platform
        logger.debug("chmod %o on %s not applied: %s", mode, path, exc)


@lru_cache
def get_renderer() -> TemplateRenderer:
    return TemplateRenderer(get_settings())
