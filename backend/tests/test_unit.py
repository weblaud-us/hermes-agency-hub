"""Unit tests: generated artefacts, file modes, naming and port allocation.

Everything here is a pure function or a single file write into ``tmp_path``.
No database, no Docker, no network.

The assertions that matter most are negative. A tenant's ``.env`` holds a
provider key the hub deliberately does not store anywhere else; a leak into
``config.yaml``, into the container environment or into a world-readable file
is not a cosmetic bug, and none of those would be visible from the outside.
"""

from __future__ import annotations

import os
import re
import stat
import sys

import pytest
from jinja2 import UndefinedError
from pydantic import ValidationError

from conftest import BACKEND_ROOT, assert_no_secrets
from src.clients.schemas import SUBDOMAIN_PATTERN, ClientCreate, OnboardRequest
from src.clients.service import RESERVED_SLUGS, ClientConflictError, derive_slug
from src.config.settings import Settings
from src.orchestrator import templates as templates_module
from src.orchestrator.credentials import (
    API_KEY_MIN_LENGTH,
    generate_api_key,
    generate_tenant_credentials,
    verify_dashboard_password,
)
from src.orchestrator.templates import (
    DOCKER_ENV_KEYS,
    TemplateRenderer,
    docker_environment,
    parse_env,
)
from src.proxy.service import NoPortAvailableError, allocate_port_pair

OPENROUTER_KEY = "sk-or-v1-tenant-provider-secret"


# ======================================================================
# 1. .env generation — variable injection
# ======================================================================
class TestEnvFileGeneration:
    def test_every_placeholder_is_substituted(self, renderer, client, credentials):
        text = renderer.render(
            "client-env.template",
            renderer.context_for(
                client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
            ),
        )
        # A surviving delimiter means a context key was spelled differently in
        # the template than in context_for(), which would ship a literal
        # "{{ api_key }}" into a tenant's configuration.
        assert "{{" not in text and "}}" not in text
        assert "{%" not in text

    def test_injects_identity_and_runtime_variables(
        self, renderer, client, credentials
    ):
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials),
            )
        )
        assert env["HERMES_HOME"] == "/opt/data"
        assert env["HERMES_UID"] == "10000"
        assert env["HERMES_GID"] == "10000"
        assert env["AGENCY_CLIENT_SLUG"] == client.slug
        assert env["AGENCY_CLIENT_PLAN"] == client.plan.value
        assert env["AGENCY_ENVIRONMENT"] == "local"
        assert env["HERMES_PUBLIC_URL"] == "http://acme.localhost"

    def test_injects_the_flags_the_image_needs_to_boot_both_services(
        self, renderer, client, credentials
    ):
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials),
            )
        )
        # Without this the dashboard service exits immediately at boot.
        assert env["HERMES_DASHBOARD"] == "1"
        # Without this a fresh volume boots with the GATEWAY DOWN — the single
        # most consequential flag for an orchestrator.
        assert env["HERMES_GATEWAY_BOOTSTRAP_STATE"] == "running"
        # Non-loopback binds so the published port and the proxy can reach them.
        assert env["HERMES_DASHBOARD_HOST"] == "0.0.0.0"
        assert env["API_SERVER_HOST"] == "0.0.0.0"
        assert env["HERMES_DASHBOARD_PORT"] == "9119"
        assert env["API_SERVER_PORT"] == "8642"

    def test_injects_the_fresh_credential_set(self, renderer, client, credentials):
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(
                    client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
                ),
            )
        )
        assert env["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"] == "admin"
        assert env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"] == (
            credentials.dashboard_password_hash
        )
        assert env["HERMES_DASHBOARD_BASIC_AUTH_SECRET"] == credentials.dashboard_secret
        assert env["API_SERVER_KEY"] == credentials.api_key
        assert env["OPENROUTER_API_KEY"] == OPENROUTER_KEY

    def test_never_writes_the_plaintext_password(self, renderer, client, credentials):
        text = renderer.render(
            "client-env.template",
            renderer.context_for(client, credentials=credentials),
        )
        assert_no_secrets(text, credentials.dashboard_password)
        # Only the _HASH variant is ever set, not a plaintext key beside it.
        assert "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=" not in text

    def test_falls_back_to_stored_credentials_without_a_fresh_set(
        self, renderer, client
    ):
        # Re-rendering outside provisioning must work from what is stored,
        # which is why rebuilding a tenant's files never needs the plaintext.
        env = parse_env(
            renderer.render("client-env.template", renderer.context_for(client))
        )
        assert env["API_SERVER_KEY"] == client.api_key
        assert env["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH"] == (
            client.dashboard_password_hash
        )

    def test_api_key_clears_the_agents_16_character_floor(
        self, renderer, client, credentials
    ):
        # Below this the gateway silently leaves its API server down, which
        # surfaces much later as an unexplained health-probe failure.
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=credentials),
            )
        )
        assert len(env["API_SERVER_KEY"]) >= API_KEY_MIN_LENGTH

    def test_a_missing_context_key_fails_loudly(self, renderer, client, credentials):
        # StrictUndefined is the whole point: a silently-empty credential would
        # produce a tenant nobody can log into, discovered days later.
        context = renderer.context_for(client, credentials=credentials)
        del context["api_key"]
        with pytest.raises(UndefinedError):
            renderer.render("client-env.template", context)

    def test_values_survive_a_parse_round_trip(self, renderer, client):
        # base64 secrets routinely contain '=' and '+'; a naive consumer that
        # splits on every '=' would truncate them.
        creds = generate_tenant_credentials("acme.localhost")
        env = parse_env(
            renderer.render(
                "client-env.template",
                renderer.context_for(client, credentials=creds),
            )
        )
        assert env["HERMES_DASHBOARD_BASIC_AUTH_SECRET"] == creds.dashboard_secret


