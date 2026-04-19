"""Cron job models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class CronSchedule(BaseModel):
    """Schedule descriptor."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["at", "every", "cron"]
    at_ms: int | None = None
    every_ms: int | None = None
    expr: str | None = None
    tz: str | None = None


class CronJobState(BaseModel):
    """Runtime state for a job."""

    model_config = ConfigDict(extra="forbid")

    next_run_at_ms: int | None = None
    last_run_at_ms: int | None = None
    last_status: Literal["ok", "error", "skipped"] | None = None
    last_error: str | None = None


class CronPayload(BaseModel):
    """Job payload."""

    model_config = ConfigDict(extra="forbid")

    kind: str
    message: str
    deliver: bool | None = None
    channel: str | None = None
    to: str | None = None


class CronJob(BaseModel):
    """Cron job row."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    enabled: bool
    schedule: CronSchedule
    payload: CronPayload
    state: CronJobState
    created_at_ms: int
    updated_at_ms: int
    delete_after_run: bool


class CronAddRequest(BaseModel):
    """POST /cron body."""

    model_config = ConfigDict(extra="forbid")

    name: str
    schedule: CronSchedule
    message: str | None = None
    deliver: bool | None = None
    channel: str | None = None
    to: str | None = None
    delete_after_run: bool | None = None


class CronStatus(BaseModel):
    """GET /cron/status."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    jobs: int
    next_wake_at_ms: int | None


class CronHistoryRun(BaseModel):
    """Single run record in history map values."""

    model_config = ConfigDict(extra="forbid")

    run_at_ms: int
    status: str
    duration_ms: float
    error: str | None = None


def placeholder_cron_job(*, job_id: str = "stub-job") -> CronJob:
    """Return a minimal cron job for stub responses."""
    sched = CronSchedule(kind="cron", expr="0 0 * * *", tz="UTC")
    payload = CronPayload(kind="message", message="")
    state = CronJobState()
    return CronJob(
        id=job_id,
        name="Stub Job",
        enabled=False,
        schedule=sched,
        payload=payload,
        state=state,
        created_at_ms=0,
        updated_at_ms=0,
        delete_after_run=False,
    )


def placeholder_cron_status() -> CronStatus:
    """Empty cron scheduler status."""
    return CronStatus(enabled=False, jobs=0, next_wake_at_ms=None)
