"""Tool call logs read from optional ``.openpawlet_console/tool_logs.json``."""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import ValidationError

from console.server.bot_workspace import load_json_file, tool_logs_path
from console.server.models import DataResponse, ToolCallLog

router = APIRouter(tags=["Tools"])


def _load_logs(bot_id: str | None) -> list[ToolCallLog]:
    """Parse stored tool logs; ignore invalid rows."""
    path = tool_logs_path(bot_id)
    raw = load_json_file(path, [])
    if not isinstance(raw, list):
        return []
    rows: list[ToolCallLog] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            rows.append(ToolCallLog.model_validate(item))
        except ValidationError:
            continue
    return rows


@router.get("/tools/log", response_model=DataResponse[list[ToolCallLog]])
async def tool_logs(
    limit: int = Query(default=50, ge=1, le=500),
    tool_name: str | None = Query(default=None, alias="tool_name"),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[ToolCallLog]]:
    """Return recent tool invocations (newest first) from the optional log file."""
    rows = _load_logs(bot_id)
    if tool_name:
        rows = [r for r in rows if r.tool_name == tool_name]
    rows.sort(key=lambda r: r.timestamp, reverse=True)
    return DataResponse(data=rows[:limit])
