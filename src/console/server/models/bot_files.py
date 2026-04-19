"""Bot profile files (SOUL, USER, …)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class BotFilesResponse(BaseModel):
    """GET /bot-files payload."""

    model_config = ConfigDict(extra="forbid")

    soul: str
    user: str
    heartbeat: str
    tools: str
    agents: str


class BotFileUpdateBody(BaseModel):
    """PUT /bot-files/{key} body."""

    model_config = ConfigDict(extra="forbid")

    content: str
