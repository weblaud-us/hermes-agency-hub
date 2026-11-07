"""The zero-touch social autopilot: compose a post, render it, publish it, answer its comments.

The two scripts under ``shared-skills/social-media-autopilot/scripts`` do the rendering
and the Meta calls. The hub runs them as subprocesses, with a minimal environment, so
the same code a tenant's agent runs is what the owner's "Generate now" button runs.

A new post goes through the same approval state machine as everything else
(``ops.approvals``), which is what keeps Shadow Week honest:

* Autonomous Live and the autopilot on: approved on the spot, published at once.
* Autonomous Live and the autopilot off: waits for the owner's one tap.
* Before Autonomous Live: waits for Weblaud's QA team first, whatever the switch says.

With no Meta credentials for the tenant, publishing is a sandbox. The script returns a
receipt for what it would have posted and nothing leaves the building; the post is marked
``sandbox`` so the portal never presents it as live. Reach is stored as unknown rather
than guessed, since nothing here reads Meta's insights yet.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.models import BusinessMode, Client, NicheTemplate
from ..config.settings import Settings
from . import approvals as approval_service
from .models import (
    ApprovalItem,
    ApprovalKind,
    ApprovalStatus,
    SocialComment,
    SocialPost,
    SocialPostStatus,
)

logger = logging.getLogger(__name__)

SKILL = "social-media-autopilot"
DEFAULT_PLATFORMS = ["facebook", "instagram"]
DEFAULT_BRAND_KIT: dict[str, Any] = {
    "primary_color": "#00F5D4",
    "accent_color": "#6366F1",
    "logo_text": "",
    "contact_cta": "Book / Order via WhatsApp or DM",
    "website_url": None,
}
_ENV_PASSTHROUGH = ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "LANG", "LC_ALL")


class SocialError(RuntimeError):
    """A script failed or produced nothing usable."""


# ---------------------------------------------------------------------------- brand
def effective_brand_kit(client: Client) -> dict[str, Any]:
    """The client's brand kit with every gap filled, so a script never sees a hole."""
    kit = {**DEFAULT_BRAND_KIT, **{k: v for k, v in (client.brand_kit_json or {}).items() if v}}
    if not kit["logo_text"]:
        kit["logo_text"] = client.company_name.strip().upper()[:24]
    return kit


# -------------------------------------------------------------------------- content
@dataclass(frozen=True)
class SampleComment:
    author: str
    text: str
    public_reply: str
    dm_text: str


@dataclass(frozen=True)
class Topic:
    headline: str
    subtext: str
    prompt: str
    caption: str
    hashtags: tuple[str, ...]
    comments: tuple[SampleComment, ...]


def _service_comment(author: str, text: str) -> SampleComment:
    return SampleComment(
        author,
        text,
        "Thanks for asking! We have just sent you the details in a private message.",
        "Hi! Thanks for your comment. Here are the details you asked about. "
        "Reply with the day or date that suits you and we will take care of the rest.",
    )


def _shop_comment(author: str, text: str) -> SampleComment:
    return SampleComment(
        author,
        text,
        "Good question! We have just sent you a private message with the answer.",
        "Hi! Thanks for your comment. I am checking stock for you now. "
        "Tell me your size and delivery address and I will reserve it.",
    )


