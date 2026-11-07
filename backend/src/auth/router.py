"""Sign-in, sign-out and account management."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..clients.models import Client
from ..config.database import get_session
from ..config.settings import Settings, get_settings
from . import service
from .dependencies import (
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    FailureLimiter,
    KeyedWindow,
    client_ip,
    current_user,
    load_session_user,
    require_permission,
)
from .models import User, UserRole
from .permissions import Permission
from .schemas import (
    ChangePasswordRequest,
    LoginRequest,
    MagicOtpRequest,
    OtpRequested,
    SessionResponse,
    UserCreate,
    UserProfile,
    UserUpdate,
)
from .tokens import hash_password, issue_session_token, verify_password

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

#: Five wrong guesses per 15 minutes, per address and per caller. Correct sign-ins cost nothing.
_login_limit = FailureLimiter(5, 900)
_otp_request_limit = KeyedWindow(3, 300)
_otp_verify_limit = FailureLimiter(5, 900)
_password_limit = KeyedWindow(5, 300)

_BAD_LOGIN = "That email and password do not match."
_BAD_CODE = "That code is not valid. Check it, or request a new one."


def _set_session_cookies(
    response: Response, settings: Settings, access: tuple[str, int], refresh: tuple[str, int]
) -> None:
    # SameSite=Lax is the CSRF defence: a cross-site POST carries neither cookie.
    # Path=/ because the website forwards these from its own origin, under a
    # different path than the hub's.
    for name, (value, max_age) in ((ACCESS_COOKIE, access), (REFRESH_COOKIE, refresh)):
        response.set_cookie(
            name,
            value,
            max_age=max_age,
            httponly=True,
            samesite="lax",
            secure=settings.secure_cookies,
            path="/",
        )


def _clear_session_cookies(response: Response, settings: Settings) -> None:
    for name in (ACCESS_COOKIE, REFRESH_COOKIE):
        response.delete_cookie(
            name, path="/", httponly=True, samesite="lax", secure=settings.secure_cookies
        )


async def _open_session(
    session: AsyncSession, settings: Settings, user: User, response: Response
) -> SessionResponse:
    profile = await service.profile_of(session, user)
    access = issue_session_token(settings, user, "access", client_slug=profile.client_slug)
    refresh = issue_session_token(settings, user, "refresh", client_slug=profile.client_slug)
    _set_session_cookies(response, settings, access, refresh)
    return SessionResponse(
        access_token=access[0], refresh_token=refresh[0], expires_in=access[1], user=profile
    )


@router.post("/login", response_model=SessionResponse, summary="Sign in with a password")
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    email = str(payload.email).lower()
    by_email, by_ip = f"email:{email}", f"ip:{client_ip(request, settings)}"
    _login_limit.check(by_email, by_ip)
    user = await service.get_by_email(session, email)
    # Verified even with no account, so the answer takes the same time either way.
    password_ok = verify_password(payload.password, user.password_hash if user else None)
    if user is None or not password_ok or not user.is_active:
        _login_limit.record_failure(by_email, by_ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=_BAD_LOGIN)
    if payload.subdomain:
        slug = await service.client_slug_for(session, user)
        if not _owner_of_subdomain(user, slug, payload.subdomain):
            _login_limit.record_failure(by_email, by_ip)
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=_BAD_LOGIN)
    # Only the address is cleared: signing in to your own account must not wipe the
    # caller's record of guesses against other people's.
    _login_limit.reset(by_email)
    return await _open_session(session, settings, user, response)


def _owner_of_subdomain(user: User | None, client_slug: str | None, subdomain: str | None) -> bool:
    """Whether ``user`` may use a code for the portal named ``subdomain``."""
    if not subdomain:
        return True
    return user is not None and user.role is UserRole.CLIENT_OWNER and client_slug == subdomain.strip().lower()


def _require_otp_delivery(settings: Settings) -> None:
    if not settings.otp_simulated:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="One-time codes are not available yet. Sign in with your password.",
        )


async def _send_code(
    payload: MagicOtpRequest, session: AsyncSession, settings: Settings
) -> OtpRequested:
    key = payload.identifier.strip().lower()
    user, channel = await service.find_by_identifier(session, payload.identifier)
    slug = await service.client_slug_for(session, user) if user else None
    usable = user is not None and user.is_active and _owner_of_subdomain(user, slug, payload.subdomain)
    _otp_request_limit.check(key)
    code = await service.issue_otp(session, settings, user, channel) if usable else None
    return OtpRequested(
        channel=channel,
        expires_in=settings.otp_ttl_minutes * 60,
        simulated_code=code,
        detail=f"If that account exists, a code was sent by {channel}.",
    )


async def _check_code(
    payload: MagicOtpRequest,
    code: str,
    request: Request,
    response: Response,
    session: AsyncSession,
    settings: Settings,
) -> SessionResponse:
    key = payload.identifier.strip().lower()
    user, _ = await service.find_by_identifier(session, payload.identifier)
    slug = await service.client_slug_for(session, user) if user else None
    usable = user is not None and user.is_active and _owner_of_subdomain(user, slug, payload.subdomain)
    by_identifier, by_ip = f"identifier:{key}", f"ip:{client_ip(request, settings)}"
    _otp_verify_limit.check(by_identifier, by_ip)
    if not usable or not await service.consume_otp(session, settings, user, code):
        _otp_verify_limit.record_failure(by_identifier, by_ip)
        # Kept: a wrong guess has to count even though this request fails.
        await session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=_BAD_CODE)
    _otp_verify_limit.reset(by_identifier)
    return await _open_session(session, settings, user, response)


@router.post(
    "/magic-otp/request",
    response_model=OtpRequested,
    summary="Send a six-digit login code",
)
async def magic_otp_request(
    payload: MagicOtpRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> OtpRequested:
    """Delivery is simulated: no WhatsApp or email provider is wired up yet, so a
    local install returns the code in the response, and anywhere else this route
    refuses with 503 rather than pretending to have sent something.

    An unknown identifier gets the same answer as a known one, so this cannot be
    used to discover who is a client.
    """
    _require_otp_delivery(settings)
    return await _send_code(payload, session, settings)


@router.post(
    "/magic-otp/verify",
    response_model=SessionResponse,
    summary="Sign in with a six-digit code",
)
async def magic_otp_verify(
    payload: MagicOtpRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    _require_otp_delivery(settings)
    if payload.code is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="code is required.")
    return await _check_code(payload, payload.code, request, response, session, settings)


@router.post(
    "/magic-otp",
    response_model=SessionResponse | OtpRequested,
    summary="Request a six-digit login code, or sign in with one",
)
async def magic_otp(
    payload: MagicOtpRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionResponse | OtpRequested:
    """Without ``code``, sends one. With it, signs in. Kept for existing callers;
    ``/magic-otp/request`` and ``/magic-otp/verify`` are the same thing, split."""
    _require_otp_delivery(settings)
    if payload.code is None:
        return await _send_code(payload, session, settings)
    return await _check_code(payload, payload.code, request, response, session, settings)


@router.post("/refresh", response_model=SessionResponse, summary="Renew a session")
async def refresh(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionResponse | JSONResponse:
    token = request.cookies.get(REFRESH_COOKIE)
    user = await load_session_user(session, settings, token, "refresh") if token else None
    if user is None:
        # Returned, not raised: an HTTPException would drop the cookie deletion,
        # and a dead cookie left behind would keep sending the route guard here.
        expired = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Your session has ended. Sign in again."},
        )
        _clear_session_cookies(expired, settings)
        return expired
    return await _open_session(session, settings, user, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Sign out")
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Revokes every token this user holds, on every device.

    Idempotent and open to expired sessions: someone signing out should always
    end up signed out, and the refresh cookie still says who they were.
    """
    for name, kind in ((ACCESS_COOKIE, "access"), (REFRESH_COOKIE, "refresh")):
        token = request.cookies.get(name)
        user = await load_session_user(session, settings, token, kind) if token else None
        if user is not None:
            user.token_version += 1
            break
    response.status_code = status.HTTP_204_NO_CONTENT
    _clear_session_cookies(response, settings)
    return response


