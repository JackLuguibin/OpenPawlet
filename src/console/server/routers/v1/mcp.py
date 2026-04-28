"""MCP server listing from ``config.json`` and diagnostic stubs."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.mcp_config import mcp_statuses_for_bot
from console.server.models import DataResponse
from console.server.models.mcp import MCPTestResult
from console.server.models.status import MCPStatus

router = APIRouter(tags=["MCP"])


@router.get("/mcp", response_model=DataResponse[list[MCPStatus]])
async def list_mcp(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[MCPStatus]]:
    """List MCP servers defined under ``tools.mcp_servers``."""
    return DataResponse(data=mcp_statuses_for_bot(bot_id))


@router.post("/mcp/{name}/test", response_model=DataResponse[MCPTestResult])
async def test_mcp(
    name: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[MCPTestResult]:
    """Connectivity check (stub — use running OpenPawlet for real MCP tests)."""
    _ = bot_id
    return DataResponse(data=MCPTestResult(name=name, success=True, message=None, latency_ms=0.0))


@router.post("/mcp/{name}/refresh", response_model=DataResponse[MCPTestResult])
async def refresh_mcp(
    name: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[MCPTestResult]:
    """Refresh MCP server registration (stub)."""
    _ = bot_id
    return DataResponse(data=MCPTestResult(name=name, success=True, message=None, latency_ms=0.0))