_TOPICS: dict[str, tuple[Topic, ...]] = {
    "dental_clinic": (
        Topic(
            "Brighter smiles start here",
            "Ask about our whitening package",
            "A bright, modern dental clinic with a smiling patient, clean white tones",
            "A confident smile changes everything. Our whitening package is gentle, quick and "
            "done by the same dentist who knows your teeth. Message us to see this week's openings.",
            ("#dentist", "#teethwhitening", "#smile", "#dentalcare", "#healthysmile"),
            (
                _service_comment("Maya R.", "How much is the Teeth Whitening package?"),
                _service_comment("Daniel K.", "Do you have anything open on Saturday?"),
            ),
        ),
        Topic(
            "Fear of the dentist? Same.",
            "Gentle check-ups, no pressure",
            "A calm dental treatment room with soft natural light",
            "Most of our patients were nervous once. We go slowly, explain every step and never "
            "rush you. Book a gentle first visit by sending us a message.",
            ("#dentist", "#anxietyfree", "#checkup", "#familydentist", "#oralhealth"),
            (_service_comment("Priya S.", "Do you take kids for first visits?"),),
        ),
    ),
    "beauty_salon": (
        Topic(
            "Your best hair day, booked",
            "Colour and styling this week",
            "A stylish beauty salon interior with soft pink lighting and a styled client",
            "Fresh colour, a clean cut, and an hour that is entirely yours. Send us a message to "
            "grab a time before the weekend fills up.",
            ("#salon", "#haircolor", "#beauty", "#selfcare", "#hairstylist"),
            (
                _service_comment("Sara L.", "How much is balayage?"),
                _service_comment("Nora T.", "Can I book for this Friday evening?"),
            ),
        ),
    ),
    "restaurant": (
        Topic(
            "Tonight's table is waiting",
            "Chef's special, one night only",
            "A warmly lit restaurant table with a beautifully plated signature dish",
            "Tonight's special is something the kitchen has been planning all week. Message us to "
            "reserve a table, we will hold it for you.",
            ("#restaurant", "#dinner", "#foodie", "#chefspecial", "#localeats"),
            (
                _service_comment("Omar H.", "Is there a table for four at 8?"),
                _service_comment("Lena W.", "Do you have vegetarian options on the special?"),
            ),
        ),
    ),
    "travel_agency": (
        Topic(
            "Your next escape, handled",
            "Custom trips, one message away",
            "A scenic travel destination at golden hour with a passport and suitcase",
            "Flights, stays and the small details that make a trip easy. Tell us where and when "
            "and we will come back with options that fit your budget.",
            ("#travel", "#holiday", "#traveltips", "#getaway", "#wanderlust"),
            (
                _service_comment("Hannah B.", "How much for a week in Lisbon in May?"),
                _service_comment("Ravi M.", "Do you do family packages?"),
            ),
        ),
    ),
    "ecommerce_store": (
        Topic(
            "New arrivals, just landed",
            "Limited stock, order by message",
            "A clean studio flat-lay of new fashion arrivals on a dark backdrop",
            "The new drop is here and the popular sizes go first. Message us the item and your "
            "size and we will confirm your order and delivery straight away.",
            ("#newarrivals", "#shopsmall", "#ootd", "#newdrop", "#orderonline"),
            (
                _shop_comment("Alex P.", "Do you have Size L in stock?"),
                _shop_comment("Imani C.", "Can I pay on delivery?"),
            ),
        ),
        Topic(
            "Back in stock: the one you asked for",
            "Restocked today, selling fast",
            "A premium product shot on a dark studio set with dramatic rim lighting",
            "You asked, we restocked. Send us a message with your size and we will hold one "
            "for you while stock lasts.",
            ("#restock", "#backinstock", "#shopnow", "#fashion", "#dtc"),
            (_shop_comment("Jordan F.", "Is the navy one back in medium?"),),
        ),
    ),
    "custom": (
        Topic(
            "One partner. One growth system.",
            "Message us to get started",
            "A modern small business storefront with warm welcoming light",
            "Every message answered, every lead followed up. Send us a message and we will show "
            "you how we can help your business this week.",
            ("#smallbusiness", "#shoplocal", "#growth", "#customerservice", "#supportlocal"),
            (
                _service_comment("Chris D.", "How much does it cost?"),
                _service_comment("Amina Z.", "Are you open on weekends?"),
            ),
        ),
    ),
}


def _topics_for(client: Client) -> tuple[Topic, ...]:
    niche = client.niche_template.value if isinstance(client.niche_template, NicheTemplate) else "custom"
    if niche in _TOPICS:
        return _TOPICS[niche]
    return _TOPICS["ecommerce_store" if client.business_mode is BusinessMode.ECOMMERCE else "custom"]


