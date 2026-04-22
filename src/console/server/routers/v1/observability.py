"""Aggregated runtime observability for the web UI."""

from __future__ import annotations

import json
from typing import Annotated
from urllib.parse import urlencode

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
from console.server.nanobot_user_config import resolve_config_path
from nanobot.config.loader import load_config

router = APIRouter(tags=["Observability"])

_OBS_TIMEOUT = httpx.Timeout(3.0, connect=1.5)
_OBS_TIMELINE_TIMEOUT = httpx.Timeout(8.0, connect=2.0)


def _gateway_health_url(host: str, port: int) -> str:
    """Map bind addresses (0.0.0.0, ::) to loopback; bracket IPv6 for URL."""
    h = (host or "").strip()
    if h in ("", "0.0.0.0", "::", "[::]"):
        h = "127.0.0.1"
    elif h.count(":") > 1 and not h.startswith("["):
        h = f"[{h}]"
    return f"http://{h}:{port}/health"


def _gateway_timeline_url(
    host: str,
    port: int,
    *,
    limit: int = 200,
    trace_id: str | None = None,
) -> str:
    """``GET {gateway}/v1/observability/recent`` (same port as /health in gateway mode)."""
    h = (host or "").strip()
    if h in ("", "0.0.0.0", "::", "[::]"):
        h = "127.0.0.1"
    elif h.count(":") > 1 and not h.startswith("["):
        h = f"[{h}]"
    q: dict[str, str] = {"limit": str(max(1, min(2000, limit)))}
    if trace_id and trace_id.strip():
        q["trace_id"] = trace_id.strip()
    return f"http://{h}:{port}/v1/observability/recent?{urlencode(q)}"


async def _probe_nanobot_gateway(host: str, port: int) -> NanobotGatewayInfo:
    endpoint = _gateway_health_url(host, port)
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
    """Proxy nanobot in-memory agent trace buffer (LLM / tool / run)."""
    path = resolve_config_path(bot_id)
    cfg = load_config(path)
    endpoint = _gateway_timeline_url(cfg.gateway.host, cfg.gateway.port, limit=limit, trace_id=trace_id)
    try:
        async with httpx.AsyncClient(timeout=_OBS_TIMELINE_TIMEOUT) as client:
            r = await client.get(endpoint)
    except httpx.RequestError as e:
        logger.debug("observability timeline failed: {} {}", endpoint, e)
        return DataResponse(
            data=AgentObservabilityTimeline(
                ok=False,
                source_endpoint=endpoint,
                error=str(e) or type(e).__name__,
                events=[],
            )
        )
    if r.status_code != 200:
        return DataResponse(
            data=AgentObservabilityTimeline(
                ok=False,
                source_endpoint=endpoint,
                error=f"HTTP {r.status_code}",
                events=[],
            )
        )
    try:
        body = r.json()
    except json.JSONDecodeError:
        return DataResponse(
            data=AgentObservabilityTimeline(
                ok=False,
                source_endpoint=endpoint,
                error="Response is not JSON",
                events=[],
            )
        )
    if not isinstance(body, dict) or "events" not in body:
        return DataResponse(
            data=AgentObservabilityTimeline(
                ok=False,
                source_endpoint=endpoint,
                error="invalid body",
                events=[],
            )
        )
    raw_events = body.get("events")
    if not isinstance(raw_events, list):
        raw_events = []
    events: list[AgentObservabilityEvent] = []
    for item in raw_events:
        if not isinstance(item, dict):
            continue
        try:
            events.append(AgentObservabilityEvent.model_validate(item))
        except Exception:  # noqa: BLE001
            continue
    return DataResponse(
        data=AgentObservabilityTimeline(
            ok=bool(body.get("ok", True)),
            source_endpoint=endpoint,
            error=None,
            events=events,
        )
    )
