"""Health check response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from console.server.models.base import BaseResponse
from nanobot.utils.helpers import local_now


def _server_now() -> datetime:
    """Return current time (same zone as ``agents.defaults.timezone`` when configured)."""
    return local_now()


class HealthResponse(BaseResponse):
    """Health check response."""

    status: str = Field(default="ok", description="'ok' when healthy")
    version: str = Field(description="API version")
    timestamp: datetime = Field(default_factory=_server_now)
