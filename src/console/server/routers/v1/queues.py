"""Console-side gateway for the Queue Manager broker admin surface.

All endpoints here are thin HTTP proxies: Console forwards the SPA's
request to the broker with the configured bearer token and returns the
raw response.  Doing this in the console server (instead of letting
the SPA hit the broker directly) keeps the admin token out of the
browser.
"""

from __future__ import annotations

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from loguru import logger
from pydantic import BaseModel, Field

from console.server.config import ServerSettings
from console.server.dependencies import get_settings_dep

router = APIRouter(tags=["Queues"])

_QM_TIMEOUT = httpx.Timeout(5.0, connect=2.0)


def _broker_base(settings: ServerSettings) -> str:
    return f"http://{settings.queue_manager_host}:{settings.queue_manager_admin_port}"


def _auth_headers(settings: ServerSettings) -> dict[str, str]:
    if settings.queue_manager_admin_token:
        return {"Authorization": f"Bearer {settings.queue_manager_admin_token}"}
    return {}


async def _proxy_get(settings: ServerSettings, path: str) -> dict[str, Any]:
    url = f"{_broker_base(settings)}{path}"
    try:
        async with httpx.AsyncClient(timeout=_QM_TIMEOUT) as client:
            r = await client.get(url, headers=_auth_headers(settings))
    except httpx.RequestError as exc:
        logger.debug("queues: broker {} unreachable ({})", url, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Queue Manager broker unreachable: {exc}",
        ) from exc
    if r.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Queue Manager broker rejected admin credentials",
        )
    if r.status_code >= 400:
        raise HTTPException(
            status_code=r.status_code,
            detail=f"broker returned {r.status_code}: {r.text[:500]}",
        )
    try:
        return r.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="broker returned invalid JSON",
        ) from exc


async def _proxy_post(
    settings: ServerSettings, path: str, payload: dict[str, Any]
) -> dict[str, Any]:
    url = f"{_broker_base(settings)}{path}"
    try:
        async with httpx.AsyncClient(timeout=_QM_TIMEOUT) as client:
            r = await client.post(url, json=payload, headers=_auth_headers(settings))
    except httpx.RequestError as exc:
        logger.warning("queues: broker {} unreachable ({})", url, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Queue Manager broker unreachable: {exc}",
        ) from exc
    if r.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Queue Manager broker rejected admin credentials",
        )
    if r.status_code >= 400:
        raise HTTPException(
            status_code=r.status_code,
            detail=f"broker returned {r.status_code}: {r.text[:500]}",
        )
    try:
        return r.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="broker returned invalid JSON",
        ) from exc


class PauseBody(BaseModel):
    direction: str = Field(
        default="both",
        description="``inbound``, ``outbound`` or ``both``.",
    )
    paused: bool = Field(default=True)


class ReplayBody(BaseModel):
    message_id: str = Field(..., min_length=1)


class ClearDedupeBody(BaseModel):
    scope: str = Field(default="memory")


@router.get("/queues/snapshot", summary="Queue Manager snapshot")
async def queues_snapshot(
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    """Return the full broker snapshot (topology, metrics, connections, samples)."""
    return await _proxy_get(settings, "/queues/snapshot")


@router.post("/queues/pause", summary="Pause or resume broker pumps")
async def queues_pause(
    body: PauseBody,
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    """Toggle the broker's ingress / egress pumps."""
    logger.info(
        "queues: admin pause request direction={} paused={}",
        body.direction,
        body.paused,
    )
    return await _proxy_post(
        settings,
        "/queues/pause",
        {"direction": body.direction, "paused": body.paused},
    )


@router.post("/queues/replay", summary="Replay a previously seen message")
async def queues_replay(
    body: ReplayBody,
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    """Re-publish a sampled message by ``message_id``."""
    logger.info("queues: admin replay request message_id={}", body.message_id)
    return await _proxy_post(
        settings, "/queues/replay", {"message_id": body.message_id}
    )


@router.post("/queues/dedupe/clear", summary="Clear the idempotency store")
async def queues_clear_dedupe(
    body: ClearDedupeBody,
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
) -> dict[str, Any]:
    """Wipe the dedupe table (scope: ``memory`` / ``persist`` / ``both``)."""
    logger.info("queues: admin clear_dedupe request scope={}", body.scope)
    return await _proxy_post(
        settings, "/queues/dedupe/clear", {"scope": body.scope}
    )