@router.get("/me", response_model=UserProfile, summary="The signed-in user")
async def me(
    user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> UserProfile:
    return await service.profile_of(session, user)


@router.post(
    "/change-password", response_model=SessionResponse, summary="Change your own password"
)
async def change_password(
    payload: ChangePasswordRequest,
    response: Response,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionResponse:
    """Signs out every other device, and renews this one."""
    _password_limit.check(str(user.id))
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Your current password is not correct.")
    user.password_hash = hash_password(payload.new_password)
    user.token_version += 1
    await session.flush()
    return await _open_session(session, settings, user, response)


# ------------------------------------------------------------ account management
def _check_owner_link(role: UserRole, client_id: uuid.UUID | None) -> None:
    # An owner with no tenant could read nothing; staff with one would be
    # scoped to it by nothing. Both are mistakes worth refusing.
    if (role is UserRole.CLIENT_OWNER) != (client_id is not None):
        raise HTTPException(
            422,
            detail="client_id is required for CLIENT_OWNER and not allowed for other roles.",
        )


@router.get(
    "/users",
    response_model=list[UserProfile],
    summary="List accounts",
    dependencies=[Depends(require_permission(Permission.USERS_MANAGE))],
)
async def list_users(session: AsyncSession = Depends(get_session)) -> list[UserProfile]:
    return [await service.profile_of(session, user) for user in await service.list_users(session)]


@router.post(
    "/users",
    response_model=UserProfile,
    status_code=status.HTTP_201_CREATED,
    summary="Create an account",
    dependencies=[Depends(require_permission(Permission.USERS_MANAGE))],
)
async def create_user(
    payload: UserCreate, session: AsyncSession = Depends(get_session)
) -> UserProfile:
    _check_owner_link(payload.role, payload.client_id)
    if payload.client_id and await session.get(Client, payload.client_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such client.")
    if await service.email_or_phone_taken(session, str(payload.email), payload.phone):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="That email or phone already has an account.")
    user = await service.create_user(
        session,
        email=str(payload.email),
        full_name=payload.full_name,
        role=payload.role,
        password=payload.password,
        phone=payload.phone,
        client_id=payload.client_id,
    )
    return await service.profile_of(session, user)


@router.patch(
    "/users/{user_id}",
    response_model=UserProfile,
    summary="Change an account's role, status or password",
    dependencies=[Depends(require_permission(Permission.USERS_MANAGE))],
)
async def update_user(
    user_id: uuid.UUID, payload: UserUpdate, session: AsyncSession = Depends(get_session)
) -> UserProfile:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No such user.")
    data = payload.model_dump(exclude_unset=True)
    role = data.get("role") or user.role
    client_id = data["client_id"] if "client_id" in data else user.client_id
    _check_owner_link(role, client_id)
    if "password" in data and data["password"]:
        user.password_hash = hash_password(data.pop("password"))
        user.token_version += 1
    data.pop("password", None)
    # Access is decided per request, but a demotion or suspension should also
    # end the sessions opened under the old terms.
    if ("role" in data and data["role"] != user.role) or data.get("is_active") is False:
        user.token_version += 1
    for field, value in data.items():
        if value is not None or field in {"client_id", "phone"}:
            setattr(user, field, value)
    await session.flush()
    return await service.profile_of(session, user)
