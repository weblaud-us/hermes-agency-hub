"""HTTP surface for client lifecycle management.

Every route on this router requires the agency admin key. A tenant's own
traffic goes through nginx straight to its container, authenticated by that
tenant's own credentials. The one tenant-facing surface on the hub is the client
portal, in ``portal/``, which has its own per-tenant authentication.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients import service as client_service
from ..clients.models import ClientPlan, SubscriptionStatus
from ..clients.schemas import (
    AuditLogRead,
    ClientCreate,
    ClientHealth,
    ClientList,
    ClientRead,
    ClientUpdate,
    ContainerLogs,
    HubStats,
    OnboardRequest,
    OnboardResponse,
    PortProbe,
    TeardownResponse,
)
from ..config.database import get_session
from ..config.security import require_admin
from ..config.settings import Settings, get_settings
from ..orchestrator.docker_service import DockerService, get_docker_service
from ..orchestrator.provisioner import Provisioner, get_provisioner

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/clients",
    tags=["clients"],
    dependencies=[Depends(require_admin)],
)


def _to_read(client, settings: Settings) -> ClientRead:
    """Serialise a client, filling the computed public URL."""
    model = ClientRead.model_validate(client)
    model.url = settings.client_url_for(client.slug)
    return model


# --------------------------------------------------------------- onboarding
@router.post(
    "/onboard",
    response_model=OnboardResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Onboard a new client",
    response_description=(
        "Tenant access details. The dashboard password appears here once and "
        "is not recoverable afterwards."
    ),
)
async def onboard_client(
    payload: OnboardRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    provisioner: Provisioner = Depends(get_provisioner),
) -> OnboardResponse:
    """Create a client and stand up its isolated agent container.

    Runs the full sequence synchronously: directory, credentials, skills,
    container, nginx route, health probe. Expect this to take a while on the
    first call after a deployment if the agent image has not been pulled yet.

    A tenant whose container starts but fails its health probe still returns
    201 with valid credentials and a populated ``warning`` — the tenant exists,
    it is just not answering yet, and the operator needs the credentials to
    investigate.
    """
    client = await client_service.create_client(
        session,
        settings,
        ClientCreate(
            company_name=payload.company_name,
            contact_email=payload.contact_email,
            plan=payload.plan,
            slug=payload.subdomain,
            image=payload.image,
            config=payload.config,
            channels=payload.channels,
        ),
    )

    result = await provisioner.provision_client(
        session, client, payload.openrouter_api_key
    )

    return OnboardResponse(
        client_id=client.id,
        company_name=client.company_name,
        subdomain=client.subdomain,
        status=client.subscription_status,
        dashboard_url=settings.client_url_for(client.slug),
        dashboard_username=result.credentials.dashboard_username,
        dashboard_password=result.credentials.dashboard_password,
        api_base_url=f"{settings.client_url_for(client.slug)}/v1",
        api_key=result.credentials.api_key,
        container_name=client.container_name,
        container_port_dash=client.container_port_dash,
        container_port_api=client.container_port_api,
        synced_skills=result.synced_skills,
        warning=None if result.healthy else result.detail,
    )


# ----------------------------------------------------------------- teardown
@router.delete(
    "/{client_id}",
    response_model=TeardownResponse,
    summary="Decommission a client",
)
async def delete_client(
    client_id: uuid.UUID,
    archive: bool = Query(
        True,
        description=(
            "Move the tenant's data directory to the archive root instead of "
            "deleting it. Disable only when the data is genuinely disposable."
        ),
    ),
    purge: bool = Query(
        False,
        description=(
            "Also delete the client row and its audit trail. Off by default: "
            "the audit history of a decommissioned tenant is usually worth "
            "keeping."
        ),
    ),
    session: AsyncSession = Depends(get_session),
    provisioner: Provisioner = Depends(get_provisioner),
) -> TeardownResponse:
    """Stop the container, remove the route, and archive the tenant's data."""
    client = await client_service.get_client(session, client_id)
    result = await provisioner.teardown_client(session, client, archive=archive)

    response = TeardownResponse(
        client_id=client.id,
        subdomain=client.subdomain,
        status=client.subscription_status,
        container_removed=result.container_removed,
        proxy_removed=result.proxy_removed,
        archive_path=str(result.archive_path) if result.archive_path else None,
    )
    if purge:
        await client_service.delete_client(session, client)
    return response


