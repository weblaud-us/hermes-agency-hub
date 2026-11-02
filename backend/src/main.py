"""Hermes Agency Hub — application entry point.

Wires the client router onto a FastAPI app, prepares shared state at startup,
and translates the domain's exception types into HTTP status codes in one
place so no route has to catch them individually.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.clients import router as clients_router
from .clients.service import ClientConflictError, ClientNotFoundError
from .config.database import dispose_engine
from .config.logging import configure_logging
from .config.settings import get_settings
from .orchestrator.docker_service import OrchestratorError
from .orchestrator.provisioner import get_provisioner
from .proxy.service import NoPortAvailableError, ProxyError

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Prepare shared state on the way up, release it on the way down.

    Bootstrap failures are logged rather than fatal: a hub that cannot reach
    Docker should still start and serve its API, because that is how an
    operator finds out *why* it cannot reach Docker. Provisioning will fail
    loudly and specifically when attempted.
    """
    configure_logging()
    settings = get_settings()
    logger.info(
        "Starting Hermes Agency Hub (env=%s, proxy=%s/%s, image=%s)",
        settings.environment,
        settings.proxy_mode,
        settings.nginx_control_mode,
        settings.client_image,
    )
    try:
        await get_provisioner().bootstrap()
    except Exception:  # noqa: BLE001 - never block startup on this
        logger.exception(
            "Bootstrap did not complete. The API is up, but provisioning will "
            "fail until the underlying problem is fixed."
        )
    try:
        yield
    finally:
        await dispose_engine()
        logger.info("Hermes Agency Hub stopped")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Hermes Agency Hub",
        description=(
            "Agency control plane for provisioning isolated Nous Research "
            "Hermes Agent instances, one container per client."
        ),
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if settings.debug else None,
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(clients_router, prefix=settings.api_prefix)

    # ---- domain errors -> status codes --------------------------------
    # Mapped centrally so routes can let these propagate instead of each
    # wrapping the same try/except. The body shape is uniform: `error` is a
    # stable machine-readable slug, `detail` is for humans.
    def _problem(code: int, slug: str, detail: str) -> JSONResponse:
        return JSONResponse(status_code=code, content={"error": slug, "detail": detail})

    @app.exception_handler(ClientNotFoundError)
    async def _not_found(request: Request, exc: ClientNotFoundError) -> JSONResponse:
        return _problem(status.HTTP_404_NOT_FOUND, "client_not_found", str(exc))

    @app.exception_handler(ClientConflictError)
    async def _conflict(request: Request, exc: ClientConflictError) -> JSONResponse:
        return _problem(status.HTTP_409_CONFLICT, "client_conflict", str(exc))

    @app.exception_handler(NoPortAvailableError)
    async def _no_ports(request: Request, exc: NoPortAvailableError) -> JSONResponse:
        # Capacity, not a client error: the request was valid and would
        # succeed once a port frees up or the range widens.
        return _problem(
            status.HTTP_503_SERVICE_UNAVAILABLE, "no_port_available", str(exc)
        )

    @app.exception_handler(ProxyError)
    async def _proxy_error(request: Request, exc: ProxyError) -> JSONResponse:
        return _problem(status.HTTP_503_SERVICE_UNAVAILABLE, "proxy_error", str(exc))

    @app.exception_handler(OrchestratorError)
    async def _docker_error(request: Request, exc: OrchestratorError) -> JSONResponse:
        # The hub is fine; its dependency is not. 502 says "upstream failed".
        return _problem(status.HTTP_502_BAD_GATEWAY, "orchestrator_error", str(exc))

    # ---- liveness -----------------------------------------------------
    @app.get("/healthz", tags=["meta"], summary="Hub liveness")
    async def healthz() -> dict[str, object]:
        """Unauthenticated: load balancers and `docker healthcheck` use it.

        Reports the hub's own state and whether the Docker daemon answers.
        Reveals no tenant information, so it is safe to leave open.
        """
        from .orchestrator.docker_service import get_docker_service

        docker_ok = await get_docker_service().ping()
        return {
            "status": "ok",
            "environment": settings.environment,
            "docker": docker_ok,
        }

    return app


app = create_app()
