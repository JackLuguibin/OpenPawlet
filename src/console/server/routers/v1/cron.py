"""Cron scheduler (stub)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from console.server.models import CronAddRequest, CronJob, DataResponse
from console.server.models.base import OkWithJobId
from console.server.models.cron import (
    CronStatus,
    placeholder_cron_job,
    placeholder_cron_status,
)

router = APIRouter(tags=["Cron"])


@router.get("/cron", response_model=DataResponse[list[CronJob]])
async def list_cron_jobs(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    include_disabled: bool = Query(default=False, alias="include_disabled"),
) -> DataResponse[list[CronJob]]:
    """List cron jobs (stub)."""
    _ = bot_id, include_disabled
    return DataResponse(data=[])


@router.post("/cron", response_model=DataResponse[CronJob])
async def add_cron_job(
    body: CronAddRequest,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronJob]:
    """Add cron job (stub)."""
    _ = bot_id
    return DataResponse(data=placeholder_cron_job())


@router.delete("/cron/{job_id}", response_model=DataResponse[OkWithJobId])
async def remove_cron_job(
    job_id: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithJobId]:
    """Remove cron job (stub)."""
    _ = bot_id
    return DataResponse(data=OkWithJobId(job_id=job_id))


@router.put("/cron/{job_id}/enable", response_model=DataResponse[CronJob])
async def enable_cron_job(
    job_id: str,
    enabled: bool = Query(...),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronJob]:
    """Enable or disable job (stub)."""
    _ = bot_id
    j = placeholder_cron_job(job_id=job_id)
    return DataResponse(data=j.model_copy(update={"enabled": enabled}))


@router.post("/cron/{job_id}/run", response_model=DataResponse[OkWithJobId])
async def run_cron_job(
    job_id: str,
    force: bool = Query(default=False),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithJobId]:
    """Run job now (stub)."""
    _ = force, bot_id
    return DataResponse(data=OkWithJobId(job_id=job_id))


@router.get("/cron/status", response_model=DataResponse[CronStatus])
async def cron_status(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronStatus]:
    """Scheduler status (stub)."""
    _ = bot_id
    return DataResponse(data=placeholder_cron_status())


@router.get("/cron/history", response_model=DataResponse[dict[str, Any]])
async def cron_history(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    job_id: str | None = Query(default=None, alias="job_id"),
) -> DataResponse[dict[str, Any]]:
    """Per-job run history (stub)."""
    _ = bot_id, job_id
    return DataResponse(data={})
