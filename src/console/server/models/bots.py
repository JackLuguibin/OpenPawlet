"""Bot resource models (aligned with web ``types.ts``)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class BotInfo(BaseModel):
    """Single bot record."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    config_path: str
    workspace_path: str
    created_at: str
    updated_at: str
    is_default: bool
    running: bool


class CreateBotRequest(BaseModel):
    """POST /bots body."""

    model_config = ConfigDict(extra="forbid")

    name: str
    source_config: dict[str, Any] | None = None


class SetDefaultBotBody(BaseModel):
    """PUT /bots/default body."""

    model_config = ConfigDict(extra="forbid")

    bot_id: str


def placeholder_bot(*, bot_id: str = "stub-bot") -> BotInfo:
    """Return a minimal valid bot row for stub responses."""
    ts = "1970-01-01T00:00:00Z"
    return BotInfo(
        id=bot_id,
        name="Stub Bot",
        config_path="",
        workspace_path="",
        created_at=ts,
        updated_at=ts,
        is_default=True,
        running=False,
    )
