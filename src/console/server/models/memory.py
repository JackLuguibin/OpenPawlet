"""Memory API models."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class MemoryResponse(BaseModel):
    """GET /memory payload."""

    model_config = ConfigDict(extra="forbid")

    long_term: str
    history: str
