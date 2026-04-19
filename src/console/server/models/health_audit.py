"""Extended health / audit models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class HealthIssue(BaseModel):
    """Structured issue from an audit."""

    model_config = ConfigDict(extra="forbid")

    type: str
    severity: Literal["critical", "warning", "info"]
    message: str
    bot_id: str | None = None
    path: str | None = None
    metadata: dict[str, Any] | None = None


class HealthAuditResponse(BaseModel):
    """GET /health/audit payload."""

    model_config = ConfigDict(extra="forbid")

    issues: list[HealthIssue]
