"""Cron scheduler API.

The console embeds OpenPawlet in-process and shares its ``CronService``
instance via ``app.state.embedded.cron`` (see ``console/server/lifespan.py``).
This router is a thin façade on top of that service so the SPA can
list / add / update / enable / run cron jobs and inspect run history.

When the embedded runtime is unavailable (degraded mode) we fall back to
constructing a transient ``CronService`` bound to the same on-disk store
``<workspace>/cron/jobs.json``; the underlying service uses a file lock and
an ``action.jsonl`` write-ahead queue so two processes (console + OpenPawlet
CLI) can read/write safely.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from console.server.cron_helpers import (
    cron_history_for_job,
    cron_job_to_dict,
    get_cron_service,
    require_cron_service,
)
from console.server.http_errors import bad_request, forbidden, not_found
from console.server.models import (
    CronAddRequest,
    CronJob,
    CronStatus,
    CronUpdateRequest,
    DataResponse,
)
from console.server.models.base import OkWithJobId
from console.server.models.cron import CronHistoryRun, placeholder_cron_status
from openpawlet.cron.types import CronSchedule as OpenPawletCronSchedule

router = APIRouter(tags=["Cron"])


def _to_openpawlet_schedule(s: Any) -> OpenPawletCronSchedule:
    return OpenPawletCronSchedule(
        kind=s.kind,
        at_ms=s.at_ms,
        every_ms=s.every_ms,
        expr=s.expr,
        tz=s.tz,
    )


@router.get("/cron", response_model=DataResponse[list[CronJob]])
async def list_cron_jobs(
    request: Request,
    bot_id: str | None = Query(default=None, alias="bot_id"),
    include_disabled: bool = Query(default=True, alias="include_disabled"),
) -> DataResponse[list[CronJob]]:
    """List cron jobs from the live embedded scheduler (or disk fallback)."""
    svc = get_cron_service(request, bot_id)
    if svc is None:
        return DataResponse(data=[])
    jobs = svc.list_jobs(include_disabled=include_disabled)
    return DataResponse(data=[CronJob.model_validate(cron_job_to_dict(j)) for j in jobs])


@router.post("/cron", response_model=DataResponse[CronJob])
async def add_cron_job(
    request: Request,
    body: CronAddRequest,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronJob]:
    """Create a cron job and persist it through the live scheduler."""
    svc = require_cron_service(request, bot_id)
    try:
        job = svc.add_job(
            name=body.name,
            schedule=_to_openpawlet_schedule(body.schedule),
            message=body.message or "",
            deliver=bool(body.deliver) if body.deliver is not None else False,
            channel=body.channel,
            to=body.to,
            delete_after_run=bool(body.delete_after_run)
            if body.delete_after_run is not None
            else False,
        )
    except ValueError as exc:
        bad_request(str(exc))
    return DataResponse(data=CronJob.model_validate(cron_job_to_dict(job)))


@router.put("/cron/{job_id}", response_model=DataResponse[CronJob])
async def update_cron_job(
    request: Request,
    job_id: str,
    body: CronUpdateRequest,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronJob]:
    """Update mutable fields on an existing job."""
    svc = require_cron_service(request, bot_id)
    sentinel = object()
    kwargs: dict[str, Any] = {}
    if body.name is not None:
        kwargs["name"] = body.name
    if body.schedule is not None:
        kwargs["schedule"] = _to_openpawlet_schedule(body.schedule)
    if body.message is not None:
        kwargs["message"] = body.message
    if body.deliver is not None:
        kwargs["deliver"] = bool(body.deliver)
    # ``channel`` and ``to`` distinguish unset vs explicit-null; the
    # OpenPawlet service uses ``...`` as its leave-untouched sentinel.
    kwargs["channel"] = body.channel if body.channel is not None else sentinel
    kwargs["to"] = body.to if body.to is not None else sentinel
    if body.delete_after_run is not None:
        kwargs["delete_after_run"] = bool(body.delete_after_run)

    if kwargs.get("channel") is sentinel:
        kwargs.pop("channel")
    if kwargs.get("to") is sentinel:
        kwargs.pop("to")

    try:
        result = svc.update_job(job_id, **kwargs)
    except ValueError as exc:
        bad_request(str(exc))
    if result == "not_found":
        not_found("Cron job")
    if result == "protected":
        forbidden("Cron job is protected")
    return DataResponse(data=CronJob.model_validate(cron_job_to_dict(result)))


@router.delete("/cron/{job_id}", response_model=DataResponse[OkWithJobId])
async def remove_cron_job(
    request: Request,
    job_id: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithJobId]:
    """Remove a cron job."""
    svc = require_cron_service(request, bot_id)
    result = svc.remove_job(job_id)
    if result == "not_found":
        not_found("Cron job")
    if result == "protected":
        forbidden("Cron job is protected")
    return DataResponse(data=OkWithJobId(job_id=job_id))


@router.put("/cron/{job_id}/enable", response_model=DataResponse[CronJob])
async def enable_cron_job(
    request: Request,
    job_id: str,
    enabled: bool = Query(...),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronJob]:
    """Enable or disable a job."""
    svc = require_cron_service(request, bot_id)
    job = svc.enable_job(job_id, enabled=enabled)
    if job is None:
        not_found("Cron job")
    return DataResponse(data=CronJob.model_validate(cron_job_to_dict(job)))


@router.post("/cron/{job_id}/run", response_model=DataResponse[OkWithJobId])
async def run_cron_job(
    request: Request,
    job_id: str,
    force: bool = Query(default=False),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithJobId]:
    """Trigger a job immediately."""
    svc = require_cron_service(request, bot_id)
    if svc.get_job(job_id) is None:
        not_found("Cron job")
    ran = await svc.run_job(job_id, force=force)
    if not ran:
        bad_request("Cron job not run (disabled and force=false)")
    return DataResponse(data=OkWithJobId(job_id=job_id))


@router.get("/cron/status", response_model=DataResponse[CronStatus])
async def cron_status(
    request: Request,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[CronStatus]:
    """Return scheduler status (enabled flag + next-wake time)."""
    svc = get_cron_service(request, bot_id)
    if svc is None:
        return DataResponse(data=placeholder_cron_status())
    raw = svc.status()
    return DataResponse(
        data=CronStatus(
            enabled=bool(raw.get("enabled")),
            jobs=int(raw.get("jobs", 0) or 0),
            next_wake_at_ms=raw.get("next_wake_at_ms"),
        )
    )


@router.get(
    "/cron/history",
    response_model=DataResponse[dict[str, list[CronHistoryRun]]],
)
async def cron_history(
    request: Request,
    bot_id: str | None = Query(default=None, alias="bot_id"),
    job_id: str | None = Query(default=None, alias="job_id"),
) -> DataResponse[dict[str, list[CronHistoryRun]]]:
    """Per-job run history.

    Returns ``{ job_id: [CronHistoryRun, ...] }``. Each record carries the
    job snapshot (id, name, deliver/channel/to) and decoded message
    metadata (agent_id, skills, mcp_servers, tools, prompt) so the UI can
    render rich audit entries without extra round-trips.
    """
    svc = get_cron_service(request, bot_id)
    out: dict[str, list[CronHistoryRun]] = {}
    if svc is None:
        return DataResponse(data=out)
    if job_id:
        job = svc.get_job(job_id)
        if job is None:
            not_found("Cron job")
        out[job.id] = [
            CronHistoryRun.model_validate(row) for row in cron_history_for_job(job)
        ]
        return DataResponse(data=out)
    for job in svc.list_jobs(include_disabled=True):
        rows = cron_history_for_job(job)
        if rows:
            out[job.id] = [CronHistoryRun.model_validate(row) for row in rows]
    return DataResponse(data=out)
