"""Settings invariants and port allocation.

Every check here guards against a misconfiguration that would otherwise only
reveal itself partway through provisioning, after a container already exists.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from src.config.settings import Settings
from src.proxy.service import NoPortAvailableError, allocate_port_pair


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
