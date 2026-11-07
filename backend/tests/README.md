# Test suite

```
tests/
  conftest.py          fixtures, the Docker SDK fake, shared assertions, cleanup hooks
  test_unit.py         generated artefacts, file modes, naming, port allocation
  test_orchestrator.py container lifecycle: SDK calls, provisioning, teardown
  test_e2e_api.py      the HTTP surface, end to end
  test_auth_rbac.py    sign-in, session tokens, one-time codes, the role matrix
  test_roi_and_approvals.py  ROI arithmetic, approval states, guardrails, CRM, skills
  test_real_agent.py   opt-in: a new tenant on the real agent image
```

The default run needs **no services at all** — no Docker daemon, no Postgres, no
network. Everything that touches disk is confined to `tmp_path`, the Docker SDK
is faked, and the database is file-backed SQLite.

## Run it

```powershell
# from backend/
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

pytest                                  # the whole suite
pytest tests/test_unit.py               # one layer
pytest -k "port"                        # one topic
pytest --cov=src --cov-report=term-missing
pytest --cov=src --cov-report=html      # then open htmlcov/index.html
```

```bash
# bash equivalent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pytest
```

`pytest.ini` lives in `backend/`, so run from there (or pass `-c backend/pytest.ini`).

## Opt-in layers

These are off by default because they need a daemon and take real time.

```powershell
# Create and inspect a real container; verifies the daemon actually APPLIES the
# resource caps and security flags, not just that we asked for them. Also runs a
# real `nginx -t` over the rendered config, and real traffic through nginx to
# stand-in tenants, stopping one to prove the others keep serving.
# Pulls alpine:3.20 and nginx:alpine once if absent.
$env:HERMES_TEST_DOCKER = "1"; pytest -m docker

# Run the whole suite against a throwaway Postgres instead of SQLite, so the
# schema is exercised on the engine production uses.
pip install "testcontainers[postgres]"
$env:HERMES_TEST_POSTGRES = "1"; pytest

# Onboard a tenant on the real agent image through the running stack, and check
# it comes up and stays up. The only layer that can see the agent itself fail.
# Needs `docker compose up` done and the agent image pulled.
$env:HERMES_TEST_AGENT = "1"; $env:HERMES_TEST_ADMIN_KEY = "<ADMIN_API_KEY>"; pytest -m agent
```

```bash
HERMES_TEST_DOCKER=1 pytest -m docker
HERMES_TEST_POSTGRES=1 pytest
HERMES_TEST_AGENT=1 HERMES_TEST_ADMIN_KEY=<ADMIN_API_KEY> pytest -m agent
```

Overrides: `HERMES_TEST_IMAGE` (default `alpine:3.20`),
`HERMES_TEST_POSTGRES_IMAGE` (default `postgres:16-alpine`),
`HERMES_TEST_HUB_URL` (default `http://localhost:8080`),
`HERMES_TEST_NGINX_URL` (default `http://localhost`).

## What is mocked, and what is not

| Layer | Real | Faked |
|---|---|---|
| `test_unit.py` | renderer, settings, allocator, `tmp_path` | nothing |
| `test_orchestrator.py` | `DockerService`, provisioner, DB, filesystem | the Docker SDK client |
| `test_e2e_api.py` | the whole app, provisioner, renderer, DB | the Docker SDK client, `DockerService.probe` |
| `test_auth_rbac.py`, `test_roi_and_approvals.py` | the whole app, as above, plus the real `shared-skills/` | the Docker SDK client, `DockerService.probe` |

`FakeDockerClient` (in `conftest.py`) records what the daemon was asked to do
**and** synthesises the `HostConfig` a daemon would build from it. One helper,
`assert_hardened()`, checks that synthetic HostConfig in the fast tests and a
real `docker inspect` payload under `-m docker` — so both layers verify one
contract instead of two that can drift apart.

## Known defects (`XFAIL`)

A confirmed bug that is not fixed yet is pinned with `xfail(strict=True)` and a
`reason` giving the diagnosis. Because it is *strict*, fixing the bug turns the
xfail into a **failure**, which is the prompt to delete the marker. Run
`pytest -rx` to list them. There are none at the moment.

## Conventions

- `asyncio_mode = auto`: async tests need no marker.
- `--strict-markers` / `--strict-config`: a typo'd marker is a collection error.
- `filterwarnings = error::DeprecationWarning:src.*`: our own deprecations fail
  the build; third-party ones do not.
- Fixtures reset every `lru_cache`d singleton and clear
  `app.dependency_overrides` after each test, so a configuration cannot leak
  into the next test and show up as an order-dependent failure.
