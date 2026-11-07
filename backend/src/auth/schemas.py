"""Request and response shapes for sign-in."""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import UserRole


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginRequest(_Strict):
    email: EmailStr
    password: str = Field(min_length=1, max_length=512, repr=False)
    #: The business portal being signed in to. When given, only that tenant's owner
    #: gets in, and anyone else is told the email and password do not match.
    subdomain: str | None = Field(default=None, max_length=63)


class MagicOtpRequest(_Strict):
    """Without ``code`` this requests one; with it, this signs in."""

    #: An email address, or a WhatsApp number in any common format.
    identifier: str = Field(min_length=3, max_length=320)
    code: str | None = Field(default=None, pattern=r"^\d{6}$", repr=False)
    #: The business portal being signed in to. When given, only that tenant's owner
    #: can use a code: anyone else gets the same neutral answer as an unknown account.
    subdomain: str | None = Field(default=None, max_length=63)


class ChangePasswordRequest(_Strict):
    current_password: str = Field(min_length=1, max_length=512, repr=False)
    new_password: str = Field(min_length=10, max_length=512, repr=False)


class UserProfile(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: UserRole
    client_id: uuid.UUID | None
    #: The portal this person lands in. Only ever set for a client owner.
    client_slug: str | None
    #: The same label under the name the Weblaud brief uses.
    client_subdomain: str | None = None
    is_active: bool
    created_at: datetime | None
    permissions: list[str]


class SessionResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserProfile


class OtpRequested(BaseModel):
    sent: bool = True
    channel: str
    expires_in: int
    #: Present only while delivery is simulated. See ``Settings.otp_simulate``.
    simulated_code: str | None = None
    detail: str


class UserCreate(_Strict):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=200)
    role: UserRole
    password: str | None = Field(default=None, min_length=10, max_length=512, repr=False)
    phone: str | None = Field(default=None, max_length=32)
    client_id: uuid.UUID | None = None

    @field_validator("phone")
    @classmethod
    def _digits_only(cls, value: str | None) -> str | None:
        return normalise_phone(value) if value else None


class UserUpdate(_Strict):
    full_name: str | None = Field(default=None, min_length=2, max_length=200)
    role: UserRole | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=10, max_length=512, repr=False)
    phone: str | None = Field(default=None, max_length=32)
    client_id: uuid.UUID | None = None

    @field_validator("phone")
    @classmethod
    def _digits_only(cls, value: str | None) -> str | None:
        return normalise_phone(value) if value else None


def normalise_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if not 8 <= len(digits) <= 15:
        raise ValueError("Enter a full phone number with its country code.")
    return digits
