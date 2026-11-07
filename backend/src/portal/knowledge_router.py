"""Business setup, the catalog, channel credentials and the usage estimate.

Same tenant resolution and white-label rules as the rest of the portal: the owner
sees plain-English results, never a file path, a supplier or a stored secret.
Changes need the owner's authority (or a staff role allowed to act for them).
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import KeyedWindow
from ..auth.models import UserRole
from ..clients import service as client_service
from ..clients.models import AuditStatus, BusinessMode, Client
from ..config.database import get_session
from ..config.settings import Settings, get_settings
from ..ops.models import SocialPost
from ..orchestrator.docker_service import DockerService, get_docker_service
from . import integrations, knowledge, readers
from .growth_router import _require_owner_authority
from .knowledge_schemas import (
    BusinessSetup,
    BusinessSetupView,
    CatalogImport,
    CatalogImportResult,
    CatalogItem,
    CatalogItemInput,
    CatalogView,
    IntegrationsSaveResult,
    IntegrationsUpdate,
    IntegrationsView,
    IntegrationTarget,
    IntegrationTestResult,
    UsageSummary,
)
from .portal_router import PortalActor, _container_name, require_actor, require_tenant, require_writable

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/portal/{subdomain}", tags=["portal"])

_test_limit = KeyedWindow(6, 60)
_apply_limit = KeyedWindow(3, 600)

_RESTART_KEYS = {
    integrations.ENV_TELEGRAM_TOKEN,
    integrations.ENV_TELEGRAM_USERS,
    integrations.ENV_WA_TOKEN,
    integrations.ENV_WA_PHONE_ID,
    integrations.ENV_WA_VERIFY,
}


def _is_staff(actor: PortalActor) -> bool:
    """Agency staff may see which engines a preset uses; a business owner may not."""
    return actor.user is not None and actor.user.role is not UserRole.CLIENT_OWNER


async def _audit(session: AsyncSession, client: Client, actor: PortalActor, action: str, message: str, **payload: object) -> None:
    await client_service.record_audit(
        session, client, action, AuditStatus.SUCCEEDED, f"{actor.label} {message}",
        payload={"actor": actor.label, **payload},
    )


# ============================================================== business setup
@router.get("/business-setup", response_model=BusinessSetupView, summary="Business profile, policies, brand kit and FAQs")
async def get_business_setup(
    client: Client = Depends(require_tenant),
    settings: Settings = Depends(get_settings),
) -> BusinessSetupView:
    files = knowledge.files_for(settings, client)
    return await asyncio.to_thread(knowledge.read_setup, files, client)


@router.put(
    "/business-setup",
    response_model=BusinessSetupView,
    summary="Save the business setup and teach the Coordinator",
)
async def put_business_setup(
    payload: BusinessSetup,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> BusinessSetupView:
    """Store the setup, then compile it into the persona and memory the agent reads.

    The business type and brand kit are also kept on the account itself, so the roster,
    the social autopilot and this form can never disagree about them.
    """
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    view = await asyncio.to_thread(knowledge.save_setup, files, payload)
    client.business_mode = BusinessMode(view.business_mode)
    client.brand_kit_json = knowledge.brand_kit_record(view)
    # Fields and counts only: the audit trail should not hold a copy of the business's policies.
    await _audit(
        session, client, actor, "portal.business.update", "saved the business setup.",
        faqs=len(view.faqs), memory_lines_skipped=view.memory_lines_skipped,
    )
    return view


# ===================================================================== catalog
@router.get("/catalog", response_model=CatalogView, summary="Products or services with prices")
async def get_catalog(
    client: Client = Depends(require_tenant),
    settings: Settings = Depends(get_settings),
) -> CatalogView:
    files = knowledge.files_for(settings, client)
    return await asyncio.to_thread(knowledge.read_catalog, files, client)


@router.post(
    "/catalog/items",
    response_model=CatalogItem,
    status_code=status.HTTP_201_CREATED,
    summary="Add a product or service",
)
async def add_catalog_item(
    payload: CatalogItemInput,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> CatalogItem:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    item = await asyncio.to_thread(knowledge.add_item, files, client, payload)
    await _audit(session, client, actor, "portal.catalog.add", "added a catalog item.", item_id=item.id)
    return item


@router.put("/catalog/items/{item_id}", response_model=CatalogItem, summary="Change a product or service")
async def update_catalog_item(
    item_id: str,
    payload: CatalogItemInput,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> CatalogItem:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    item = await asyncio.to_thread(knowledge.update_item, files, client, item_id, payload)
    await _audit(session, client, actor, "portal.catalog.update", "changed a catalog item.", item_id=item.id)
    return item


@router.delete(
    "/catalog/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a product or service",
)
async def delete_catalog_item(
    item_id: str,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    # No return annotation: FastAPI 0.115 reads a stringified `-> None` as a response model.
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    await asyncio.to_thread(knowledge.delete_item, files, client, item_id)
    await _audit(session, client, actor, "portal.catalog.delete", "removed a catalog item.", item_id=item_id)


@router.post("/catalog/import", response_model=CatalogImportResult, summary="Bulk import from CSV or JSON rows")
async def import_catalog(
    payload: CatalogImport,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> CatalogImportResult:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)
    result = await asyncio.to_thread(knowledge.import_items, files, client, payload)
    await _audit(
        session, client, actor, "portal.catalog.import", "imported catalog items.",
        created=result.created, updated=result.updated, replace=payload.replace,
    )
    return result


# ================================================================ integrations
@router.get("/integrations", response_model=IntegrationsView, summary="Channel credentials (masked) and AI preset")
async def get_integrations(
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_tenant),
    settings: Settings = Depends(get_settings),
) -> IntegrationsView:
    files = knowledge.files_for(settings, client)
    return await asyncio.to_thread(integrations.build_view, files, client, staff=_is_staff(actor))


@router.put("/integrations", response_model=IntegrationsSaveResult, summary="Save channel credentials and the AI preset")
async def put_integrations(
    payload: IntegrationsUpdate,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    docker: DockerService = Depends(get_docker_service),
) -> IntegrationsSaveResult:
    _require_owner_authority(actor)
    files = knowledge.files_for(settings, client)

    def _apply() -> tuple[dict[str, str], list[str], set[str]]:
        env = readers.read_env(files)
        updates, changed = integrations.plan_env_changes(payload, env)
        integrations.write_env_values(files, updates)
        if payload.ai_preset is not None:
            integrations.write_model_config(files, integrations.PRESET_BY_KEY[payload.ai_preset])
            changed.append("AI preset")
        return readers.read_env(files), changed, set(updates)

    env, changed, touched = await asyncio.to_thread(_apply)
    integrations.record_channels(client, env)
    if payload.ai_preset is not None:
        # The template renders ``ai_model`` into config.yaml, so a re-provision keeps the choice.
        client.config = {
            **(client.config or {}),
            "ai_preset": payload.ai_preset,
            "ai_model": integrations.PRESET_BY_KEY[payload.ai_preset].model,
        }

    needs_restart = bool(touched & _RESTART_KEYS) or payload.ai_preset is not None
    restart, detail = "unchanged", "Saved."
    if needs_restart and payload.apply_now:
        _apply_limit.check(client.slug)
        try:
            restarted = await docker.restart(_container_name(settings, client))
        except Exception as exc:  # noqa: BLE001 - the SDK raises more than OrchestratorError here
            logger.warning("Could not restart %s: %s", client.slug, type(exc).__name__)
            restarted = False
        if restarted:
            restart, detail = "applied", "Saved. Your Coordinator is restarting and will use the new settings in about a minute."
        else:
            restart, detail = "pending", "Saved, but the Coordinator could not be restarted just now. The new settings apply at its next restart."
    elif needs_restart:
        restart, detail = "pending", "Saved. The new settings apply the next time your Coordinator restarts."

    # Which settings changed, never their values.
    await _audit(
        session, client, actor, "portal.integrations.update", "changed channel or AI settings.",
        changed=changed, restart=restart,
    )
    view = await asyncio.to_thread(integrations.build_view, files, client, staff=_is_staff(actor))
    return IntegrationsSaveResult(integrations=view, changed=changed, restart=restart, detail=detail)  # type: ignore[arg-type]


@router.post(
    "/integrations/{target}/test",
    response_model=IntegrationTestResult,
    summary="Check saved credentials against the provider",
)
async def test_integration_connection(
    target: IntegrationTarget,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    settings: Settings = Depends(get_settings),
) -> IntegrationTestResult:
    _require_owner_authority(actor)
    _test_limit.check(f"{client.slug}:{target}")
    files = knowledge.files_for(settings, client)
    env = await asyncio.to_thread(readers.read_env, files)
    return await integrations.probe_integration(target, env)


# ======================================================================= usage
@router.get("/usage", response_model=UsageSummary, summary="This month's AI usage and estimated cost")
async def usage(
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> UsageSummary:
    files = knowledge.files_for(settings, client)
    since = integrations.month_start()
    tokens = await asyncio.to_thread(integrations.read_token_usage, files, since)
    images = (
        await session.execute(
            select(func.count())
            .select_from(SocialPost)
            .where(
                SocialPost.client_id == client.id,
                SocialPost.image_filename.is_not(None),
                SocialPost.created_at >= since,
            )
        )
    ).scalar_one()
    return integrations.build_usage(client, tokens=tokens, images=int(images), staff=_is_staff(actor))