# ======================================================================
# 2. config.yaml generation
# ======================================================================
class TestConfigFileGeneration:
    def test_injects_the_dashboard_auth_block(self, renderer, client, credentials):
        text = renderer.render(
            "client-config.yaml",
            renderer.context_for(client, credentials=credentials),
        )
        assert f'username: "{credentials.dashboard_username}"' in text
        assert f'password_hash: "{credentials.dashboard_password_hash}"' in text
        assert f'secret: "{credentials.dashboard_secret}"' in text
        assert f"session_ttl_seconds: {templates_module.DEFAULT_DASHBOARD_TTL_SECONDS}" in text

    def test_is_valid_yaml(self, renderer, client, credentials):
        # The generated hash is base64 and can contain '+', '/' and '='. If the
        # template ever drops the quotes around it the file still *looks* fine
        # but the agent fails to parse its own config at boot.
        yaml = pytest.importorskip("yaml", reason="PyYAML not installed")
        document = yaml.safe_load(
            renderer.render(
                "client-config.yaml",
                renderer.context_for(client, credentials=credentials),
            )
        )
        auth = document["dashboard"]["basic_auth"]
        assert auth["password_hash"] == credentials.dashboard_password_hash
        assert auth["secret"] == credentials.dashboard_secret
        assert isinstance(auth["session_ttl_seconds"], int)

    def test_the_provider_key_never_reaches_the_config_file(
        self, renderer, client, credentials
    ):
        # The .env is the one channel for it, at mode 0600.
        text = renderer.render(
            "client-config.yaml",
            renderer.context_for(
                client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
            ),
        )
        assert_no_secrets(text, OPENROUTER_KEY, credentials.dashboard_password)

    def test_omits_a_config_version_stamp(self, renderer, client, credentials):
        # An unstamped config is what makes the image's boot-time migrator
        # treat the file as seeded and migrate it forward across upgrades.
        # Only directives count — the template explains the omission in a
        # comment, which must not be mistaken for the stamp itself.
        directives = [
            line
            for line in renderer.render(
                "client-config.yaml",
                renderer.context_for(client, credentials=credentials),
            ).splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        assert not any("_config_version" in line for line in directives)


# ======================================================================
# 3. the Docker environment subset
# ======================================================================
class TestDockerEnvironmentSubset:
    def test_is_exactly_the_declared_non_secret_keys(
        self, renderer, client, credentials
    ):
        env = docker_environment(
            renderer.render(
                "client-env.template",
                renderer.context_for(
                    client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
                ),
            )
        )
        assert set(env) <= DOCKER_ENV_KEYS
        # The UID remap vars are read by s6's stage2 hook from the *process*
        # environment, before the application ever loads the .env file.
        assert env["HERMES_UID"] == "10000"
        assert env["HERMES_GID"] == "10000"
        assert env["HERMES_HOME"] == "/opt/data"

    def test_excludes_every_secret(self, renderer, client, credentials):
        env = docker_environment(
            renderer.render(
                "client-env.template",
                renderer.context_for(
                    client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
                ),
            )
        )
        # Keeping secrets out of the container env also keeps them out of
        # `docker inspect`, readable by anyone with socket access.
        assert_no_secrets(
            env,
            credentials.api_key,
            credentials.dashboard_secret,
            credentials.dashboard_password_hash,
            OPENROUTER_KEY,
        )
        assert "API_SERVER_KEY" not in env
        assert "OPENROUTER_API_KEY" not in env


class TestParseEnv:
    def test_skips_comments_and_blanks(self):
        assert parse_env("# c\n\nA=1\n  \nB=2\n") == {"A": "1", "B": "2"}

    def test_strips_matched_quotes_only(self):
        assert parse_env('A="x"\nB=\'y\'\nC=z"') == {"A": "x", "B": "y", "C": 'z"'}

    def test_keeps_equals_signs_inside_values(self):
        assert parse_env("K=abc=def==")["K"] == "abc=def=="

    def test_ignores_lines_without_an_assignment(self):
        assert parse_env("junk\nA=1\n") == {"A": "1"}


# ======================================================================
# 4. file permissions
# ======================================================================
class TestTenantFilePermissions:
    async def test_env_is_created_with_an_owner_only_mode(
        self, renderer, settings, client, credentials, monkeypatch
    ):
        """The mode must be supplied to ``open``, not applied afterwards.

        Creating the file and *then* chmod'ing it leaves a window in which a
        tenant's provider key is world-readable. The window is short, but it is
        the kind of thing that only ever fails in production. Asserting on the
        syscall rather than on ``stat`` makes this checkable on Windows too,
        where the resulting mode bits are synthetic.
        """
        observed: list[tuple[str, int, int]] = []
        real_open = os.open

        def spy(path, flags, mode=0o777, *args, **kwargs):
            observed.append((str(path), flags, mode))
            return real_open(path, flags, mode, *args, **kwargs)

        monkeypatch.setattr(templates_module.os, "open", spy)
        await renderer.write_client_files(client, credentials=credentials)

        env_opens = [entry for entry in observed if entry[0].endswith(".env")]
        assert env_opens, "the .env was not created through os.open with a mode"
        path, flags, mode = env_opens[-1]
        assert mode == 0o600
        assert flags & os.O_CREAT
        assert flags & os.O_TRUNC

    @pytest.mark.skipif(sys.platform == "win32", reason="NTFS modes are synthetic")
    async def test_env_is_owner_only_on_disk(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(client, credentials=credentials)
        env_path = settings.tenant_dir_for(client.subdomain) / ".env"
        assert stat.S_IMODE(env_path.stat().st_mode) == 0o600

    @pytest.mark.skipif(sys.platform == "win32", reason="NTFS modes are synthetic")
    async def test_tenant_directory_is_owner_only_on_disk(
        self, renderer, settings, client, credentials
    ):
        # config.yaml carries the password hash and the session-signing secret
        # and is written with the default mode, so its protection comes from
        # the containing directory being 0700.
        await renderer.write_client_files(client, credentials=credentials)
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert stat.S_IMODE(tenant_dir.stat().st_mode) == 0o700

    async def test_modes_come_from_settings(
        self, settings_factory, client, credentials, monkeypatch
    ):
        settings = settings_factory(tenant_env_mode=0o400, tenant_dir_mode=0o750)
        observed: list[int] = []
        real_open = os.open

        def spy(path, flags, mode=0o777, *args, **kwargs):
            if str(path).endswith(".env"):
                observed.append(mode)
            return real_open(path, flags, mode, *args, **kwargs)

        monkeypatch.setattr(templates_module.os, "open", spy)
        await TemplateRenderer(settings).write_client_files(
            client, credentials=credentials
        )
        assert observed == [0o400]

    async def test_a_filesystem_that_refuses_chmod_does_not_fail_provisioning(
        self, renderer, settings, client, credentials, monkeypatch
    ):
        # On a Windows bind mount the modes are synthetic and chmod is a no-op
        # that can raise. Provisioning must not die on it.
        def refuse(self, mode):
            raise OSError(1, "Operation not permitted")

        monkeypatch.setattr("pathlib.Path.chmod", refuse)
        await renderer.write_client_files(client, credentials=credentials)
        assert (settings.tenant_dir_for(client.subdomain) / ".env").is_file()

    async def test_rewriting_keeps_the_file_and_its_content_stable(
        self, renderer, settings, client, credentials
    ):
        # Re-provisioning must not loosen a tightened .env, so the existing
        # inode is reused rather than recreated.
        await renderer.write_client_files(client, credentials=credentials)
        env_path = settings.tenant_dir_for(client.subdomain) / ".env"
        first = env_path.read_text(encoding="utf-8")
        await renderer.write_client_files(client, credentials=credentials)
        assert env_path.read_text(encoding="utf-8") == first

    async def test_the_provider_key_lands_only_in_the_env_file(
        self, renderer, settings, client, credentials
    ):
        await renderer.write_client_files(
            client, credentials=credentials, openrouter_api_key=OPENROUTER_KEY
        )
        tenant_dir = settings.tenant_dir_for(client.subdomain)
        assert OPENROUTER_KEY in (tenant_dir / ".env").read_text(encoding="utf-8")
        assert_no_secrets(
            (tenant_dir / "config.yaml").read_text(encoding="utf-8"), OPENROUTER_KEY
        )


# ======================================================================
# 5. subdomain validation
# ======================================================================
class TestSubdomainValidation:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("acme", "acme"),
            ("ACME", "acme"),
            ("Acme Widgets", "acme-widgets"),
            ("acme.widgets", "acme-widgets"),
            ("  acme  ", "acme"),
            ("-acme-", "acme"),
            ("a--b__c", "a-b-c"),
            ("acme!@#$%", "acme"),
            ("Ünïcödé Ltd", "unicode-ltd"),
            ("123", "123"),
        ],
    )
    def test_requested_subdomains_are_normalised_to_a_dns_label(self, raw, expected):
        request = OnboardRequest(
            company_name="Acme Widgets",
            subdomain=raw,
            openrouter_api_key="sk-or-v1-abcdefgh",
            contact_email="ops@acme.example.com",
        )
        assert request.subdomain == expected

    @pytest.mark.parametrize("blank", ["", "   ", "_", "!!!", None])
    def test_an_unusable_subdomain_falls_back_to_the_company_name(
        self, blank, settings
    ):
        request = OnboardRequest(
            company_name="Globex Corporation",
            subdomain=blank,
            openrouter_api_key="sk-or-v1-abcdefgh",
            contact_email="ops@globex.example.com",
        )
        payload = ClientCreate(
            company_name=request.company_name,
            contact_email=request.contact_email,
            slug=request.subdomain,
        )
        assert derive_slug(settings, payload) == "globex-corporation"

    def test_a_label_longer_than_63_characters_is_rejected(self):
        # 63 is the DNS limit for a single label; nginx would accept the
        # server_name and the name would simply never resolve.
        with pytest.raises(ValidationError):
            OnboardRequest(
                company_name="Acme Widgets",
                subdomain="a" * 64,
                openrouter_api_key="sk-or-v1-abcdefgh",
                contact_email="ops@acme.example.com",
            )

    @pytest.mark.parametrize(
        "raw",
        ["Acme Widgets", "ACME!!", "a--b", "  spaced  name  ", "Ünïcödé", "x" * 63],
    )
    def test_derived_labels_satisfy_the_declared_dns_pattern(self, raw, settings):
        slug = derive_slug(
            settings,
            ClientCreate(company_name=raw, contact_email="ops@acme.example.com"),
        )
        assert re.fullmatch(SUBDOMAIN_PATTERN, slug), slug

    def test_truncation_never_leaves_a_trailing_hyphen(self, settings):
        # The slug is 64 chars with its only hyphen at index 62, so the cut at
        # 63 lands exactly on it.
        slug = derive_slug(
            settings,
            ClientCreate(
                company_name="x" * 62 + " y", contact_email="ops@acme.example.com"
            ),
        )
        assert slug == "x" * 62

    def test_transliteration_cannot_lengthen_a_label_past_the_limit(self):
        # 40 characters pass max_length, then slugify doubles them to 80. Only
        # the check on the normalised value can catch this.
        with pytest.raises(ValidationError, match="valid DNS label"):
            OnboardRequest(
                company_name="Acme Widgets",
                subdomain="ß" * 40,
                openrouter_api_key="sk-or-v1-abcdefgh",
                contact_email="ops@acme.example.com",
            )

    @pytest.mark.parametrize("reserved", sorted(RESERVED_SLUGS))
    def test_reserved_labels_are_refused(self, reserved, settings):
        # A tenant claiming one of these would shadow the hub's own routes.
        with pytest.raises(ClientConflictError, match="reserved"):
            derive_slug(
                settings,
                ClientCreate(
                    company_name="Acme Widgets",
                    contact_email="ops@acme.example.com",
                    slug=reserved,
                ),
            )

    def test_a_company_name_that_slugifies_to_nothing_is_refused(self, settings):
        with pytest.raises(ClientConflictError, match="Could not derive"):
            derive_slug(
                settings,
                ClientCreate(company_name="!!!", contact_email="ops@a.example.com"),
            )


