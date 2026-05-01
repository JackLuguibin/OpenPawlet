"""FastAPI dependency providers.

All dependencies are declared as reusable callable factories so FastAPI's
dependency injection system can resolve and cache them per request.
"""

from __future__ import annotations

from fastapi import Request

from console.server.config import ServerSettings
from console.server.openpawlet_runtime_snapshot import OpenPawletRuntimeSnapshot


async def get_settings_dep(request: Request) -> ServerSettings:
    """Inject console :class:`ServerSettings` from ``app.state`` (set in ``create_app``)."""
    return request.app.state.settings


async def get_openpawlet_runtime_snapshot_dep(
    request: Request,
) -> OpenPawletRuntimeSnapshot | None:
    """Inject agent ``config.json`` snapshot from ``app.state`` (lifespan pre-serve load)."""
    return getattr(request.app.state, "openpawlet_runtime_snapshot", None)
