"""The owner's view of the social autopilot, and the specialist roster.

Same tenant resolution and the same white-label rules as ``growth_router``: nothing here
names a skill directory, a file path or an operator-side error.
"""

from __future__ import annotations

import logging
import re
import uuid

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import KeyedWindow
from ..clients import service as client_service
from ..clients.models import AuditStatus, BusinessMode, Client
from ..clients.schemas import BrandKit
from ..config.database import get_session
from ..config.settings import Settings, get_settings
from ..ops import guardrails as guardrail_service
from ..ops import roster as roster_service
from ..ops import social as social_service
from ..ops.models import SocialComment, SocialPost, SocialPostStatus
from ..ops.schemas import (
    GenerateNowResponse,
    RosterAgent,
    RosterView,
    SocialAutopilotView,
    SocialCommentRead,
    SocialPostRead,
    SocialSettingsUpdate,
)
from .errors import PortalError
from .growth_router import _require_owner_authority
from .portal_router import PortalActor, require_actor, require_tenant, require_writable
from .sanitize import scrub

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/portal/{subdomain}", tags=["portal"])
#: No sign-in: Meta fetches the visual itself, so the address has to be public.
public_router = APIRouter(prefix="/public", tags=["public"])

#: Each generation can call a paid image model, so one business gets a steady trickle.
_generate_limit = KeyedWindow(12, 3600)
_IMAGE_NAME = re.compile(r"^[0-9a-f]{32}\.(png|svg)$")
_SUBDOMAIN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_HANDOFF_LABEL = {"sales-rep-inbox": "Sales Rep", "order-desk-ecommerce": "Order Desk"}
_FAILED_FOR_OWNER = "This post could not be published. The Weblaud team can see why and is on it."


def _media_missing() -> PortalError:
    return PortalError(status.HTTP_404_NOT_FOUND, "social_media_missing", "That image is not available.")


def _post_read(post: SocialPost, replies: int, settings: Settings, slug: str) -> SocialPostRead:
    return SocialPostRead(
        id=post.id,
        status=post.status.value,
        headline=scrub(post.headline),
        subtext=scrub(post.subtext),
        caption=scrub(post.caption),
        hashtags=[scrub(tag) for tag in post.hashtags or []],
        platforms=list(post.platforms or []),
        has_image=bool(post.image_filename),
        image_url=social_service.public_image_url(settings, slug, post.image_filename),
        visual_engine=post.visual_engine,
        publish_mode=post.publish_mode if post.publish_mode in {"live", "sandbox"} else None,
        permalink=post.permalink,
        reach=post.reach,
        comments_replied=replies,
        leads_captured=replies,
        error=_FAILED_FOR_OWNER if post.status is SocialPostStatus.FAILED else None,
        demo=post.demo,
        published_at=post.published_at,
        created_at=post.created_at,
    )


def _comment_read(comment: SocialComment) -> SocialCommentRead:
    return SocialCommentRead(
        id=comment.id,
        post_id=comment.post_id,
        author=scrub(comment.author),
        text=scrub(comment.text),
        public_reply=scrub(comment.public_reply),
        handoff_to=_HANDOFF_LABEL.get(comment.handoff_skill or ""),
        dm_text=scrub(comment.dm_text),
        live=comment.reply_status == "replied_live",
        sample=comment.sample,
        created_at=comment.created_at,
    )


async def _view(
    session: AsyncSession, settings: Settings, client: Client
) -> SocialAutopilotView:
    posts = await social_service.posts_for(session, client)
    counts = await social_service.comment_counts(session, client)
    comments = await social_service.comments_for(session, client)
    return SocialAutopilotView(
        autopilot_social=client.autopilot_social,
        brand_kit=BrandKit(**social_service.effective_brand_kit(client)),
        live_publishing=await social_service.live_publishing(settings, client),
        business_mode=client.business_mode.value,
        posts=[_post_read(post, counts.get(post.id, 0), settings, client.slug) for post in posts],
        comments=[_comment_read(comment) for comment in comments],
    )