class TestDerivedNames:
    def test_subdomain_and_container_name_shapes(self, settings):
        assert settings.subdomain_for("acme") == "acme.localhost"
        assert settings.container_name_for("acme") == "hermes-client-acme"

    def test_local_domains_get_http_and_real_ones_https(self, settings_factory):
        assert settings_factory().client_url_for("acme") == "http://acme.localhost"
        remote = settings_factory(base_domain="agency.example")
        assert remote.client_url_for("acme") == "https://acme.agency.example"

    def test_nginx_upstream_names_drop_hyphens(self, renderer, client):
        # nginx upstream identifiers are not reliably hyphen-safe across
        # versions; underscores always are.
        client.slug = "acme-widgets"
        context = renderer.context_for(client)
        assert context["slug_underscored"] == "acme_widgets"
        assert "-" not in context["slug_underscored"]

    def test_database_names_are_identifier_safe(self, settings):
        assert settings.client_database_name("acme-widgets") == (
            "hermes_client_acme_widgets"
        )


# ======================================================================
# 6. port allocation
# ======================================================================
class TestPortAllocation:
    def test_picks_the_lowest_free_pair(self, settings):
        assert allocate_port_pair(settings, used=set()) == (19000, 19500)

    def test_skips_ports_already_in_use(self, settings):
        assert allocate_port_pair(settings, used={19000, 19001, 19500}) == (
            19002,
            19501,
        )

    def test_exclude_lets_a_retry_make_progress(self, settings):
        # Without exclude, a retry after a collision would re-pick the pair
        # that just lost and loop until it ran out of attempts.
        first = allocate_port_pair(settings, used=set())
        second = allocate_port_pair(settings, used=set(), exclude=set(first))
        assert second == (19001, 19501) != first

    def test_dashboard_exhaustion_is_named(self, settings_factory):
        settings = settings_factory(dash_port_range=(19000, 19001))
        with pytest.raises(NoPortAvailableError, match="dashboard"):
            allocate_port_pair(settings, used={19000, 19001})

    def test_api_exhaustion_is_named_separately(self, settings_factory):
        settings = settings_factory(api_port_range=(19500, 19500))
        with pytest.raises(NoPortAvailableError, match="api"):
            allocate_port_pair(settings, used={19500})

    def test_zero_collisions_across_sequential_tenant_increments(self, settings):
        """The property that actually matters: 200 tenants, 400 unique ports.

        Each allocation sees every port handed out before it, the way the
        provisioner feeds it the union of the database view and what Docker
        reports as published.
        """
        used: set[int] = set()
        pairs: list[tuple[int, int]] = []

        for _ in range(200):
            dash, api = allocate_port_pair(settings, used=used)
            assert dash not in used, "dashboard port handed out twice"
            assert api not in used, "api port handed out twice"
            used.update((dash, api))
            pairs.append((dash, api))

        assert len(used) == 400
        dash_lo, dash_hi = settings.dash_port_range
        api_lo, api_hi = settings.api_port_range
        for dash, api in pairs:
            assert dash_lo <= dash <= dash_hi
            assert api_lo <= api <= api_hi
            # The ranges are validated as disjoint, so a dashboard port can
            # never be mistaken for an api port on the same host.
            assert not api_lo <= dash <= api_hi
            assert dash != api

    def test_allocation_is_stable_under_an_arbitrary_release_pattern(self, settings):
        # Tenants are torn down out of order; freed ports must come back into
        # circulation without ever duplicating a live one.
        used: set[int] = set()
        live: list[tuple[int, int]] = []
        for index in range(40):
            pair = allocate_port_pair(settings, used=used)
            used.update(pair)
            live.append(pair)
            if index % 3 == 0 and len(live) > 2:
                released = live.pop(0)
                used.difference_update(released)
        assert len({port for pair in live for port in pair}) == len(live) * 2

    def test_a_full_dashboard_range_reports_how_many_are_held(self, settings_factory):
        settings = settings_factory(dash_port_range=(19000, 19002))
        with pytest.raises(NoPortAvailableError, match="3 port"):
            allocate_port_pair(settings, used={19000, 19001, 19002})


