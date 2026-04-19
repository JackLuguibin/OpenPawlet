"""Build :class:`MCPStatus` rows from nanobot ``config.json``."""

from __future__ import annotations

from typing import Literal

from nanobot.config.loader import load_config

from console.server.models.status import MCPStatus
from console.server.nanobot_user_config import resolve_config_path


def mcp_statuses_for_bot(bot_id: str | None) -> list[MCPStatus]:
    """List configured MCP servers; runtime connection is not probed here."""
    cfg = load_config(resolve_config_path(bot_id))
    rows: list[MCPStatus] = []
    for name, srv in cfg.tools.mcp_servers.items():
        is_http = bool(srv.url) or srv.type in ("sse", "streamableHttp")
        server_type: Literal["stdio", "http"] = "http" if is_http else "stdio"
        rows.append(
            MCPStatus(
                name=name,
                status="disconnected",
                server_type=server_type,
                last_connected=None,
                error=None,
            )
        )
    return rows
