"""Read-only accessors for :attr:`starlette.requests.Request.app.state`.

Keeps the string keys and fallback behaviour in one place so routers avoid
duplicated ``getattr(request.app.state, "…", None)`` boilerplate.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import Request, WebSocket

from console.server.http_errors import service_unavailable

__all__ = [
    "app_uptime_seconds",
    "get_agent_manager",
    "get_message_bus",
    "request_uptime_seconds",
    "require_agent_manager",
]


def get_agent_manager(request: Request) -> Any | None:
    return getattr(request.app.state, "agent_manager", None)


def require_agent_manager(request: Request) -> Any:
    """Return the embedded manager or raise HTTP 503 when runtime is unavailable."""
    manager = get_agent_manager(request)
    if manager is None:
        service_unavailable(
            "Embedded runtime manager unavailable (degraded mode or disabled runtime).",
        )
    return manager


def get_message_bus(conn: Request | WebSocket) -> Any:
    """Return ``app.state.message_bus`` or ``None`` when not wired."""
    return getattr(conn.app.state, "message_bus", None)


def app_uptime_seconds(state: Any) -> float:
    """Seconds since ``started_at_perf`` was recorded on *state*."""
    started_at = float(getattr(state, "started_at_perf", time.perf_counter()))
    return time.perf_counter() - started_at


def request_uptime_seconds(conn: Request | WebSocket) -> float:
    """Seconds since ``started_at_perf`` on *conn*.``app.state``."""
    return app_uptime_seconds(conn.app.state)
