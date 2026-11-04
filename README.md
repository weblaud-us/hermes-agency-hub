# Hermes Agency Hub

A control plane for running one isolated [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent)
container per client. One API call onboards a client: it generates credentials,
writes the tenant's config, starts a hardened container, and publishes an nginx
vhost at `<subdomain>.<base-domain>`.

Runs fully containerized — the same `docker-compose.yml` on a laptop and on a VPS.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/clients/onboard` | Create a client and stand up its container |
| `DELETE` | `/api/v1/clients/{id}` | Stop, remove, archive data, drop the route |
| `GET` | `/api/v1/clients/{id}/health` | Container state + live probe of both services |
| `GET` | `/api/v1/clients` | List / search |
| `GET` | `/api/v1/clients/stats` | Fleet summary |
| `GET` | `/api/v1/clients/{id}` · `PATCH` | Read / update one client |
| `GET` | `/api/v1/clients/{id}/logs` · `/audit` | Container logs · audit trail |
| `POST` | `/api/v1/clients/{id}/portal-token` | Issue a client portal access link |
| `GET` | `/healthz` | Unauthenticated liveness |
| | `/api/v1/portal/{slug}/…` | The client portal, see [below](#client-portal) |

Every `/api/v1` route requires `X-API-Key: $ADMIN_API_KEY`, except the client
portal, which has its own per-tenant token.

## Client portal

`/portal/<slug>` is a white-label portal where a business owner sees their agent
as an "AI Operations Coordinator": activity, channels, scheduled briefings,
learned skills and business memory. It never names the agent, its vendors or the
infrastructure. Give a client access with:

```bash
curl -X POST http://localhost:8080/api/v1/clients/<id>/portal-token \
  -H "X-API-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"ttl_days": 90}'
```

Send them the returned `portal_url`. The token sits in the URL fragment, so it
stays out of server logs. `{"revoke_existing": true}` invalidates every earlier
token for that tenant.

| Method | Path under `/api/v1/portal/{slug}` | Purpose |
|---|---|---|
| `GET` | `/overview` | Status and 30-day activity |
| `GET` | `/channels` | Connection state, masked handles, 24h volume |
| `POST` | `/channels/{channel}/reconnect` | Refresh, or start WhatsApp re-linking |
| `GET` | `/channels/whatsapp/pairing` | Poll a re-link for its current QR |
| `POST` | `/channels/{channel}/test` | Check a channel; Telegram sends a real message |
| `PUT` | `/channels/{channel}/allowlist` | Change who may message the Coordinator |
| `GET` | `/cron-reports` | Scheduled jobs and their reports |
| `POST` | `/cron-reports/{job_id}/trigger` | Run a briefing now |
| `GET` | `/skills-and-memory` | Agency skills, learned skills, memory |
| `PATCH` | `/skills/{skill_id}` | Turn a learned skill on or off |
| `PATCH` | `/memory` | Append, replace or remove a business rule |
| `POST` | `/chat` | Message the Coordinator |

**Client browsers talk to the frontend, never the hub.** The frontend's
`/portal-api` route forwards to `PORTAL_HUB_URL` and can reach only these paths,
so the hub stays off the public internet. If no backend answers at all, the page
renders clearly labelled sample data; a backend that answers, even to refuse a
token, never produces sample data, because fake figures would be read as real.

**The hub must share a uid with its tenants.** The agent keeps its files at 0600
under a 0700 directory, so `docker-compose.yml` sets `CLIENT_UID=10001` to match
the hub. A tenant provisioned under another uid gets a generic "temporarily
unavailable" in the portal and an actionable line in the hub's log. Re-provision
it or `chown -R 10001:10001` its directory.

### What the boundary does and does not guarantee

- **Tenant files are treated as hostile.** The agent has a shell, so a symlink in
  its directory could point at another tenant's `.env` on the host. Anything that
  does not resolve to exactly itself is refused, for reads and writes alike.
- **Cron documents contain the job's private prompt**, so only the framed response
  is returned, and a document that cannot be framed returns nothing.
- **Vendor skills are excluded from "learned".** The agent copies its bundled
  library into `skills/`; `.bundled_manifest` and `.hub/lock.json` identify them.
- **Business rules are screened, not proven safe.** A pattern list raises the bar
  against prompt injection but cannot recognise every paraphrase.
- **Chat is as capable as the agent.** Replies are scrubbed of platform vocabulary
  and the tenant's exact secrets, and the agent is told not to reveal its internals,
  but an instruction can be argued with. An owner who persuades it to quote
  `SOUL.md` will see text that no pattern can recognise. Closing that needs a
  restricted toolset on the agent's side.
- **Uptime is an upper bound.** Docker records only the most recent stop, so earlier
  outages in the window are not counted.

## What a tenant gets

Each client runs in its own container with a hard resource and security
envelope:

```
command         sleep infinity
memory          2g
cpus            1.0
pids_limit      200
cap_drop        ALL
cap_add         CHOWN SETUID SETGID FOWNER DAC_OVERRIDE
security_opt    no-new-privileges:true
restart         unless-stopped
ports           127.0.0.1:<dash>:9119   (web dashboard)
                127.0.0.1:<api>:8642    (OpenAI-compatible API)