class TestPortRangeCoherence:
    def test_overlapping_ranges_are_rejected_at_load(self, tmp_path):
        # Overlap would eventually hand one tenant the same port twice; it has
        # to fail at startup, not partway through a provisioning run.
        with pytest.raises(ValidationError, match="overlaps"):
            Settings(
                _env_file=None,
                data_root=tmp_path,
                dash_port_range=(19000, 19500),
                api_port_range=(19400, 19999),
            )

    def test_an_inverted_range_is_rejected_at_load(self, tmp_path):
        with pytest.raises(ValidationError, match="inverted"):
            Settings(
                _env_file=None, data_root=tmp_path, dash_port_range=(19500, 19000)
            )

    def test_adjacent_ranges_are_allowed(self, tmp_path):
        settings = Settings(
            _env_file=None,
            data_root=tmp_path,
            dash_port_range=(19000, 19499),
            api_port_range=(19500, 19999),
        )
        assert settings.dash_port_range[1] + 1 == settings.api_port_range[0]


# ======================================================================
# 7. package import hygiene
# ======================================================================
class TestImportHygiene:
    """A module must import on its own, not only in one lucky order.

    ``proxy`` and ``orchestrator`` depend on each other's submodules, so eager
    re-exports in either package's ``__init__`` bring back an import cycle that
    only the order in ``src.main`` happens to avoid. Each case needs a fresh
    interpreter: in this process everything is already imported.
    """

    def _import_in_a_fresh_interpreter(self, module: str):
        import subprocess

        return subprocess.run(
            [sys.executable, "-c", f"import {module}"],
            cwd=BACKEND_ROOT,
            capture_output=True,
            text=True,
        )

    @pytest.mark.slow
    @pytest.mark.parametrize(
        "module",
        [
            "src.main",
            "src.api.clients",
            "src.clients.service",
            "src.orchestrator.docker_service",
            "src.orchestrator.provisioner",
            "src.proxy.nginx",
            "src.proxy.service",
            "src.proxy.traefik",
        ],
    )
    def test_modules_import_standalone(self, module):
        result = self._import_in_a_fresh_interpreter(module)
        assert result.returncode == 0, result.stderr


# ======================================================================
# 8. credential shape
# ======================================================================
class TestCredentialShape:
    def test_api_key_is_traceable_to_its_tenant(self):
        # A leaked key must be attributable without a database lookup.
        assert re.fullmatch(r"sk-acme-[A-Za-z0-9_-]{16,}", generate_api_key("acme"))

    def test_api_keys_and_passwords_are_unique_per_tenant(self):
        first = generate_tenant_credentials("acme")
        second = generate_tenant_credentials("acme")
        assert first.api_key != second.api_key
        assert first.dashboard_password != second.dashboard_password
        assert first.dashboard_secret != second.dashboard_secret

    def test_the_stored_hash_verifies_the_returned_password(self):
        creds = generate_tenant_credentials("acme")
        assert verify_dashboard_password(
            creds.dashboard_password, creds.dashboard_password_hash
        )
        assert not verify_dashboard_password("wrong", creds.dashboard_password_hash)

    def test_the_persistable_subset_excludes_the_plaintext(self):
        creds = generate_tenant_credentials("acme")
        persisted = creds.as_persistable()
        assert "dashboard_password" not in persisted
        assert_no_secrets(persisted, creds.dashboard_password)
