"""Cron job models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


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
    channel_meta: dict[str, Any] = Field(default_factory=dict)
    session_key: str | None = None


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
    channel_meta: dict[str, Any] | None = None
    session_key: str | None = None


class CronUpdateRequest(BaseModel):
    """PUT /cron/{job_id} body. Any field omitted is left untouched."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    schedule: CronSchedule | None = None
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
    """One execution record returned to the client.

    Includes the job snapshot at execution time so the UI can show which
    agent / skills / tools / prompt were used – the underlying OpenPawlet
    cron service stores ``run_at_ms``/``status``/``duration_ms``/``error``;
    the prompt-side fields are derived from the job's persisted ``message``
    metadata block (see ``cronMetadata.ts`` on the web client).
    """

    model_config = ConfigDict(extra="forbid")

    run_at_ms: int
    status: str
    duration_ms: float
    error: str | None = None
    # Job snapshot fields (echoed for convenient rendering).
    job_id: str
    job_name: str
    # Decoded metadata (parsed best-effort from ``payload.message``).
    agent_id: str | None = None
    skills: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    prompt: str = ""
    deliver: bool | None = None
    channel: str | None = None
    to: str | None = None


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
