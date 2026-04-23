"""Aggregated runtime observability for the web UI."""

from __future__ import annotations

import json
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Query
from loguru import logger

from console.server.config import ServerSettings
from console.server.dependencies import get_settings_dep
from console.server.models import DataResponse, ObservabilityResponse
from console.server.models.observability import (
    AgentObservabilityEvent,
    AgentObservabilityTimeline,
    ConsoleObservabilityInfo,
    NanobotGatewayInfo,
)
from console.server.nanobot_observability_client import gateway_health_url
from console.server.bot_workspace import workspace_root
from console.server.observability_jsonl import read_recent_observability_dicts
from console.server.nanobot_user_config import resolve_config_path
from nanobot.config.loader import load_config

router = APIRouter(tags=["Observability"])

_OBS_TIMEOUT = httpx.Timeout(3.0, connect=1.5)


async def _probe_nanobot_gateway(host: str, port: int) -> NanobotGatewayInfo:
    endpoint = gateway_health_url(host, port)
    try:
        async with httpx.AsyncClient(timeout=_OBS_TIMEOUT) as client:
            r = await client.get(endpoint)
    except httpx.RequestError as e:
        logger.debug("observability gateway probe failed: {} {}", endpoint, e)
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            error=str(e) or type(e).__name__,
        )
    if r.status_code != 200:
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            error=f"HTTP {r.status_code}",
        )
    try:
        data = r.json()
    except json.JSONDecodeError:
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            error="Response is not JSON",
        )
    if not isinstance(data, dict):
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            error="JSON root is not an object",
        )
    st = data.get("status")
    if st is None:
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            error="missing 'status' in body",
        )
    st_s = st if isinstance(st, str) else str(st)
    if st_s != "ok":
        return NanobotGatewayInfo(
            endpoint=endpoint,
            ok=False,
            status=st_s,
            error="status is not 'ok'",
        )
    ver = data.get("version")
    up = data.get("uptime_s")
    ver_s: str | None
    if ver is not None and not isinstance(ver, (dict, list)):
        ver_s = str(ver)
    else:
        ver_s = None
    up_f: float | None
    if isinstance(up, (int, float)):
        up_f = float(up)
    else:
        up_f = None
    return NanobotGatewayInfo(
        endpoint=endpoint,
        ok=True,
        status="ok",
        version=ver_s,
        uptime_s=up_f,
        error=None,
    )


@router.get("/observability", response_model=DataResponse[ObservabilityResponse])
async def get_observability(
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ObservabilityResponse]:
    """Console API version plus a probe of ``config.gateway`` ``GET /health``."""
    path = resolve_config_path(bot_id)
    cfg = load_config(path)
    nanobot = await _probe_nanobot_gateway(cfg.gateway.host, cfg.gateway.port)
    return DataResponse(
        data=ObservabilityResponse(
            console=ConsoleObservabilityInfo(
                status="ok",
                version=settings.version,
            ),
            nanobot_gateway=nanobot,
        )
    )


@router.get("/observability/timeline", response_model=DataResponse[AgentObservabilityTimeline])
async def get_observability_timeline(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    limit: int = Query(default=200, ge=1, le=2000),
    trace_id: str | None = Query(default=None, alias="trace_id"),
) -> DataResponse[AgentObservabilityTimeline]:
    """Agent trace from JSONL under the bot workspace (LLM / tool / run; same paths nanobot appends to)."""
    path = resolve_config_path(bot_id)
    _ = load_config(path)
    raw_list, source, err = read_recent_observability_dicts(
        workspace_root(bot_id),
        limit=limit,
        trace_id=trace_id,
    )
    if err is not None:
        logger.debug("observability timeline (jsonl) failed: {} {}", source, err)
        return DataResponse(
            data=AgentObservabilityTimeline(
                ok=False,
                source_endpoint=source,
                error=err,
                events=[],
            )
        )

    events: list[AgentObservabilityEvent] = []
    for item in raw_list:
        try:
            events.append(AgentObservabilityEvent.model_validate(item))
        except Exception:  # noqa: BLE001
            continue

    return DataResponse(
        data=AgentObservabilityTimeline(
            ok=True,
            source_endpoint=source,
            error=None,
            events=events,
        )
    )
