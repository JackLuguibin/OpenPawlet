"""FastAPI dependency providers.

All dependencies are declared as reusable callable factories so FastAPI's
dependency injection system can resolve and cache them per request.
"""

from __future__ import annotations

from console.server.config import ServerSettings, get_settings


async def get_settings_dep() -> ServerSettings:
    """Inject application settings."""
    return get_settings()
