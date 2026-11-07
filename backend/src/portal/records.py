"""The owner's lead and order sheet, kept in ``records.json`` in the tenant's data directory.

One file serves two readers: the owner's workspace (through ``growth_router``) and the
tenant's own agent, which can capture a booking or an order by appending to it. So the
file is treated as untrusted on every read: a row that does not validate is skipped, and
text is scrubbed on the way out like everything else read from a tenant's directory.

Writes take the same ``<file>.lock`` the agent takes, and replace the file atomically.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import status
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import PortalError
from .sanitize import scrub
from .tenant_files import TenantFiles

logger = logging.getLogger(__name__)

RECORDS_FILE = "records.json"
#: ``MAX_FILE_BYTES`` is 512 KiB and a row is a few hundred bytes, so this stays well inside it.
MAX_RECORDS = 1500

RecordKind = Literal["lead", "order"]
LeadStatus = Literal["new", "booked", "completed"]
OrderStatus = Literal["pending", "dispatched", "delivered"]
RecordStatus = Literal["new", "booked", "completed", "pending", "dispatched", "delivered"]
Qualification = Literal["hot", "warm"]
CodStatus = Literal["pending", "collected", "prepaid"]

_STATUSES_FOR: dict[str, tuple[str, ...]] = {
    "lead": ("new", "booked", "completed"),
    "order": ("pending", "dispatched", "delivered"),
}
_FIRST_STATUS = {"lead": "new", "order": "pending"}


class RecordCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    kind: RecordKind
    customer_name: str = Field(min_length=1, max_length=120)
    #: A phone number, or the social handle the customer wrote from.
    contact: str = Field(default="", max_length=80)
    source: str = Field(default="manual", max_length=40)
    message: str = Field(default="", max_length=1000)
    # leads and appointments
    service_requested: str = Field(default="", max_length=200)
    preferred_date: str = Field(default="", max_length=40)
    qualification: Qualification = "warm"
    # orders
    items: str = Field(default="", max_length=400)
    total_usd: float = Field(default=0, ge=0, le=10_000_000)
    cod_status: CodStatus = "pending"
    courier: str = Field(default="", max_length=80)
    tracking_number: str = Field(default="", max_length=80)
    status: RecordStatus | None = None


class RecordUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    customer_name: str | None = Field(default=None, min_length=1, max_length=120)
    contact: str | None = Field(default=None, max_length=80)
    message: str | None = Field(default=None, max_length=1000)
    service_requested: str | None = Field(default=None, max_length=200)
    preferred_date: str | None = Field(default=None, max_length=40)
    qualification: Qualification | None = None
    items: str | None = Field(default=None, max_length=400)
    total_usd: float | None = Field(default=None, ge=0, le=10_000_000)
    cod_status: CodStatus | None = None
    courier: str | None = Field(default=None, max_length=80)
    tracking_number: str | None = Field(default=None, max_length=80)
    status: RecordStatus | None = None


class RecordRead(BaseModel):
    id: str
    #: The short code the owner reads out to a customer, such as ``ORD-4F2A9C``.
    ref: str
    kind: RecordKind
    status: RecordStatus
    customer_name: str
    contact: str
    source: str
    message: str
    service_requested: str
    preferred_date: str
    qualification: Qualification
    items: str
    total_usd: float
    cod_status: CodStatus
    courier: str
    tracking_number: str
    dispatched_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class RecordsView(BaseModel):
    records: list[RecordRead]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: scrub(value) if isinstance(value, str) else value for key, value in row.items()}


def _parse(raw: Any) -> list[RecordRead]:
    rows = raw.get("records") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        return []
    parsed: list[RecordRead] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            record = RecordRead.model_validate(_clean_row(row))
        except ValidationError:
            continue  # one bad row from the agent must not hide the rest
        if record.status in _STATUSES_FOR[record.kind]:
            parsed.append(record)
    return parsed


def _load(files: TenantFiles) -> list[RecordRead]:
    return _parse(files.read_json(RECORDS_FILE))


def _store(files: TenantFiles, records: list[RecordRead]) -> None:
    newest = sorted(records, key=lambda record: record.created_at, reverse=True)[:MAX_RECORDS]
    # ``mode="json"`` so datetimes are written as ISO strings the agent can read too.
    body = {"version": 1, "records": [record.model_dump(mode="json") for record in newest]}
    files.write_atomic(json.dumps(body, indent=2) + "\n", RECORDS_FILE)


def list_records(files: TenantFiles, kind: str | None = None) -> list[RecordRead]:
    records = _load(files)
    if kind is not None:
        records = [record for record in records if record.kind == kind]
    return sorted(records, key=lambda record: record.created_at, reverse=True)


def create_record(files: TenantFiles, payload: RecordCreate) -> RecordRead:
    wanted = payload.status or _FIRST_STATUS[payload.kind]
    if wanted not in _STATUSES_FOR[payload.kind]:
        raise _invalid(f"A {payload.kind} cannot start as {wanted}.")
    now = _now()
    record = RecordRead(
        id=uuid.uuid4().hex[:16],
        ref=f"{'ORD' if payload.kind == 'order' else 'LEAD'}-{uuid.uuid4().hex[:6].upper()}",
        kind=payload.kind,
        status=wanted,  # type: ignore[arg-type]
        customer_name=payload.customer_name,
        contact=payload.contact,
        source=payload.source,
        message=payload.message,
        service_requested=payload.service_requested,
        preferred_date=payload.preferred_date,
        qualification=payload.qualification,
        items=payload.items,
        total_usd=round(payload.total_usd, 2),
        cod_status=payload.cod_status,
        courier=payload.courier,
        tracking_number=payload.tracking_number,
        dispatched_at=now if wanted == "dispatched" else None,
        created_at=now,
        updated_at=now,
    )
    with files.locked(RECORDS_FILE):
        _store(files, [record, *_load(files)])
    return record


def update_record(files: TenantFiles, record_id: str, payload: RecordUpdate) -> RecordRead:
    changes = payload.model_dump(exclude_unset=True)
    with files.locked(RECORDS_FILE):
        records = _load(files)
        index = next((i for i, record in enumerate(records) if record.id == record_id), None)
        if index is None:
            raise PortalError(status.HTTP_404_NOT_FOUND, "record_not_found", "That record no longer exists.")
        current = records[index]
        new_status = changes.get("status")
        if new_status is not None and new_status not in _STATUSES_FOR[current.kind]:
            raise _invalid(f"A {current.kind} cannot be set to {new_status}.")
        merged = current.model_copy(update={**changes, "updated_at": _now()})
        if new_status == "dispatched" and current.status != "dispatched":
            merged.dispatched_at = merged.updated_at
        records[index] = merged
        _store(files, records)
    return merged


def _invalid(detail: str) -> PortalError:
    return PortalError(422, "record_invalid", detail)


#: A customer who writes again within a day is the same conversation, not a second lead.
_MERGE_WINDOW_HOURS = 24


def capture_inbound(files: TenantFiles, payload: RecordCreate) -> tuple[RecordRead, bool]:
    """Record an inbound enquiry. Returns the record and whether it was newly created.

    A still-open lead from the same contact and channel gets the new message added
    instead of a duplicate row, and is promoted to Hot if the new message is.
    """
    now = _now()
    with files.locked(RECORDS_FILE):
        records = _load(files)
        for index, existing in enumerate(records):
            if (
                existing.kind == "lead"
                and existing.status == "new"
                and existing.source == payload.source
                and existing.contact == payload.contact
                and payload.contact
                and (now - existing.updated_at).total_seconds() < _MERGE_WINDOW_HOURS * 3600
            ):
                joined = "\n".join((existing.message, payload.message)).strip()[-1000:]
                qualification = "hot" if "hot" in (existing.qualification, payload.qualification) else "warm"
                merged = existing.model_copy(
                    update={"message": joined, "qualification": qualification, "updated_at": now}
                )
                records[index] = merged
                _store(files, records)
                return merged, False
    return create_record(files, payload), True
