"""Control plane: stop task, restart (stub).

Runtime control currently lives in nanobot itself (gateway + agent loop).
The endpoints in this module are placeholders that always report success so
older clients do not break; they are marked ``deprecated`` in the OpenAPI
schema to signal that no actual control action is performed.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import DataResponse, OkBody
from console.server.nanobot_user_config import BOT_ID_DESCRIPTION

router = APIRouter(tags=["Control"])


@router.post(
    "/control/stop",
    response_model=DataResponse[OkBody],
    deprecated=True,
    summary="Stop current task (stub; no-op)",
)
async def stop_current_task(
    bot_id: str | None = Query(default=None, alias="bot_id", description=BOT_ID_DESCRIPTION),
) -> DataResponse[OkBody]:
    """Return ``ok`` without stopping anything (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())


@router.post(
    "/control/restart",
    response_model=DataResponse[OkBody],
    deprecated=True,
    summary="Restart bot (stub; no-op)",
)
async def restart_bot(
    bot_id: str | None = Query(default=None, alias="bot_id", description=BOT_ID_DESCRIPTION),
) -> DataResponse[OkBody]:
    """Return ``ok`` without restarting anything (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())
