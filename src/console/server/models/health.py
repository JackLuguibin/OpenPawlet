"""Health check response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from console.server.models.base import BaseResponse
from console.server.openpawlet_user_config import read_default_timezone, resolve_config_path
from openpawlet.utils.helpers import local_now


def _server_now() -> datetime:
    """Return current time in ``agents.defaults.timezone`` when set in config."""
    return local_now(read_default_timezone(resolve_config_path(None)))


class HealthResponse(BaseResponse):
    """Health check response."""

    status: str = Field(default="ok", description="'ok' when healthy")
    version: str = Field(description="API version")
    timestamp: datetime = Field(default_factory=_server_now)