@router.get(
    "/social-autopilot",
    response_model=SocialAutopilotView,
    summary="Posts, comment conversations and settings",
)
async def social_autopilot(
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SocialAutopilotView:
    return await _view(session, settings, client)


@router.patch(
    "/social-autopilot/settings",
    response_model=SocialAutopilotView,
    summary="Zero-touch or one-tap approval, and the brand kit",
)
async def update_social_settings(
    payload: SocialSettingsUpdate,
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SocialAutopilotView:
    _require_owner_authority(actor)
    changed: list[str] = []
    if payload.autopilot_social is not None and payload.autopilot_social != client.autopilot_social:
        guardrail_service.set_lane(
            client, guardrail_service.SOCIAL_LANE_KEY, "automatic" if payload.autopilot_social else "owner"
        )
        changed.append("autopilot")
    if payload.brand_kit is not None:
        client.brand_kit_json = payload.brand_kit.model_dump()
        changed.append("brand kit")
    if changed:
        await client_service.record_audit(
            session, client, "portal.social.settings", AuditStatus.SUCCEEDED,
            f"{actor.label} changed the social {' and '.join(changed)}.",
            payload={"actor": actor.label, "autopilot_social": client.autopilot_social},
        )
    return await _view(session, settings, client)


_MESSAGES = {
    "in_qa_review": "Post created. While your account is in Shadow Week, the Weblaud team reviews it first.",
    "awaiting_owner": "Post created. It is waiting for your one-tap approval in the Approvals tab.",
    "failed": _FAILED_FOR_OWNER,
}


@router.post(
    "/social-autopilot/generate-now",
    response_model=GenerateNowResponse,
    summary="Make a branded post now, and publish it unless a person has to look first",
)
async def generate_now(
    actor: PortalActor = Depends(require_actor),
    client: Client = Depends(require_writable),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> GenerateNowResponse:
    _require_owner_authority(actor)
    _generate_limit.check(client.slug)
    try:
        result = await social_service.generate_now(session, settings, client)
    except social_service.SocialError as exc:
        logger.warning("Social generation failed for %s: %s", client.slug, exc)
        raise PortalError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "social_unavailable",
            "We could not make your post right now. Please try again shortly.",
        ) from exc

    if result.outcome == "published":
        live = result.post.publish_mode == "live"
        message = (
            "Published to your connected accounts."
            if live
            else "Post created in sandbox mode: no Meta account is connected for this business "
            "yet, so nothing was posted publicly."
        )
    else:
        message = _MESSAGES[result.outcome]
    if result.outcome == "failed":
        logger.warning("Publishing failed for %s: %s", client.slug, result.post.error)
    await client_service.record_audit(
        session, client, "portal.social.generate", AuditStatus.SUCCEEDED,
        f"{actor.label} generated a post: {result.outcome}.",
        payload={"actor": actor.label, "post_id": str(result.post.id), "outcome": result.outcome},
    )
    return GenerateNowResponse(
        outcome=result.outcome,  # type: ignore[arg-type]
        message=message,
        post=_post_read(result.post, len(result.comments), settings, client.slug),
        comments=[_comment_read(comment) for comment in result.comments],
    )


@router.get("/social-autopilot/media/{post_id}", summary="The post's visual")
async def media(
    post_id: uuid.UUID,
    client: Client = Depends(require_tenant),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    post = (
        await session.execute(
            select(SocialPost).where(SocialPost.id == post_id, SocialPost.client_id == client.id)
        )
    ).scalar_one_or_none()
    name = post.image_filename if post else None
    path = social_service.media_dir(settings, client.slug) / name if name else None
    if post is None or not name or not _IMAGE_NAME.fullmatch(name) or path is None or not path.is_file():
        raise PortalError(status.HTTP_404_NOT_FOUND, "social_media_missing", "That image is not available.")
    return FileResponse(
        path,
        media_type="image/png" if name.endswith(".png") else "image/svg+xml",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            "Cache-Control": "private, max-age=3600",
        },
    )


@public_router.get(
    "/media/{subdomain}/{filename}",
    summary="A generated post visual, for Meta and for the portal to display",
)
async def public_media(
    subdomain: str,
    filename: str,
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """Both parts are matched against a strict pattern before they touch the filesystem,
    so there is no way to name a path outside one tenant's visuals folder.

    The names are 128 random bits, written by the hub and never by the tenant's agent, so
    an address is only known to whoever the hub or the owner gave it to.
    """
    if not _SUBDOMAIN.fullmatch(subdomain) or not _IMAGE_NAME.fullmatch(filename):
        raise _media_missing()
    folder = social_service.media_dir(settings, subdomain)
    path = folder / filename
    try:
        inside = path.resolve().parent == folder.resolve()
    except OSError:
        inside = False
    if not inside or path.is_symlink() or not path.is_file():
        raise _media_missing()
    return FileResponse(
        path,
        media_type="image/png" if filename.endswith(".png") else "image/svg+xml",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            # The portal and Meta's crawler are both other origins.
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.get("/roster", response_model=RosterView, summary="The specialist team behind this business")
async def roster(
    client: Client = Depends(require_tenant),
    settings: Settings = Depends(get_settings),
) -> RosterView:
    have = roster_service.active_skills(settings, client)
    rosters: dict[str, list[RosterAgent]] = {}
    for mode in (BusinessMode.GENERAL, BusinessMode.ECOMMERCE):
        rosters[mode.value] = [
            RosterAgent(
                key=agent.key,
                name=agent.name,
                role=agent.role,
                ecommerce_only=agent.ecommerce_only,
                # Only the business's own model is "active": the other roster is a preview.
                active=mode is client.business_mode and agent.skill in have,
            )
            for agent in roster_service.roster_for(mode)
        ]
    return RosterView(business_mode=client.business_mode.value, rosters=rosters)
