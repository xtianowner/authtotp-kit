from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StrictInt, model_validator


# Admin password rule, shared by first-time setup and password change.
NewAdminPassword = Annotated[str, Field(min_length=12, max_length=256)]


class BootstrapRequest(BaseModel):
    password: NewAdminPassword


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str | None = Field(default=None, max_length=32)


class TotpCodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: NewAdminPassword
    code: str | None = Field(default=None, max_length=32)


class TotpDisableRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=32)


class EntryCreate(BaseModel):
    otpauth_uri: str | None = Field(default=None, max_length=4096)
    secret: str | None = Field(default=None, max_length=512)
    label: str | None = Field(default=None, max_length=160)
    issuer: str | None = Field(default=None, max_length=120)
    account_ref: str | None = Field(default=None, max_length=160)
    purpose: str = Field(default="automation", min_length=1, max_length=64)
    algorithm: Literal["SHA1", "SHA256", "SHA512"] = "SHA1"
    digits: Literal[6, 7, 8] = 6
    period_seconds: int = Field(default=30, ge=15, le=120)

    @model_validator(mode="after")
    def exactly_one_source(self) -> "EntryCreate":
        if bool(self.otpauth_uri) == bool(self.secret):
            raise ValueError("必须且只能提供 otpauth_uri 或 secret。")
        return self


class EntryUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=160)
    issuer: str | None = Field(default=None, max_length=120)
    account_ref: str | None = Field(default=None, max_length=160)
    purpose: str | None = Field(default=None, min_length=1, max_length=64)
    status: Literal["active", "disabled"] | None = None


class DeleteRequest(BaseModel):
    confirmation: Literal["DELETE"]


# Longest lifetime a single caller token can be given at creation (365 days).
CALLER_TOKEN_MAX_HOURS = 8760


class CallerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    purpose: str = Field(min_length=1, max_length=160)
    allowed_entry_ids: list[str] = Field(default_factory=list, max_length=100)
    # Omitted / null = server default (AUTHTOTP_CALLER_TOKEN_HOURS); 0 = never expires;
    # 1..CALLER_TOKEN_MAX_HOURS = hours from now. JSON integers only (no "1", 1.0 or true).
    expires_in_hours: Annotated[StrictInt, Field(ge=0, le=CALLER_TOKEN_MAX_HOURS)] | None = None


class CallerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    purpose: str | None = Field(default=None, min_length=1, max_length=160)
    allowed_entry_ids: list[str] | None = Field(default=None, max_length=100)


class RevokeRequest(BaseModel):
    confirmation: Literal["REVOKE"]

