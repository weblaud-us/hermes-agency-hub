"""What the hub writes into a tenant directory.

The assertions that matter most are negative: the plaintext dashboard password
and the OpenRouter key must not appear anywhere they are not supposed to.
"""

from __future__ import annotations

import re
import stat
import sys

import pytest

from src.orchestrator.credentials import generate_tenant_credentials
from src.orchestrator.templates import (
    TemplateRenderer,
    docker_environment,
    parse_env,
)


@pytest.fixture
def renderer(settings) -> TemplateRenderer:
    return TemplateRenderer(settings)


@pytest.fixture
def credentials():
    return generate_tenant_credentials("acme.localhost")


class TestEnvTemplate:
    def test_carries_the_flags_the_image_needs(self, renderer, client, credentials):
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials,
                                     openrouter_api_key="sk-or-secret"),
            )
        )
        # Without this the dashboard service exits immediately at boot.
        assert env["HERMES_DASHBOARD"] == "1"
        # Without this a fresh volume boots with the GATEWAY DOWN — the single
        # most consequential flag for an orchestrator.
        assert env["HERMES_GATEWAY_BOOTSTRAP_STATE"] == "running"
        # Non-loopback binds so the published port and proxy can reach them.
        assert env["HERMES_DASHBOARD_HOST"] == "0.0.0.0"
        assert env["API_SERVER_HOST"] == "0.0.0.0"
        assert env["HERMES_DASHBOARD_PORT"] == "9119"
        assert env["API_SERVER_PORT"] == "8642"

    def test_carries_credentials_as_hash_never_plaintext(
        self, renderer, client, credentials
    ):
        text = renderer.render(
            "client-env.template",
            renderer.context_for(client, credentials=credentials,
                                 openrouter_api_key="sk-or-secret"),
        )
        env = parse_env(text)
        assert env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"] == (
            credentials.dashboard_password_hash
        )
        assert env["HERMES_DASHBOARD_BASIC_AUTH_SECRET"] == credentials.dashboard_secret
        assert env["API_SERVER_KEY"] == credentials.api_key
        # The plaintext password must never reach disk.
        assert credentials.dashboard_password not in text
        assert "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" not in env

    def test_api_key_clears_the_16_char_floor(self, renderer, client, credentials):
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials),
            )
        )
        assert len(env["API_SERVER_KEY"]) >= 16

    def test_falls_back_to_stored_credentials_without_a_fresh_set(
        self, renderer, client
    ):
        # Re-rendering outside provisioning must work from what is stored,
        # which is why rebuilding a tenant's files never needs the plaintext.
        env = parse_env(
            renderer.render(
                "client-env.template", renderer.context_for(client)
            )
        )
        assert env["API_SERVER_KEY"] == client.api_key
        assert env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"] == (
            client.dashboard_password_hash
        )


class TestDockerEnvironment:
    def test_excludes_every_secret(self, renderer, client, credentials):
        text = renderer.render(
            "client-env.template",
            renderer.context_for(client, credentials=credentials,
                                 openrouter_api_key="sk-or-secret"),
        )
        docker_env = docker_environment(text)
        blob = repr(docker_env)
        for secret in (
            credentials.api_key,
            credentials.dashboard_secret,
            credentials.dashboard_password_hash,
            "sk-or-secret",
        ):
            assert secret not in blob
        # Keeping secrets out of the container env also keeps them out of
        # `docker inspect`, which is readable by anyone with socket access.
        assert "API_SERVER_KEY" not in docker_env
        assert "OPENROUTER_API_KEY" not in docker_env

    def test_keeps_the_uid_remap_vars(self, renderer, client, credentials):
        # These are read by s6's stage2 hook from the *process* environment,
        # before the application ever loads the .env file.
        docker_env = docker_environment(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials),
            )
        )
        assert docker_env["HERMES_UID"] == "10000"
        assert docker_env["HERMES_GID"] == "10000"
        assert docker_env["HERMES_HOME"] == "/opt/data"


class TestNginxTemplate:
    def test_has_websocket_upgrade_headers(self, renderer, client):
        conf = renderer.render_nginx(client)
        # Whitespace-tolerant: the template column-aligns its header values,
        # and that alignment is cosmetic, not contractual.
        assert re.search(r"proxy_set_header\s+Upgrade\s+\$http_upgrade\s*;", conf)
        assert re.search(
            r"proxy_set_header\s+Connection\s+\$connection_upgrade\s*;", conf
        )
        assert "proxy_http_version 1.1" in conf

    def test_routes_both_services(self, renderer, client):
        conf = renderer.render_nginx(client)
        assert f"server_name {client.subdomain};" in conf
        assert "location /v1/" in conf
        assert re.search(r"location\s+/\s*\{", conf)

    def test_network_mode_targets_the_container_name(self, renderer, client):
        # Default mode: nginx is a container and must use Docker DNS, not the
        # host loopback ports.
        conf = renderer.render_nginx(client)
        assert re.search(rf"set \$hermes_dash\s+{client.container_name}:9119;", conf)
        assert re.search(rf"set \$hermes_api\s+{client.container_name}:8642;", conf)

    def test_loopback_mode_targets_published_ports(self, settings, client):
        settings.nginx_upstream_mode = "loopback"
        conf = TemplateRenderer(settings).render_nginx(client)
        assert f":{client.container_port_dash};" in conf
        assert f":{client.container_port_api};" in conf

    def test_shared_config_defines_the_upgrade_map(self, renderer):
        # The per-tenant sites reference $connection_upgrade; it is only legal
        # to define it at http level, which this file provides.
        shared = renderer.render_nginx_shared()
        assert "map $http_upgrade $connection_upgrade" in shared
        assert "default_server" in shared


class TestWriteClientFiles:
    @pytest.mark.asyncio
    async def test_writes_both_files_into_the_tenant_dir(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(
            client, credentials=credentials, openrouter_api_key="sk-or-secret"
        )
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert (tenant_dir / ".env").is_file()
        assert (tenant_dir / "config.yaml").is_file()

    @pytest.mark.asyncio
    async def test_openrouter_key_lands_only_in_the_env_file(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(
            client, credentials=credentials, openrouter_api_key="sk-or-secret"
        )
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert "sk-or-secret" in (tenant_dir / ".env").read_text()
        assert "sk-or-secret" not in (tenant_dir / "config.yaml").read_text()

    @pytest.mark.asyncio
    @pytest.mark.skipif(sys.platform == "win32", reason="NTFS modes are synthetic")
    async def test_env_file_is_owner_only(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(client, credentials=credentials)
        env_path = settings.tenant_dir_for(client.subdomain) / ".env"
        assert stat.S_IMODE(env_path.stat().st_mode) == 0o600

    @pytest.mark.asyncio
    async def test_rewriting_is_idempotent(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(client, credentials=credentials)
        first = (settings.tenant_dir_for(client.subdomain) / ".env").read_text()
        await renderer.write_client_files(client, credentials=credentials)
        second = (settings.tenant_dir_for(client.subdomain) / ".env").read_text()
        assert first == second


class TestParseEnv:
    def test_skips_comments_and_blanks(self):
        assert parse_env("# c\n\nA=1\n  \nB=2\n") == {"A": "1", "B": "2"}

    def test_strips_matched_quotes(self):
        assert parse_env('A="x"\nB=\'y\'\nC=z"') == {"A": "x", "B": "y", "C": 'z"'}

    def test_keeps_equals_in_values(self):
        # base64 secrets routinely end in '='; splitting on every '=' would
        # silently truncate them.
        assert parse_env("K=abc=def==")["K"] == "abc=def=="