volumes         <data_root>/tenants/<subdomain> -> /opt/data            rw
                <data_root>/shared-skills       -> …/skills/agency_core ro
```

Those five capabilities are the minimum the agent image's s6-overlay init
needs — it chowns the data volume and drops each supervised service to an
unprivileged user. A bare `cap_drop: ALL` leaves the supervision tree unable to
start anything. `NET_RAW`, `NET_ADMIN`, `SYS_ADMIN`, `SYS_PTRACE` and ~35
others stay dropped.

`sleep infinity` is the container's main program, and the entrypoint stays the
image's own. When the main program exits, s6 shuts down every service, and with
no command it would be the interactive CLI, which exits at once without a
terminal. The gateway and dashboard run as supervised services alongside it.

Credentials are generated per tenant: a dashboard username/password (stored
only as an scrypt hash), a session-signing secret, and a bearer token
`sk-{subdomain}-…`. **The dashboard password is returned exactly once**, in the
onboarding response. The hub cannot recover it.

## Quick start

On Windows, double-click `start.bat`. It writes local test settings, starts
everything, creates a demo client and prints the logins. `stop.bat` stops it and
keeps your data. See [LOCAL_TESTING.md](LOCAL_TESTING.md).

By hand:

```powershell
# 1. Configure
cp .env.example .env
# Fill in ADMIN_API_KEY and POSTGRES_PASSWORD:
#   python -c "import secrets; print(secrets.token_urlsafe(32))"

# 2. Start. This pulls the agent image (several GB), builds the hub and website,
#    and migrates the database. The website is at http://localhost:3000.
docker compose up -d --build

# 3. Onboard
curl -X POST http://localhost:8080/api/v1/clients/onboard `
  -H "X-API-Key: $env:ADMIN_API_KEY" -H "Content-Type: application/json" `
  -d '{\"company_name\":\"Acme\",\"subdomain\":\"acme\",\"contact_email\":\"ops@acme.com\",\"openrouter_api_key\":\"sk-or-...\"}'
```

The response carries `dashboard_url`, `dashboard_username`,
`dashboard_password`, `api_key` and `api_base_url`. Save the password.

On a Linux host, create the data root first:
`sudo mkdir -p /srv/hermes-multi && sudo chown 10001:10001 /srv/hermes-multi`,
and set `DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` in `.env`.

## Architecture

```
backend/src/
  main.py                    FastAPI app, lifespan, exception -> status mapping
  api/clients.py             the HTTP surface
  clients/
    models.py                Client + AuditLog
    schemas.py               request/response shapes
    service.py               persistence only — no Docker, no HTTP
    skills.py                per-plan skill sync
  orchestrator/
    provisioner.py           THE COORDINATOR — the only module holding
                             database + Docker + filesystem + nginx at once,
                             and so the only one that can roll back
    docker_service.py        container lifecycle, security envelope, probes
    credentials.py           scrypt hashing + per-tenant secret generation
    templates.py             renders .env / config.yaml / nginx site
  portal/                    the client portal, and its own trust boundary
    portal_router.py         routes and per-tenant authentication
    readers.py               the agent's on-disk layout -> what an owner sees
    tenant_files.py          file access locked to one tenant's directory
    sanitize.py              white-label scrub; business rule screening
    tokens.py                per-tenant signed access tokens
    pairing.py               WhatsApp re-linking through the agent's own bridge
    tenant_api.py            calls to a tenant's API
  proxy/
    nginx.py                 site files, validate-before-reload
    service.py               routing facade + port allocation
    traefik.py               label-based alternative (off by default)
  templates/                 the four Jinja templates
```

### Two things that are easy to get wrong

**Bind-mount sources are resolved by the Docker daemon, not by the hub.** The
hub creates *sibling* containers through the mounted socket. If it wrote tenant
files to a path only it could see and passed that same string as a bind source,
the daemon would resolve it against the host, find nothing, and hand the tenant
an empty directory. The fix is path identity: `/srv/hermes-multi` is mounted
into the hub at the same absolute path. `Settings.to_host()` exists for the
case where that is impossible (`DATA_ROOT_HOST`).

**Published ports live on the host's loopback, not the hub's.** A containerized
hub probing `127.0.0.1:19000` hits its own loopback; a containerized nginx
proxying there hits nginx's. So both reach tenants over the shared
`hermes-clients` network by container name (`probe_mode`,
`nginx_upstream_mode` = `network`). The loopback ports are still published —
for host-side `curl` debugging, and for the host-nginx deployment.

