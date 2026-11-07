"""Hub-wide configuration, loaded once from the environment.

Everything the hub needs to provision a client container lives here: database
coordinates, Docker/proxy wiring, the credentials injected downstream into
client containers, and the per-plan resource envelopes.

Two distinctions in this module are load-bearing and easy to get wrong:

1. ``tenant_dir_for`` vs ``tenant_source_for``. The hub runs *inside* a
   container holding the Docker socket, so it creates sibling containers. Bind
   mount sources are resolved by the **daemon**, not by the hub process. A path
   the hub can write is not necessarily a path the daemon can see. File I/O must
   use ``tenant_dir_for``; bind-mount sources must use ``tenant_source_for``.

2. ``probe_mode`` / ``nginx_upstream_mode``. The published tenant ports are bound
   to the host's loopback, which is *not* reachable from inside the hub or nginx
   containers. By default both reach tenants over the shared Docker network by
   container name instead.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

if TYPE_CHECKING:  # avoid a circular import at runtime
    from ..clients.models import Client

# .../backend/src/config/settings.py -> parents[2] == backend/, parents[3] == repo root
BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent

_DEFAULT_ADMIN_API_KEY = "change-me-admin-key"


class PlanResources(BaseModel):
    """Feature envelope for one billing plan.

    Container CPU/memory caps come from the ``client_cpus`` / ``client_memory``
    hard caps rather than from here, so every tenant gets the same security
    envelope regardless of plan. These values stay per-plan because they gate
    *features*, not isolation.
    """

    max_conversations: int = 1_000
    #: Shared skills to sync. Empty means "every skill in shared-skills/".
    skills: list[str] = Field(default_factory=list)
    #: Optional per-plan override of the hard caps. ``None`` keeps the default.
    cpus: float | None = None
    memory: str | None = None


DEFAULT_PLANS: dict[str, PlanResources] = {
    "starter": PlanResources(
        max_conversations=1_000,
        # Weblaud's "Presence" package. Business-mode skills are added on top
        # by clients.skills.skills_for_client.
        skills=[
            "lead-qualification",
            "ai-employee-orchestrator",
            "designer-brand-studio",
            "social-media-autopilot",
            "roi-weekly-reporter",
        ],
    ),
    "growth": PlanResources(max_conversations=10_000),
    "scale": PlanResources(max_conversations=100_000),
}


def _split_csv(value: Any) -> Any:
    """Accept both JSON arrays and plain comma-separated env values.

    A blank value is an error, not an empty list: reading a blank
    ``CLIENT_CAP_DROP`` as "drop nothing" would silently weaken every new tenant.
    An explicit ``[]`` still means empty.
    """
    if not isinstance(value, str):
        return value
    if value.strip().startswith("["):
        return json.loads(value)
    items = [item.strip() for item in value.split(",") if item.strip()]
    if not items:
        raise ValueError("must not be blank; use [] for an explicitly empty list")
    return items


#: A list setting read from the environment. ``NoDecode`` hands the raw string
#: to ``_split_csv``; without it the environment source JSON-decodes first and
#: rejects the comma-separated form before any validator runs.
EnvList = Annotated[list[str], NoDecode]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ------------------------------------------------------------------ hub
    environment: Literal["local", "staging", "production"] = "local"
    debug: bool = True
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"
    admin_api_key: str = _DEFAULT_ADMIN_API_KEY
    hub_public_url: str = "http://localhost:8080"
    cors_origins: EnvList = ["http://localhost:3000"]

    # ------------------------------------------------------------- database
    database_url: str = (
        "postgresql+asyncpg://hermes:hermes@localhost:5432/hermes_hub"
    )
    db_echo: bool = False
    #: Give every client its own database on the hub's Postgres instance.
    provision_client_databases: bool = False
    #: Host/port as seen from *inside* a client container (compose service name).
    client_database_host: str = "postgres"
    client_database_port: int = 5432

    # ----------------------------------------------------- client containers
    client_image: str = "nousresearch/hermes-agent:latest"
    client_image_pull_policy: Literal["always", "missing", "never"] = "missing"
    client_container_prefix: str = "hermes-client"
    client_network: str = "hermes-clients"
    client_restart_policy: str = "unless-stopped"
    client_health_timeout_seconds: int = 180
    #: Override to talk to a remote daemon, e.g. npipe:////./pipe/docker_engine
    docker_host: str | None = None
    plans: dict[str, PlanResources] = Field(default_factory=lambda: dict(DEFAULT_PLANS))

    # --------------------------------------------------- tenant filesystem
    #: Root of everything the hub persists and bind-mounts into tenants, as the
    #: HUB sees it. Bind this into the hub container at the same absolute path.
    data_root: Path = Path("/srv/hermes-multi")
    #: The same tree as the DOCKER DAEMON sees it. ``None`` means "identical",
    #: which is the supported deployment and makes bind sources need no
    #: translation at all. Set this only when the hub cannot see the tree at
    #: the host's own path (see :meth:`to_host`).
    data_root_host: Path | None = None
    #: Derived from ``data_root`` when unset; override individually if needed.
    tenant_root: Path | None = None
    archive_root: Path | None = None
    #: Where the hub publishes a daemon-visible copy of the shared skill
    #: library. The canonical copy (``shared_skills_dir``) is mounted into the
    #: hub at a path the daemon cannot resolve, so it cannot be used as a bind
    #: source directly.
    skills_publish_dir: Path | None = None
    #: Read-only mount point for the shared agency skill library.
    shared_skills_mount: str = "/opt/data/skills/agency_core"
    tenant_dir_mode: int = 0o700
    tenant_env_mode: int = 0o600

    # --------------------------------------- dual ports, loopback publishing
    client_bind_host: str = "127.0.0.1"
    dash_internal_port: int = 9119
    api_internal_port: int = 8642
    dash_health_path: str = "/api/health"
    api_health_path: str = "/health"
    dash_port_range: tuple[int, int] = (19000, 19499)
    api_port_range: tuple[int, int] = (19500, 19999)

    # ------------------------------- how the hub and nginx REACH a tenant
    #: "network" talks to the container by name over ``client_network``;
    #: "loopback" goes via the published host port. Containerized callers must
    #: use "network" — the published ports live on the *host's* loopback.
    probe_mode: Literal["network", "loopback"] = "network"
    nginx_upstream_mode: Literal["network", "loopback"] = "network"
    #: Host alias used when either mode is "loopback" from inside a container.
    loopback_host_alias: str = "host.docker.internal"

    # ------------------------- hard resource + security envelope (per tenant)
    client_cpus: float = 1.0
    client_memory: str = "2g"
    #: NB: tight. s6 supervises gateway + dashboard + logging, and the agent's
    #: browser tool spawns Chromium, which forks generously. Raise if the
    #: browser tool starts failing to launch.
    client_pids_limit: int = 200
    #: The five added capabilities are exactly what the image's s6-overlay init
    #: needs and no more:
    #:   CHOWN + FOWNER  -> chown/chmod of /opt/data and .env (stage2-hook.sh)
    #:   SETUID + SETGID -> `s6-setuidgid hermes` privilege drop per service
    #:   DAC_OVERRIDE    -> usermod/groupmod UID remap
    #: A bare `cap_drop: ALL` leaves the supervision tree unable to start any
    #: service. NET_RAW, NET_ADMIN, SYS_ADMIN, SYS_PTRACE et al stay dropped.
    client_cap_drop: EnvList = ["ALL"]
    client_cap_add: EnvList = [
        "CHOWN",
        "SETUID",
        "SETGID",
        "FOWNER",
        "DAC_OVERRIDE",
    ]
    client_security_opt: EnvList = ["no-new-privileges:true"]
    #: Ownership the image remaps its internal `hermes` user to. Never pass
    #: `--user`; the image rejects an arbitrary UID outright.
    client_uid: int = 10000
    client_gid: int = 10000

    # ---------------------------------------------------------------- proxy
    base_domain: str = "localhost"
    proxy_mode: Literal["nginx", "traefik"] = "nginx"
    #: "docker"    -> exec into the nginx container (default; local and VPS)
    #: "systemctl" -> host-installed nginx; requires the hub to run outside Docker
    #: "none"      -> skip write/test/reload entirely (unit tests, dry runs)
    nginx_control_mode: Literal["docker", "systemctl", "none"] = "docker"
    #: Under the containerized default these are deliberately the SAME
    #: directory, bind-mounted into the nginx container at /etc/nginx/conf.d.
    #: Two directories would mean symlinking from enabled/ to available/, and
    #: only the enabled directory is mounted — so the link target would not
    #: exist inside the nginx container and every site would be a dead link.
    #: The classic Debian two-directory layout applies to a host nginx:
    #:   nginx_sites_available=/etc/nginx/sites-available
    #:   nginx_sites_enabled=/etc/nginx/sites-enabled
    #:   nginx_site_suffix=""
    nginx_sites_available: Path | None = None
    nginx_sites_enabled: Path | None = None
    #: ".conf" matches nginx:alpine's `include /etc/nginx/conf.d/*.conf`.
    #: Set to "" for a Debian host nginx reading sites-enabled/.
    nginx_site_suffix: str = ".conf"
    nginx_container_name: str = "hermes-nginx"
    nginx_test_command: EnvList = ["nginx", "-t"]
    nginx_reload_command: EnvList = ["nginx", "-s", "reload"]
    #: Traefik is retained but off by default; nginx is the spec'd backend.
    traefik_network: str = "hermes-edge"
    traefik_entrypoint: str = "websecure"
    traefik_cert_resolver: str = "letsencrypt"

    # --------------------------------------------------- templates & skills
    templates_dir: Path = BACKEND_ROOT / "templates"
    shared_skills_dir: Path = REPO_ROOT / "shared-skills"

    # ------------------------- defaults injected into client containers
    client_model: str = "claude-opus-5"
    client_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"

    # -------------------------------------------------------------- billing
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""
    #: Stripe price id -> plan name, e.g. {"price_123": "growth"}
    stripe_price_to_plan: dict[str, str] = Field(default_factory=dict)

    # -------------------------------------------------------- client portal
    #: Where the frontend serves /portal/<slug>, for the access links it issues.
    portal_public_url: str = "http://localhost:3000"
    portal_token_ttl_days: int = 90
    #: How long one autonomous action would take a person, for "time saved".
    #: An estimate by definition, and labelled as one in the portal.
    portal_minutes_per_task: float = 2.7
    #: An agent turn can run tools for a while before it answers.
    portal_chat_timeout_seconds: float = 120.0
    #: The agent's WhatsApp pairing process, as paths inside a tenant container.
    whatsapp_bridge_script: str = "/opt/hermes/scripts/whatsapp-bridge/bridge.js"
    whatsapp_session_path: str = "/opt/data/platforms/whatsapp/session"

    # --------------------------------------------------------- user sessions
    #: Signs session JWTs. Blank derives a key from ``admin_api_key``, so an
    #: existing .env keeps working; set it to rotate sessions independently.
    jwt_secret: str = ""
    access_token_ttl_minutes: int = 30
    refresh_token_ttl_days: int = 14
    #: Password for the accounts seeded into an empty users table. Blank
    #: generates one per account and logs it once, on a local install only.
    auth_seed_password: str = ""
    #: Also seed the demo owner and its tenant. ``None`` means local installs only.
    auth_seed_demo: bool | None = None
    otp_ttl_minutes: int = 10
    otp_max_attempts: int = 5
    #: No WhatsApp or email provider is wired up yet, so an OTP cannot truly be
    #: delivered. ``None`` simulates on a local install and refuses elsewhere:
    #: simulation returns the code to the caller, which outside a developer's
    #: machine would let anyone sign in as anyone.
    otp_simulate: bool | None = None
    #: The code a simulated delivery hands back. Only ever used while ``otp_simulated``.
    otp_demo_code: str = "246810"

    # ---------------------------------------------------- social autopilot
    #: Where generated post visuals are written. ``None`` means ``<data_root>/social-media``.
    social_media_dir: Path | None = None
    social_script_timeout_seconds: float = 90.0
    #: Meta credentials for the ONE tenant named in ``meta_live_tenant``. Blank means
    #: every tenant publishes to the sandbox, which records what would have been posted.
    #: Per-tenant credentials are not wired yet, so no other tenant may use these.
    meta_page_access_token: str = ""
    meta_page_id: str = ""
    meta_ig_user_id: str = ""
    meta_live_tenant: str = ""
    #: Public https base the visuals are served from, which Meta must be able to fetch.
    social_public_base_url: str = ""
    #: Optional. With it the visual generator asks an image model for the backdrop.
    openai_api_key: str = ""

    # ------------------------------------------------------------ messaging
    messaging_webhook_secret: str = ""
    meta_verify_token: str = ""
    twilio_auth_token: str = ""
    message_forward_timeout_seconds: float = 15.0

    _split_lists = field_validator(
        "cors_origins",
        "client_cap_drop",
        "client_cap_add",
        "client_security_opt",
        "nginx_test_command",
        "nginx_reload_command",
        mode="before",
    )(_split_csv)

    # --------------------------------------------------------- consistency
    @model_validator(mode="after")
    def _derive_paths(self) -> "Settings":
        """Fill the data_root-relative paths that were left unset.

        Keeping these as overridable fields rather than plain properties means
        an operator can relocate any single one via the environment, while the
        common case only needs ``data_root``.
        """
        if self.tenant_root is None:
            self.tenant_root = self.data_root / "tenants"
        if self.archive_root is None:
            self.archive_root = self.data_root / "archive"
        if self.skills_publish_dir is None:
            self.skills_publish_dir = self.data_root / "shared-skills"
        if self.social_media_dir is None:
            self.social_media_dir = self.data_root / "social-media"
        if self.nginx_sites_available is None:
            self.nginx_sites_available = self.data_root / "nginx" / "conf.d"
        if self.nginx_sites_enabled is None:
            self.nginx_sites_enabled = self.nginx_sites_available
        return self

    @model_validator(mode="after")
    def _check_coherent(self) -> "Settings":
        """Reject configurations that would fail only at provisioning time."""
        dash_lo, dash_hi = self.dash_port_range
        api_lo, api_hi = self.api_port_range
        if dash_lo > dash_hi or api_lo > api_hi:
            raise ValueError("Port range bounds are inverted (start > end).")
        if dash_lo <= api_hi and api_lo <= dash_hi:
            raise ValueError(
                f"dash_port_range {self.dash_port_range} overlaps "
                f"api_port_range {self.api_port_range}; a tenant would be "
                "handed the same port twice."
            )
        # A host-installed nginx resolves names via the host's resolver, which
        # knows nothing about Docker's embedded DNS, so container names are
        # unreachable. It must proxy to the published loopback ports instead.
        if self.nginx_control_mode == "systemctl" and self.nginx_upstream_mode != "loopback":
            raise ValueError(
                "nginx_control_mode='systemctl' requires "
                "nginx_upstream_mode='loopback': a host nginx cannot resolve "
                "Docker container names."
            )
        if self.environment != "local":
            # Each of these would be a sign-in bypass on a reachable deployment.
            if self.otp_simulate:
                raise ValueError(
                    "otp_simulate returns login codes to the caller and is only "
                    "allowed when environment='local'."
                )
            if not self.jwt_secret and self.admin_api_key == _DEFAULT_ADMIN_API_KEY:
                raise ValueError(
                    "Set ADMIN_API_KEY or JWT_SECRET: session tokens would "
                    "otherwise be signed with a key published in the source."
                )
        return self

    # ------------------------------------------------------------- sessions
    @property
    def session_signing_key(self) -> str:
        """The HS256 key for session JWTs, domain-separated from the admin key."""
        if self.jwt_secret:
            return self.jwt_secret
        return hmac.new(
            self.admin_api_key.encode("utf-8"), b"weblaud-session-v1", hashlib.sha256
        ).hexdigest()

    @property
    def otp_simulated(self) -> bool:
        return self.environment == "local" if self.otp_simulate is None else self.otp_simulate

    @property
    def seed_demo(self) -> bool:
        return self.environment == "local" if self.auth_seed_demo is None else self.auth_seed_demo

    @property
    def secure_cookies(self) -> bool:
        """Local stacks run on plain http, where a Secure cookie is never sent back."""
        return self.environment != "local"

    # ------------------------------------------------------------- helpers
    def plan_for(self, plan: str) -> PlanResources:
        """Feature envelope for ``plan``, falling back to a safe default."""
        return self.plans.get(plan) or PlanResources()

    def cpus_for(self, plan: str) -> float:
        """Effective CPU cap: the plan override if set, else the hard cap."""
        return self.plan_for(plan).cpus or self.client_cpus

    def memory_for(self, plan: str) -> str:
        """Effective memory cap: the plan override if set, else the hard cap."""
        return self.plan_for(plan).memory or self.client_memory

    def subdomain_for(self, slug: str) -> str:
        return f"{slug}.{self.base_domain}"

    def container_name_for(self, slug: str) -> str:
        return f"{self.client_container_prefix}-{slug}"

    def client_database_name(self, slug: str) -> str:
        return f"hermes_client_{slug.replace('-', '_')}"

    def client_url_for(self, slug: str) -> str:
        scheme = "http" if self.base_domain in {"localhost", "127.0.0.1"} else "https"
        return f"{scheme}://{self.subdomain_for(slug)}"

    # -- tenant paths: read the module docstring before touching these ----
    def to_host(self, path: Path) -> Path:
        """Translate a hub-visible path into the path the DAEMON resolves.

        Use **only** for bind-mount sources. With ``data_root_host`` unset this
        is the identity, which is the supported deployment: ``data_root`` bound
        into the hub at the same absolute path, so both views already agree.

        A path outside ``data_root`` is returned unchanged — it cannot be
        translated, and silently rewriting it would be worse than letting the
        daemon report that it does not exist.
        """
        if self.data_root_host is None:
            return path
        try:
            relative = path.relative_to(self.data_root)
        except ValueError:
            return path
        return self.data_root_host / relative

    def tenant_dir_for(self, subdomain: str) -> Path:
        """Tenant directory as the HUB sees it. Use for all file I/O."""
        assert self.tenant_root is not None  # set by _derive_paths
        return self.tenant_root / subdomain

    def tenant_source_for(self, subdomain: str) -> Path:
        """Tenant directory as the DOCKER DAEMON sees it (bind source only)."""
        return self.to_host(self.tenant_dir_for(subdomain))

    def skills_source(self) -> Path:
        """Shared skill library as the DAEMON sees it (bind source only)."""
        assert self.skills_publish_dir is not None  # set by _derive_paths
        return self.to_host(self.skills_publish_dir)

    def archive_dir_for(self, subdomain: str, stamp: str) -> Path:
        assert self.archive_root is not None  # set by _derive_paths
        return self.archive_root / f"{subdomain}-{stamp}"

    # -- reaching a tenant ------------------------------------------------
    def upstream_for(self, client: "Client") -> tuple[str, int, int]:
        """``(host, dashboard_port, api_port)`` for reaching ``client``.

        Under ``network`` mode the container name resolves over the shared
        Docker network and the *internal* ports apply. Under ``loopback`` mode
        the published host ports apply instead.
        """
        if self.nginx_upstream_mode == "network":
            return (
                client.container_name or self.container_name_for(client.slug),
                self.dash_internal_port,
                self.api_internal_port,
            )
        return (
            self.loopback_host_alias,
            client.container_port_dash or 0,
            client.container_port_api or 0,
        )

    def probe_targets_for(self, client: "Client") -> tuple[str, int, int]:
        """``(host, dashboard_port, api_port)`` for health probing ``client``."""
        if self.probe_mode == "network":
            return (
                client.container_name or self.container_name_for(client.slug),
                self.dash_internal_port,
                self.api_internal_port,
            )
        return (
            self.loopback_host_alias,
            client.container_port_dash or 0,
            client.container_port_api or 0,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
