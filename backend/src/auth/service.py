"""Accounts, one-time codes and first-run seeding. No HTTP."""

from __future__ import annotations

import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.models import Client
from ..config.settings import Settings
from .models import LoginOtp, User, UserRole
from .permissions import permissions_for
from .schemas import UserProfile, normalise_phone
from .tokens import hash_otp, hash_password, new_otp_code

logger = logging.getLogger(__name__)

#: The agency team. Passwords come from AUTH_SEED_PASSWORD, else (local installs only)
#: from ``LOCAL_DEMO_PASSWORDS`` below.
AGENCY_ACCOUNTS: tuple[tuple[str, str, UserRole], ...] = (
    ("ishtiaq@weblaud.com", "Ishtiaq", UserRole.SUPER_ADMIN),
    ("sakib@weblaud.com", "Sakib", UserRole.SUPER_ADMIN),
    ("jubayed@weblaud.com", "Jubayed", UserRole.SALES_OPS),
)
DEMO_OWNER_EMAIL = "owner@suvana.com"
DEMO_TENANT_SLUG = "suvana"
#: Every demo business owner and the tenant they are locked to.
DEMO_OWNERS: tuple[tuple[str, str, str], ...] = (
    (DEMO_OWNER_EMAIL, "Suvana Owner", DEMO_TENANT_SLUG),
    ("owner@apex-dental.com", "Apex Dental Owner", "apex-dental"),
)
#: The published sign-ins for a local developer install, so the console can be opened
#: without reading logs. Never used when ENVIRONMENT is anything but ``local``: a
#: password written in the source is known to everyone who has read it.
LOCAL_DEMO_PASSWORDS: dict[str, str] = {
    "ishtiaq@weblaud.com": "WeblaudAdmin!2026",
    "sakib@weblaud.com": "WeblaudAdmin!2026",
    "jubayed@weblaud.com": "WeblaudSales!2026",
    "owner@suvana.com": "ClientPortal!2026",
    "owner@apex-dental.com": "ClientPortal!2026",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes even from timezone-aware columns."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def get_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email.strip().lower()))
    return result.scalar_one_or_none()


async def find_by_identifier(session: AsyncSession, identifier: str) -> tuple[User | None, str]:
    """Resolve an email or WhatsApp number, reporting which channel it implies."""
    identifier = identifier.strip()
    if "@" in identifier:
        return await get_by_email(session, identifier), "email"
    try:
        phone = normalise_phone(identifier)
    except ValueError:
        return None, "whatsapp"
    result = await session.execute(select(User).where(User.phone == phone))
    return result.scalar_one_or_none(), "whatsapp"


async def client_slug_for(session: AsyncSession, user: User) -> str | None:
    if user.client_id is None:
        return None
    client = await session.get(Client, user.client_id)
    return client.slug if client else None


async def profile_of(session: AsyncSession, user: User) -> UserProfile:
    return UserProfile(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        client_id=user.client_id,
        client_slug=(slug := await client_slug_for(session, user)),
        client_subdomain=slug,
        is_active=user.is_active,
        created_at=user.created_at,
        permissions=permissions_for(user.role),
    )


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    full_name: str,
    role: UserRole,
    password: str | None = None,
    phone: str | None = None,
    client_id: uuid.UUID | None = None,
) -> User:
    user = User(
        email=email.strip().lower(),
        full_name=full_name,
        role=role,
        phone=phone,
        client_id=client_id,
        password_hash=hash_password(password) if password else None,
        is_active=True,
        token_version=0,
    )
    session.add(user)
    await session.flush()
    return user


async def ensure_client_owner(session: AsyncSession, client: Client) -> User | None:
    """Give a newly onboarded client an owner account they can use a code with.

    An address already in use is left alone rather than moved: repointing an
    existing account at this tenant would silently grant it access.
    """
    email = client.contact_email.strip().lower()
    existing = await get_by_email(session, email)
    if existing is not None:
        if existing.client_id != client.id:
            logger.info("Not linking %s: that email already has an account", client.slug)
        return existing
    return await create_user(
        session,
        email=email,
        full_name=client.company_name,
        role=UserRole.CLIENT_OWNER,
        client_id=client.id,
    )