def _money(price: float) -> str:
    return f"${price:,.2f}".replace(".00", "") if price == int(price) else f"${price:,.2f}"


def _offer_text(item: Any) -> str:
    """The pill on the visual: the price and the one fact most likely to start a message."""
    parts = [_money(item.price_usd) if item.price_usd > 0 else "Message us for pricing"]
    if item.kind == "service" and item.duration:
        parts.append(item.duration)
    elif item.kind == "product":
        if item.stock_qty is not None and 0 < item.stock_qty <= 10:
            parts.append(f"Only {item.stock_qty} left")
        elif item.sizes_or_variants:
            parts.append(f"{len(item.sizes_or_variants)} options")
    return " · ".join(parts)[:80]


def _hashtags_for(item: Any, industry: str) -> tuple[str, ...]:
    words = re.findall(r"[A-Za-z]{4,}", f"{industry} {item.name}")
    tags = list(dict.fromkeys(f"#{word.lower()}" for word in words))[:4]
    return tuple([*tags, "#smallbusiness"])


def catalog_topic(client: Client, profile: Any, item: Any) -> Topic:
    """A post about one real item from the tenant's own price list.

    Everything quoted here, the price, the duration, the booking rules, is read from
    ``catalog.json``, so a sample reply can only state what the business published.
    """
    industry = profile.industry if profile else ""
    offer = _offer_text(item)
    detail = item.description or (profile.tagline if profile else "")
    hours = f" Open {profile.business_hours}." if profile and profile.business_hours else ""
    caption = f"{item.name}: {offer}. {detail}".strip() + hours
    price = _money(item.price_usd) if item.price_usd > 0 else "priced on request"

    if item.kind == "product":
        options = f" Available in {', '.join(item.sizes_or_variants)}." if item.sizes_or_variants else ""
        dm = (
            f"Hi! {item.name} is {price}.{options} Tell me your size and delivery address "
            "and I will reserve one for you."
        )
        comments = (
            SampleComment("Alex P.", f"How much is the {item.name}?", "Good question! We have just sent you a private message with the details.", dm),
            SampleComment("Imani C.", f"Do you still have the {item.name}?", "Yes, and we have just sent you the details in a private message.", dm),
        )
    else:
        rules = item.booking_rules or "Reply with the day or date that suits you and we will take care of the rest."
        dm = f"Hi! {item.name} is {price}{f' and takes {item.duration}' if item.duration else ''}. {rules}"
        comments = (
            SampleComment("Maya R.", f"How much is {item.name}?", "Thanks for asking! We have just sent you the details in a private message.", dm),
            SampleComment("Daniel K.", f"Can I book {item.name} this week?", "Of course! We have just sent you the details in a private message.", dm),
        )
    return Topic(
        headline=item.name[:80],
        subtext=offer,
        prompt=f"{item.name}. {item.description}".strip()[:300] + (f", for a {industry} business" if industry else ""),
        caption=caption[:900],
        hashtags=_hashtags_for(item, industry),
        comments=comments,
    )


def _catalog_context(settings: Settings, client: Client) -> tuple[list[Any], Any]:
    """The tenant's publishable items and business profile. Blocks on file reads."""
    from ..portal import knowledge  # portal imports ops, so not at module level
    from ..portal.errors import PortalError

    files = knowledge.files_for(settings, client)
    try:
        return knowledge.read_publishable_items(files, client), knowledge.read_profile_for_posts(files)
    except PortalError:
        return [], None


def handoff_skill_for(client: Client) -> str:
    return "order-desk-ecommerce" if client.business_mode is BusinessMode.ECOMMERCE else "sales-rep-inbox"


# --------------------------------------------------------------------------- scripts
def media_dir(settings: Settings, slug: str) -> Path:
    assert settings.social_media_dir is not None  # set by Settings._derive_paths
    return settings.social_media_dir / slug


@dataclass(frozen=True)
class MetaCredentials:
    page_id: str
    page_token: str
    ig_user_id: str


