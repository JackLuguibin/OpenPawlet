"""Aggregated runtime observability for the web UI."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from loguru import logger

from console.server.bot_workspace import workspace_root
from console.server.config import ServerSettings, openpawlet_distribution_version
from console.server.dependencies import get_settings_dep
from console.server.models import DataResponse, ObservabilityResponse
from console.server.models.observability import (
    AgentObservabilityEvent,
    AgentObservabilityTimeline,
    ConsoleObservabilityInfo,
    OpenPawletGatewayInfo,
)
from console.server.observability_jsonl import read_recent_observability_dicts
from console.server.openpawlet_runtime_snapshot import websocket_gateway_endpoint_uri

router = APIRouter(tags=["Observability"])


def _embedded_runtime_info(request: Request, settings: ServerSettings) -> OpenPawletGatewayInfo:
    """Build the gateway block from the in-process embedded runtime.

    The 0.3.x layout collapsed the gateway into the console process, so
    HTTP-probing ``ws://127.0.0.1:8765`` (which only speaks WebSocket)
    always returned an error and made the dashboard look unhealthy.  We
    report the actual EmbeddedOpenPawlet state here instead.
    """
    embedded = getattr(request.app.state, "embedded", None)
    endpoint = websocket_gateway_endpoint_uri(
        request.app.state,
        fallback_host=settings.openpawlet_gateway_host,
        fallback_port=settings.openpawlet_gateway_port,
    )
    if embedded is None:
        return OpenPawletGatewayInfo(
            endpoint=endpoint,
            ok=False,
            status="degraded",
            error="Embedded runtime is not running",
        )
    uptime = float(getattr(embedded, "uptime_s", 0.0))
    return OpenPawletGatewayInfo(
        endpoint=endpoint,
        ok=True,
        status="ok",
        version=openpawlet_distribution_version(),
        uptime_s=uptime,
        error=None,
    )


@router.get("/observability", response_model=DataResponse[ObservabilityResponse])
async def get_observability(
    request: Request,
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ObservabilityResponse]:
    """Return console + embedded-runtime status (no self-HTTP probe)."""
    del bot_id  # Query parity with other routes; gateway/status reflect the active embedded runtime.
    return DataResponse(
        data=ObservabilityResponse(
            console=ConsoleObservabilityInfo(
                status="ok",
                version=openpawlet_distribution_version(),
            ),
            openpawlet_gateway=_embedded_runtime_info(request, settings),
        )
    )


@router.get("/observability/timeline", response_model=DataResponse[AgentObservabilityTimeline])
async def get_observability_timeline(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    limit: int = Query(default=200, ge=1, le=2000),
    trace_id: str | None = Query(default=None, alias="trace_id"),
) -> DataResponse[AgentObservabilityTimeline]:
    """Agent trace from JSONL under the bot workspace (LLM / tool / run; same paths OpenPawlet appends to)."""
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
