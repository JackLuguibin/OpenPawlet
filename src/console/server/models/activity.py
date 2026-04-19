"""Activity feed models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class ActivityItem(BaseModel):
    """Recent activity row."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    title: str
    description: str | None = None
    timestamp: str
    metadata: dict[str, Any] | None = None
