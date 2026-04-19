"""Alert models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class Alert(BaseModel):
    """Alert row."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    severity: Literal["critical", "warning", "info"]
    message: str
    bot_id: str | None = None
    created_at_ms: int
    dismissed: bool
    metadata: dict[str, Any] | None = None
