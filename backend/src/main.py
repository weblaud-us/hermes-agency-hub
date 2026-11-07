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
from .api.ops import router as ops_router
from .auth import service as auth_service
from .auth.router import router as auth_router
from .clients.service import ClientConflictError, ClientNotFoundError
from .config.database import dispose_engine, session_scope
from .config.logging import configure_logging
from .config.settings import get_settings
from .orchestrator.docker_service import OrchestratorError
from .ops.approvals import (
    ApprovalInputError,
    ApprovalNotFoundError,
    ApprovalTransitionError,
)
from .ops.guardrails import GuardrailLockedError, GuardrailNotFoundError
from .ops.kits import KitNotFoundError
from .orchestrator.provisioner import get_provisioner
from .portal.errors import PortalError
from .portal.growth_router import router as portal_growth_router
from .portal.knowledge_router import router as portal_knowledge_router
from .portal.portal_router import admin_router as portal_admin_router
from .portal.social_router import router as portal_social_router
from .portal.portal_router import router as portal_router
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
        async with session_scope() as session:
            created = await auth_service.seed_accounts(session, settings)
        if created:
            logger.info("Seeded %d account(s): %s", len(created), ", ".join(created))
    except Exception:  # noqa: BLE001 - same reasoning as above
        logger.exception("Could not seed accounts. Sign-in will not work until this is fixed.")
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

    app.include_router(auth_router, prefix=settings.api_prefix)
    app.include_router(clients_router, prefix=settings.api_prefix)
    app.include_router(ops_router, prefix=settings.api_prefix)
    app.include_router(portal_router, prefix=settings.api_prefix)
    app.include_router(portal_growth_router, prefix=settings.api_prefix)
    app.include_router(portal_social_router, prefix=settings.api_prefix)
    app.include_router(portal_knowledge_router, prefix=settings.api_prefix)
    app.include_router(portal_admin_router, prefix=settings.api_prefix)

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

    @app.exception_handler(PortalError)
    async def _portal_error(request: Request, exc: PortalError) -> JSONResponse:
        # Written for a business owner, so unlike the handlers above it is safe
        # to return to someone outside the agency.
        return _problem(exc.status_code, exc.slug, exc.detail)

    # Everything below is worded so that it is safe to show a business owner.
    @app.exception_handler(ApprovalNotFoundError)
    async def _approval_missing(request: Request, exc: ApprovalNotFoundError) -> JSONResponse:
        return _problem(status.HTTP_404_NOT_FOUND, "approval_not_found", "That item no longer exists.")

    @app.exception_handler(ApprovalTransitionError)
    async def _approval_conflict(request: Request, exc: ApprovalTransitionError) -> JSONResponse:
        return _problem(
            status.HTTP_409_CONFLICT,
            "approval_invalid_transition",
            "This item has already been decided. Refresh to see where it is now.",
        )

    @app.exception_handler(ApprovalInputError)
    async def _approval_input(request: Request, exc: ApprovalInputError) -> JSONResponse:
        return _problem(422, "approval_invalid", str(exc))

    @app.exception_handler(GuardrailNotFoundError)
    async def _guardrail_missing(request: Request, exc: GuardrailNotFoundError) -> JSONResponse:
        return _problem(status.HTTP_404_NOT_FOUND, "guardrail_not_found", "That item does not exist.")

    @app.exception_handler(GuardrailLockedError)
    async def _guardrail_locked(request: Request, exc: GuardrailLockedError) -> JSONResponse:
        return _problem(
            status.HTTP_409_CONFLICT,
            "guardrail_locked",
            "This one always needs a person, so it cannot be made automatic.",
        )

    @app.exception_handler(KitNotFoundError)
    async def _kit_missing(request: Request, exc: KitNotFoundError) -> JSONResponse:
        return _problem(status.HTTP_404_NOT_FOUND, "kit_not_found", "No such starter kit.")

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