def meta_credentials(settings: Settings, client: Client) -> MetaCredentials | None:
    """The Facebook Page this tenant may publish to, or ``None`` for the sandbox.

    The tenant's own ``.env`` comes first: credentials the owner saved in the portal can
    only ever reach that owner's page. The hub-wide credentials are the older fallback
    and belong to exactly one tenant, ``META_LIVE_TENANT``, so one client's posts can
    never land on another client's page. Blocks on a file read.
    """
    from ..portal import integrations, readers  # portal imports ops, so not at module level
    from ..portal.errors import PortalError

    try:
        env = readers.read_env(readers.files_for(settings, client))
    except PortalError:
        env = {}
    page_id, token, ig_id = integrations.meta_values(env)
    if page_id and token:
        return MetaCredentials(page_id, token, ig_id)
    if (
        settings.meta_page_access_token
        and settings.meta_page_id
        and settings.meta_live_tenant
        and settings.meta_live_tenant == client.slug
    ):
        return MetaCredentials(settings.meta_page_id, settings.meta_page_access_token, settings.meta_ig_user_id)
    return None


async def live_publishing(settings: Settings, client: Client) -> bool:
    return await asyncio.to_thread(meta_credentials, settings, client) is not None


def _script_env(settings: Settings, creds: MetaCredentials | None) -> dict[str, str]:
    """A minimal environment for a script. Meta credentials are included only when given."""
    env = {key: os.environ[key] for key in _ENV_PASSTHROUGH if key in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    if settings.openai_api_key:
        env["OPENAI_API_KEY"] = settings.openai_api_key
    if creds is not None:
        env["META_PAGE_ACCESS_TOKEN"] = creds.page_token
        env["META_PAGE_ID"] = creds.page_id
        if creds.ig_user_id:
            env["META_IG_USER_ID"] = creds.ig_user_id
    return env


def _run_script_sync(
    settings: Settings, script: str, args: list[str], env: dict[str, str]
) -> dict[str, Any]:
    path = settings.shared_skills_dir / SKILL / "scripts" / script
    if not path.is_file():
        raise SocialError(f"{script} is missing from the skill library.")
    # An argument list, never a shell string: captions are owner- and model-written text.
    completed = subprocess.run(  # noqa: S603
        [sys.executable, "-I", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=settings.social_script_timeout_seconds,
        env=env,
        check=False,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if completed.returncode != 0 or not lines:
        tail = (completed.stderr or completed.stdout or "no output").strip().splitlines()[-1:]
        raise SocialError(f"{script} failed: {(tail[0] if tail else 'no output')[:300]}")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise SocialError(f"{script} printed something that is not JSON.") from exc


async def _run_script(
    settings: Settings, script: str, args: list[str], env: dict[str, str]
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_run_script_sync, settings, script, args, env)
    except subprocess.TimeoutExpired as exc:
        raise SocialError(f"{script} timed out.") from exc


# ----------------------------------------------------------------------- the pipeline
@dataclass
class GenerateResult:
    post: SocialPost
    approval: ApprovalItem
    comments: list[SocialComment]
    #: ``published`` | ``awaiting_owner`` | ``in_qa_review`` | ``failed``
    outcome: str


def _outcome(post: SocialPost, approval: ApprovalItem) -> str:
    if post.status is SocialPostStatus.PUBLISHED:
        return "published"
    if post.status is SocialPostStatus.FAILED:
        return "failed"
    return "in_qa_review" if approval.status is ApprovalStatus.QA_REVIEW else "awaiting_owner"


async def post_count(session: AsyncSession, client: Client) -> int:
    return (
        await session.execute(
            select(func.count()).select_from(SocialPost).where(SocialPost.client_id == client.id)
        )
    ).scalar_one()


async def generate_now(session: AsyncSession, settings: Settings, client: Client) -> GenerateResult:
    count = await post_count(session, client)
    items, profile = await asyncio.to_thread(_catalog_context, settings, client)
    if items:
        topic = catalog_topic(client, profile, items[count % len(items)])
    else:
        topics = _topics_for(client)
        topic = topics[count % len(topics)]
    brand = effective_brand_kit(client)
    if profile is not None:
        # The business profile is where the owner edits the kit, so it wins over the copy
        # kept on the account if the two ever drift apart.
        kit = profile.brand_kit
        brand = {
            **brand,
            "primary_color": kit.primary_color,
            "accent_color": kit.accent_color,
            "logo_text": kit.logo_text or brand["logo_text"],
            "contact_cta": kit.default_cta,
        }

    post_id = uuid.uuid4()
    out_dir = media_dir(settings, client.slug)
    out_dir.mkdir(parents=True, exist_ok=True)
    visual = await _run_script(
        settings,
        "generate_social_visual.py",
        [
            "--brand", brand["logo_text"][:18],
            "--mode", client.business_mode.value,
            "--prompt", topic.prompt,
            "--headline", topic.headline,
            "--subtext", topic.subtext,
            "--cta", brand["contact_cta"],
            "--primary-color", brand["primary_color"],
            "--accent-color", brand["accent_color"],
            "--output", str(out_dir / f"{post_id.hex}.png"),
        ],
        _script_env(settings, None),
    )
    image = Path(str(visual.get("output_path", "")))
    if image.parent.resolve() != out_dir.resolve() or not image.is_file():
        raise SocialError("The visual generator did not write where it was told to.")

    hashtags = list(topic.hashtags)
    post = SocialPost(
        id=post_id,
        client_id=client.id,
        status=SocialPostStatus.AWAITING_APPROVAL,
        headline=topic.headline,
        subtext=topic.subtext,
        caption=f"{topic.caption}\n\n{brand['contact_cta']}",
        hashtags=hashtags,
        platforms=list(DEFAULT_PLATFORMS),
        image_filename=image.name,
        visual_engine=str(visual.get("engine", ""))[:48] or None,
        demo=False,
    )
    session.add(post)
    await session.flush()

    approval = await approval_service.create_item(
        session,
        client,
        kind=ApprovalKind.SOCIAL_POST,
        title=topic.headline,
        summary=f"Branded post for {', '.join(DEFAULT_PLATFORMS)}, made by the social autopilot.",
        preview={
            "body": f"{post.caption}\n\n{' '.join(hashtags)}",
            "channel": ", ".join(DEFAULT_PLATFORMS),
            "social_post_id": str(post.id),
        },
        source_skill=SKILL,
    )
    post.approval_id = approval.id

    comments: list[SocialComment] = []
    if approval.status is ApprovalStatus.APPROVED:
        comments = await publish(session, settings, client, post, topic)
    await session.flush()
    return GenerateResult(post=post, approval=approval, comments=comments, outcome=_outcome(post, approval))


async def publish(
    session: AsyncSession,
    settings: Settings,
    client: Client,
    post: SocialPost,
    topic: Topic | None = None,
) -> list[SocialComment]:
    """Publish an approved post. Returns the sandbox sample comments it produced."""
    creds = await asyncio.to_thread(meta_credentials, settings, client)
    live = creds is not None
    base = settings.social_public_base_url.rstrip("/")
    image_ref = (
        f"{base}/{client.slug}/{post.image_filename}"
        if live and base
        else str(media_dir(settings, client.slug) / (post.image_filename or ""))
    )
    try:
        receipt = await _run_script(
            settings,
            "meta_publisher.py",
            ["publish", "--image", image_ref, "--caption", f"{post.caption}\n\n{' '.join(post.hashtags)}",
             "--platforms", ",".join(post.platforms)],
            _script_env(settings, creds),
        )
    except SocialError as exc:
        post.status = SocialPostStatus.FAILED
        post.error = str(exc)
        return []

    status = str(receipt.get("status", ""))
    if status == "published_live":
        platforms = receipt.get("platforms") or {}
        first = next((v for v in platforms.values() if isinstance(v, dict)), {})
        post.publish_mode = "live"
        post.external_id = str(first.get("post_id") or first.get("id") or "")[:120] or None
        post.permalink = f"https://facebook.com/{post.external_id}" if post.external_id else None
    elif status == "published_simulated":
        post.publish_mode = "sandbox"
        post.external_id = str(receipt.get("post_id", ""))[:120] or None
        post.permalink = str(receipt.get("permalink", ""))[:500] or None
    else:
        post.status = SocialPostStatus.FAILED
        post.error = f"Unexpected publish status: {status[:60] or 'none'}."
        return []
    post.status = SocialPostStatus.PUBLISHED
    post.published_at = datetime.now(timezone.utc)
    post.error = None

    if post.publish_mode != "sandbox":
        return []  # live comments arrive from Meta, and nothing here receives them yet
    return await _sandbox_conversation(session, settings, client, post, topic)


async def _sandbox_conversation(
    session: AsyncSession,
    settings: Settings,
    client: Client,
    post: SocialPost,
    topic: Topic | None,
) -> list[SocialComment]:
    """Sample comments, each answered through the same script a live reply uses.

    Marked ``sample`` so the portal labels them: they show what the autopilot would do
    with a real comment, and are not customers.
    """
    if topic is None:
        topic = next((t for t in _topics_for(client) if t.headline == post.headline), None)
    if topic is None:
        return []
    handoff = handoff_skill_for(client)
    made: list[SocialComment] = []
    for sample in topic.comments:
        try:
            receipt = await _run_script(
                settings,
                "meta_publisher.py",
                ["reply-comment", "--comment-id", f"sample_{uuid.uuid4().hex[:12]}",
                 "--public-reply", sample.public_reply, "--private-dm", sample.dm_text],
                _script_env(settings, None),
            )
        except SocialError as exc:
            logger.warning("Sample reply failed for %s: %s", client.slug, exc)
            continue
        comment = SocialComment(
            client_id=client.id,
            post_id=post.id,
            author=sample.author,
            text=sample.text,
            public_reply=sample.public_reply,
            handoff_skill=handoff,
            dm_text=sample.dm_text,
            reply_status=str(receipt.get("status", "replied_simulated"))[:24],
            sample=True,
        )
        session.add(comment)
        made.append(comment)
    await session.flush()
    return made


async def on_owner_decision(
    session: AsyncSession, settings: Settings, client: Client, item: ApprovalItem
) -> SocialPost | None:
    """Carry an owner's decision on a social approval over to its post."""
    if item.kind is not ApprovalKind.SOCIAL_POST:
        return None
    raw = (item.preview or {}).get("social_post_id")
    try:
        post_id = uuid.UUID(str(raw))
    except ValueError:
        return None
    post = (
        await session.execute(
            select(SocialPost).where(SocialPost.id == post_id, SocialPost.client_id == client.id)
        )
    ).scalar_one_or_none()
    if post is None or post.status is not SocialPostStatus.AWAITING_APPROVAL:
        return post
    if item.status is ApprovalStatus.APPROVED:
        await publish(session, settings, client, post)
    elif item.status is ApprovalStatus.REJECTED:
        post.status = SocialPostStatus.REJECTED
    await session.flush()
    return post


async def posts_for(session: AsyncSession, client: Client, limit: int = 24) -> list[SocialPost]:
    result = await session.execute(
        select(SocialPost)
        .where(SocialPost.client_id == client.id)
        .order_by(SocialPost.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def comments_for(session: AsyncSession, client: Client, limit: int = 40) -> list[SocialComment]:
    result = await session.execute(
        select(SocialComment)
        .where(SocialComment.client_id == client.id)
        .order_by(SocialComment.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def comment_counts(session: AsyncSession, client: Client) -> dict[uuid.UUID, int]:
    result = await session.execute(
        select(SocialComment.post_id, func.count())
        .where(SocialComment.client_id == client.id)
        .group_by(SocialComment.post_id)
    )
    return {post_id: count for post_id, count in result.all()}
