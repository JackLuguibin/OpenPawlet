"""OpenPawlet agent ``config.json`` snapshot attached to ``app.state``.

Loaded during FastAPI lifespan *before* ``yield`` so HTTP/WebSocket handlers can
read a single source of truth. Refreshed when :func:`console.server.lifespan.swap_runtime`
(or equivalent reload helpers in :mod:`console.server.config_apply`) rebuilds the
embedded runtime — durable edits flow disk → reload, not ad-hoc in-memory patching.

HTTP observability and ``/openpawlet-ws`` routing read websocket listen host/port/path
via :func:`websocket_gateway_listen_triple` so they stay aligned with this snapshot.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from openpawlet.channels.websocket import WebSocketConfig
from openpawlet.config.schema import Config


@dataclass(frozen=True, slots=True)
class OpenPawletRuntimeSnapshot:
    """Validated ``config.json`` plus the websocket channel slice used by proxies."""

    config: Config
    websocket: WebSocketConfig


def websocket_gateway_listen_triple(app_state: Any) -> tuple[str, int, str] | None:
    """Return ``(host, port, path)`` from ``openpawlet_runtime_snapshot`` or ``None``."""
    snap = getattr(app_state, "openpawlet_runtime_snapshot", None)
    if snap is None:
        return None
    ws = snap.websocket
    return str(ws.host), int(ws.port), ws.path


def websocket_gateway_endpoint_uri(
    app_state: Any,
    *,
    fallback_host: str,
    fallback_port: int,
) -> str:
    """``in-process://host:port`` for dashboards; uses snapshot when present."""
    tup = websocket_gateway_listen_triple(app_state)
    if tup is not None:
        h, p, _ = tup
        return f"in-process://{h}:{p}"
    return f"in-process://{fallback_host}:{fallback_port}"


__all__ = [
    "OpenPawletRuntimeSnapshot",
    "websocket_gateway_endpoint_uri",
    "websocket_gateway_listen_triple",
]