**nginx looks up each tenant per request, not at startup.** nginx refuses its
whole config if a name in an `upstream` block does not resolve when it loads, so
one stopped tenant would block every later reload and stop nginx from restarting.
Under `network` mode the tenant sites therefore use Docker's DNS (`127.0.0.11`)
and `proxy_pass` through a variable. A stopped tenant's visitors get a 502 and
everyone else is unaffected. The trade-off is no upstream keepalive.

### Secret handling

The agent loads `/opt/data/.env` with `override=True`, so that file wins over
anything passed as a container environment variable. Secrets therefore go in
the rendered `.env` (mode `0600`) and are **not** duplicated into the Docker
env — which also keeps them out of `docker inspect`. The tenant's OpenRouter
key is written there and nowhere else, including the hub's own database, which
stores only its last four characters for support triage.

A few non-secret settings go in both places (`DOCKER_ENV_KEYS`), because the
image's s6 scripts read the process environment and never see that file. Without
them the dashboard exits for good and a fresh tenant's gateway stays down.

## Deployment modes

`nginx_control_mode` selects how nginx is driven:

| Mode | nginx runs | Test / reload via | Notes |
|---|---|---|---|
| `docker` *(default)* | container | `docker exec` | local and VPS; no host root needed |
| `systemctl` | host | `nginx -t`, `systemctl reload nginx` | requires the hub **outside** Docker |
| `none` | — | skipped | tests, dry runs |

A site is always validated with `nginx -t` before any reload, and a rejected
config is rolled back and re-tested — a bad render for one tenant can never
take down the others. The `systemctl` mode additionally requires
`nginx_upstream_mode=loopback`; a settings validator enforces this, because a
host nginx cannot resolve Docker container names. See `.env.example` for the
full override block.

## Tests

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pytest
```

112 tests, no Docker/Postgres/nginx required — the provisioner runs against a
fake daemon and SQLite.

| File | Covers |
|---|---|
| `test_credentials.py` | the scrypt format, cross-checked against an independent transcription of the agent's own verifier |
| `test_templates.py` | rendered output, and that secrets land only where intended |
| `test_settings_and_ports.py` | path derivation, host translation, coherence validators, port allocation |
| `test_provisioner.py` | happy path, rollback, port-collision retry, teardown, archive, health |
| `test_api.py` | auth, status-code mapping, response shapes |
| `test_portal.py` | tenant isolation, the white-label boundary, hostile files, injection screening |
| `test_real_agent.py` | opt-in: a new tenant on the real agent image, through the running stack |

> On Python 3.14 the pinned versions in `requirements.txt` have no wheels
> (they target the container's Python 3.12). To run tests on 3.14, install
> unpinned: `pip install "pydantic>=2.12" "SQLAlchemy[asyncio]>=2.0.40"
> "greenlet>=3.2" docker Jinja2 httpx python-slugify email-validator pytest
> pytest-asyncio fastapi aiosqlite`.

## Verifying a real tenant

Once a container is actually running, these are the checks worth making:

```bash
# The capability set is sufficient — the single most important check.
# Expect "[stage2] Setup complete" and NO s6-setuidgid permission errors.
docker logs hermes-client-acme | head -40

# The envelope was applied.
docker inspect hermes-client-acme \
  --format '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.PidsLimit}} {{.HostConfig.SecurityOpt}}'

# Loopback only — never 0.0.0.0.
docker port hermes-client-acme

# The bind source resolved to the hub-written directory, not an empty dir.
docker exec hermes-client-acme head -5 /opt/data/.env

# The shared library is read-only.
docker exec hermes-client-acme touch /opt/data/skills/agency_core/x  # must fail

# The generated credentials are accepted by the real image.
curl -u admin:<password> http://127.0.0.1:<dash_port>/api/health
curl -H "Authorization: Bearer <api_key>" http://127.0.0.1:<api_port>/v1/models

# Routed through nginx.
curl -H 'Host: acme.localhost' http://localhost/
```

## Known constraints

- **`pids_limit=200` is tight.** s6 supervises the gateway, the dashboard and
  logging, and the agent's browser tool spawns Chromium, which forks
  generously. Raise `CLIENT_PIDS_LIMIT` if the browser tool fails to launch.
- **`2g` per tenant.** Two local tenants plus Postgres and the hub needs ~5GB
  from Docker Desktop's allocation.
- **Onboarding is synchronous.** With the image pre-pulled it takes as long as
  the health probe. If you want it non-blocking later, the `PROVISIONING`
  status already exists for a 202 + background-task variant.
- **`nousresearch/hermes-agent:latest` is unverified here.** If the tag does
  not resolve, set `CLIENT_IMAGE` to an image you build from a local checkout.
- Changing a client's `plan` updates the recorded CPU/memory envelope but does
  not resize a running container; Docker cannot change those in place.
  Re-provision to apply.