# ------------------------------------------------------------------- health
@router.get(
    "/{client_id}/health",
    response_model=ClientHealth,
    summary="Check a client's container and services",
)
async def client_health(
    client_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    provisioner: Provisioner = Depends(get_provisioner),
) -> ClientHealth:
    """Report container state plus a live probe of both tenant services.

    ``healthy`` is true only when the container is running *and* both the
    dashboard and the API answer. A 401 from the dashboard counts as
    reachable: it proves the service is up and its auth gate is engaged.
    """
    client = await client_service.get_client(session, client_id)
    report = await provisioner.health_check(client)
    return ClientHealth(
        client_id=client.id,
        slug=client.slug,
        subdomain=client.subdomain,
        subscription_status=client.subscription_status,
        container_state=report["container_state"],
        container_id=report["container_id"],
        container_health=report["container_health"],
        started_at=report["started_at"],
        restart_count=report["restart_count"],
        dashboard=PortProbe(**report["dashboard"]) if report["dashboard"] else None,
        api=PortProbe(**report["api"]) if report["api"] else None,
        healthy=report["healthy"],
    )


# -------------------------------------------------------------------- reads
@router.get("", response_model=ClientList, summary="List clients")
async def list_clients(
    subscription_status: SubscriptionStatus | None = None,
    plan: ClientPlan | None = None,
    q: str | None = Query(None, description="Match company name, subdomain or email."),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClientList:
    items, total = await client_service.list_clients(
        session,
        status=subscription_status,
        plan=plan,
        query=q,
        limit=limit,
        offset=offset,
    )
    return ClientList(
        items=[_to_read(client, settings) for client in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/stats", response_model=HubStats, summary="Fleet summary")
async def hub_stats(
    session: AsyncSession = Depends(get_session),
    docker: DockerService = Depends(get_docker_service),
) -> HubStats:
    """Counts by status and plan, plus how many containers are actually up.

    Declared before ``/{client_id}`` so "stats" is not parsed as a client id.
    """
    data = await client_service.stats(session)
    return HubStats(**data, running_containers=await docker.running_count())


@router.get("/{client_id}", response_model=ClientRead, summary="Get one client")
async def get_client(
    client_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClientRead:
    client = await client_service.get_client(session, client_id)
    return _to_read(client, settings)


@router.patch("/{client_id}", response_model=ClientRead, summary="Update a client")
async def update_client(
    client_id: uuid.UUID,
    payload: ClientUpdate,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClientRead:
    """Update client metadata.

    Changing ``plan`` updates the recorded CPU/memory envelope but does not
    resize a running container — Docker cannot change those limits in place.
    Re-provision to apply new limits.
    """
    client = await client_service.get_client(session, client_id)
    await client_service.update_client(session, settings, client, payload)
    return _to_read(client, settings)


@router.get(
    "/{client_id}/logs",
    response_model=ContainerLogs,
    summary="Tail a client's container logs",
)
async def client_logs(
    client_id: uuid.UUID,
    tail: int = Query(200, ge=1, le=5000),
    session: AsyncSession = Depends(get_session),
    docker: DockerService = Depends(get_docker_service),
) -> ContainerLogs:
    client = await client_service.get_client(session, client_id)
    name = client.container_name or client.slug
    return ContainerLogs(
        client_id=client.id,
        slug=client.slug,
        lines=await docker.logs(name, tail=tail),
    )


@router.get(
    "/{client_id}/audit",
    response_model=list[AuditLogRead],
    summary="Read a client's audit trail",
)
async def client_audit(
    client_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=1000),
    session: AsyncSession = Depends(get_session),
) -> list[AuditLogRead]:
    client = await client_service.get_client(session, client_id)
    entries = await client_service.list_audit_logs(session, client.id, limit=limit)
    return [AuditLogRead.model_validate(entry) for entry in entries]
