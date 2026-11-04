"""Settings invariants and port allocation.

Every check here guards against a misconfiguration that would otherwise only
reveal itself partway through provisioning, after a container already exists.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from src.config.settings import REPO_ROOT, Settings
from src.proxy.service import NoPortAvailableError, allocate_port_pair


class TestComposeFile:
    def test_the_hub_can_see_the_skill_library(self):
        # The library is outside the image's build context, so without this
        # mount every tenant silently gets no skills.
        compose = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
        hub = compose["services"]["hub"]
        target = hub["environment"]["SHARED_SKILLS_DIR"]
        assert f"./shared-skills:{target}:ro" in hub["volumes"]
        assert (REPO_ROOT / "shared-skills").is_dir()

    def test_the_website_can_reach_the_hub_from_its_container(self):
        # Inside the container localhost is the website itself, and a portal that
        # cannot reach the hub only shows up as "unavailable" in the browser.
        compose = yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
        web = compose["services"]["web"]
        hub = compose["services"]["hub"]
        assert web["environment"]["PORTAL_HUB_URL"] == "http://hub:8080"
        assert set(web["networks"]) & set(hub["networks"])


class TestDerivedPaths:
    def test_paths_hang_off_data_root(self, tmp_path: Path):
        s = Settings(data_root=tmp_path / "hermes")
        assert s.tenant_root == tmp_path / "hermes" / "tenants"
        assert s.archive_root == tmp_path / "hermes" / "archive"
        assert s.skills_publish_dir == tmp_path / "hermes" / "shared-skills"
        assert s.nginx_sites_available == tmp_path / "hermes" / "nginx" / "conf.d"

    def test_sites_enabled_defaults_to_the_same_dir(self, tmp_path: Path):
        # Two directories would mean symlinking into a path the nginx
        # container cannot resolve, since only the enabled dir is mounted.
        s = Settings(data_root=tmp_path)
        assert s.nginx_sites_enabled == s.nginx_sites_available

    def test_explicit_override_wins(self, tmp_path: Path):
        s = Settings(data_root=tmp_path, tenant_root=tmp_path / "elsewhere")
        assert s.tenant_root == tmp_path / "elsewhere"


class TestHostTranslation:
    def test_identity_when_unset(self, tmp_path: Path):
        s = Settings(data_root=tmp_path)
        assert s.tenant_source_for("a.localhost") == s.tenant_dir_for("a.localhost")

    def test_rewrites_under_data_root(self, tmp_path: Path):
        s = Settings(data_root=Path("/srv/hermes"), data_root_host=Path("/host/hermes"))
        assert s.tenant_source_for("a.io") == Path("/host/hermes/tenants/a.io")

    def test_leaves_outside_paths_alone(self, tmp_path: Path):
        # Rewriting a path we cannot reason about would be worse than letting
        # the daemon report that it does not exist.
        s = Settings(data_root=Path("/srv/hermes"), data_root_host=Path("/host/hermes"))
        assert s.to_host(Path("/etc/nginx")) == Path("/etc/nginx")


class TestCoherenceChecks:
    def test_overlapping_port_ranges_are_rejected(self, tmp_path: Path):
        # Overlap would eventually hand one tenant the same port twice.
        with pytest.raises(ValidationError, match="overlaps"):
            Settings(
                data_root=tmp_path,
                dash_port_range=(19000, 19500),
                api_port_range=(19400, 19999),
            )

    def test_inverted_range_is_rejected(self, tmp_path: Path):
        with pytest.raises(ValidationError, match="inverted"):
            Settings(data_root=tmp_path, dash_port_range=(19500, 19000))

    def test_host_nginx_requires_loopback_upstream(self, tmp_path: Path):
        # A host nginx resolves names via the host resolver, which knows
        # nothing about Docker's embedded DNS.
        with pytest.raises(ValidationError, match="loopback"):
            Settings(
                data_root=tmp_path,
                nginx_control_mode="systemctl",
                nginx_upstream_mode="network",
            )

    def test_host_nginx_with_loopback_is_accepted(self, tmp_path: Path):
        s = Settings(
            data_root=tmp_path,
            nginx_control_mode="systemctl",
            nginx_upstream_mode="loopback",
        )
        assert s.nginx_control_mode == "systemctl"


class TestUpstreamResolution:
    def test_network_mode_uses_container_name_and_internal_ports(
        self, settings, client
    ):
        host, dash, api = settings.upstream_for(client)
        assert (host, dash, api) == (client.container_name, 9119, 8642)

    def test_loopback_mode_uses_the_published_ports(self, settings, client):
        settings.nginx_upstream_mode = "loopback"
        host, dash, api = settings.upstream_for(client)
        assert host == settings.loopback_host_alias
        assert (dash, api) == (
            client.container_port_dash,
            client.container_port_api,
        )


class TestPortAllocation:
    def test_picks_the_lowest_free_pair(self, settings):
        assert allocate_port_pair(settings, used=set()) == (19000, 19500)

    def test_skips_ports_in_use(self, settings):
        dash, api = allocate_port_pair(settings, used={19000, 19001, 19500})
        assert (dash, api) == (19002, 19501)

    def test_exclude_lets_a_retry_make_progress(self, settings):
        # Without exclude, a retry after a collision would re-pick the pair
        # that just lost and loop until it ran out of attempts.
        first = allocate_port_pair(settings, used=set())
        second = allocate_port_pair(settings, used=set(), exclude=set(first))
        assert second != first
        assert second == (19001, 19501)

    def test_exhaustion_raises_with_a_useful_message(self, settings):
        settings.dash_port_range = (19000, 19001)
        with pytest.raises(NoPortAvailableError, match="dashboard"):
            allocate_port_pair(settings, used={19000, 19001})

    def test_api_exhaustion_is_reported_separately(self, settings):
        settings.api_port_range = (19500, 19500)
        with pytest.raises(NoPortAvailableError, match="api"):
            allocate_port_pair(settings, used={19500})


class TestResourceEnvelope:
    def test_hard_caps_match_the_spec(self, settings):
        assert settings.client_cpus == 1.0
        assert settings.client_memory == "2g"
        assert settings.client_pids_limit == 200

    def test_capability_set_is_drop_all_plus_the_five_s6_needs(self, settings):
        # Fewer than these five and the image's s6 init cannot chown the data
        # volume or drop privileges, so no supervised service ever starts.
        assert settings.client_cap_drop == ["ALL"]
        assert set(settings.client_cap_add) == {
            "CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE",
        }
        assert settings.client_security_opt == ["no-new-privileges:true"]

    def test_plan_overrides_fall_back_to_the_hard_caps(self, settings):
        assert settings.cpus_for("starter") == settings.client_cpus
        assert settings.memory_for("starter") == settings.client_memory


LIST_SETTINGS = [
    "CORS_ORIGINS",
    "CLIENT_CAP_DROP",
    "CLIENT_CAP_ADD",
    "CLIENT_SECURITY_OPT",
    "NGINX_TEST_COMMAND",
    "NGINX_RELOAD_COMMAND",
]


class TestListSettingsFromTheEnvironment:
    """These must go through the environment, not constructor arguments.

    The environment source decodes values before any validator runs, so a
    constructor-based test passes while a real deployment fails at startup.
    """

    def test_a_bare_origin_is_accepted(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", "https://console.example.com")
        assert Settings(_env_file=None).cors_origins == ["https://console.example.com"]

    @pytest.mark.parametrize("name", LIST_SETTINGS)
    def test_comma_separated_values_are_split_and_trimmed(self, monkeypatch, name):
        monkeypatch.setenv(name, "one, two")
        assert getattr(Settings(_env_file=None), name.lower()) == ["one", "two"]

    @pytest.mark.parametrize("name", LIST_SETTINGS)
    def test_a_json_array_is_still_accepted(self, monkeypatch, name):
        # .env.example documents this form for the nginx commands.
        monkeypatch.setenv(name, '["one", "two"]')
        assert getattr(Settings(_env_file=None), name.lower()) == ["one", "two"]

    def test_a_dotenv_file_takes_the_same_path(self, tmp_path: Path):
        env_file = tmp_path / ".env"
        env_file.write_text("CORS_ORIGINS=https://a.example.com,https://b.example.com\n")
        assert Settings(_env_file=env_file).cors_origins == [
            "https://a.example.com",
            "https://b.example.com",
        ]

    @pytest.mark.parametrize("name", LIST_SETTINGS)
    @pytest.mark.parametrize("blank", ["", "   ", " , "])
    def test_a_blank_value_is_rejected(self, monkeypatch, name, blank):
        # Reading a blank CLIENT_CAP_DROP as an empty list would start tenants
        # with Docker's default capabilities instead of failing at startup.
        monkeypatch.setenv(name, blank)
        with pytest.raises(ValidationError, match="blank"):
            Settings(_env_file=None)

    def test_an_explicit_empty_array_is_allowed(self, monkeypatch):
        # Unlike a blank value, this can only be deliberate.
        monkeypatch.setenv("CORS_ORIGINS", "[]")
        assert Settings(_env_file=None).cors_origins == []

    def test_malformed_json_is_rejected(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", '["https://a.example.com"')
        with pytest.raises(ValidationError):
            Settings(_env_file=None)

    def test_unset_values_keep_the_hardened_defaults(self):
        s = Settings(_env_file=None)
        assert s.client_cap_drop == ["ALL"]
        assert s.client_security_opt == ["no-new-privileges:true"]
