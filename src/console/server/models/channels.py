"""Channel operation models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class ChannelUpdateBody(BaseModel):
    """PUT /channels/{name} body."""

    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any]


class ChannelRefreshResult(BaseModel):
    """Refresh single channel result."""

    model_config = ConfigDict(extra="forbid")

    name: str
    success: bool
    message: str | None = None
