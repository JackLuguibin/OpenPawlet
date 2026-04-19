"""Health check response models."""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import Field

from console.server.models.base import BaseResponse


def _utc_now() -> datetime:
    """Return current time in UTC (timezone-aware)."""
    return datetime.now(UTC)


class HealthResponse(BaseResponse):
    """Health check response."""

    status: str = Field(default="ok", description="'ok' when healthy")
    version: str = Field(description="API version")
    timestamp: datetime = Field(default_factory=_utc_now)