# ------------------------------------------------------------------- one-time codes
async def issue_otp(
    session: AsyncSession, settings: Settings, user: User, channel: str
) -> str:
    """Replace any outstanding code for this user with a new one."""
    await session.execute(
        update(LoginOtp)
        .where(LoginOtp.user_id == user.id, LoginOtp.consumed_at.is_(None))
        .values(consumed_at=_now())
    )
    # A fixed code while delivery is simulated (local installs only, see
    # Settings.otp_simulate), so the demo sign-in is repeatable.
    code = settings.otp_demo_code if settings.otp_simulated else new_otp_code()
    session.add(
        LoginOtp(
            user_id=user.id,
            code_hash=hash_otp(settings, user.id, code),
            channel=channel,
            attempts=0,
            expires_at=_now() + timedelta(minutes=settings.otp_ttl_minutes),
        )
    )
    await session.flush()
    return code


async def consume_otp(
    session: AsyncSession, settings: Settings, user: User, code: str
) -> bool:
    """Whether ``code`` is the user's live code. A wrong guess spends an attempt."""
    result = await session.execute(
        select(LoginOtp)
        .where(LoginOtp.user_id == user.id, LoginOtp.consumed_at.is_(None))
        .order_by(LoginOtp.created_at.desc())
        .limit(1)
    )
    otp = result.scalar_one_or_none()
    if otp is None or _utc(otp.expires_at) <= _now() or otp.attempts >= settings.otp_max_attempts:
        return False
    if not hmac.compare_digest(otp.code_hash, hash_otp(settings, user.id, code)):
        otp.attempts += 1
        return False
    otp.consumed_at = _now()
    return True


# ------------------------------------------------------------------------- seeding
async def seed_accounts(session: AsyncSession, settings: Settings) -> list[str]:
    """Create the first accounts if the table is empty. Returns the emails created.

    AUTH_SEED_PASSWORD wins when set. Without it a local install uses the published
    demo passwords in ``LOCAL_DEMO_PASSWORDS``; anywhere else nothing is seeded,
    because a password written in the source is a credential everyone knows.
    """
    count = (await session.execute(select(func.count()).select_from(User))).scalar_one()
    if count:
        return []
    if not settings.auth_seed_password and settings.environment != "local":
        logger.error(
            "The users table is empty and AUTH_SEED_PASSWORD is not set, so no "
            "accounts were created. Set it and restart the hub to sign in."
        )
        return []

    created: list[str] = []

    def password_for(email: str) -> str:
        if settings.auth_seed_password:
            return settings.auth_seed_password
        return LOCAL_DEMO_PASSWORDS.get(email) or secrets.token_urlsafe(12)

    for email, name, role in AGENCY_ACCOUNTS:
        await create_user(
            session, email=email, full_name=name, role=role, password=password_for(email)
        )
        created.append(email)

    if settings.seed_demo:
        from ..ops.demo import seed_demo_tenants  # avoids a clients <-> ops import cycle

        tenants = await seed_demo_tenants(session, settings)
        for email, full_name, slug in DEMO_OWNERS:
            await create_user(
                session,
                email=email,
                full_name=full_name,
                role=UserRole.CLIENT_OWNER,
                client_id=tenants[slug].id,
                password=password_for(email),
            )
            created.append(email)
    return created


async def list_users(session: AsyncSession) -> list[User]:
    result = await session.execute(select(User).order_by(User.created_at))
    return list(result.scalars())


async def email_or_phone_taken(
    session: AsyncSession, email: str, phone: str | None
) -> bool:
    conditions = [User.email == email.strip().lower()]
    if phone:
        conditions.append(User.phone == phone)
    result = await session.execute(select(User.id).where(or_(*conditions)))
    return result.first() is not None
