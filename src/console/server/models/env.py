"""Environment variables API models."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class EnvResponse(BaseModel):
    """GET /env payload."""

    model_config = ConfigDict(extra="forbid")

    vars: dict[str, str]


class EnvPutBody(BaseModel):
    """PUT /env body."""

    model_config = ConfigDict(extra="forbid")

    vars: dict[str, str]


class EnvPutResponse(BaseModel):
    """PUT /env response (optional vars echo)."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    vars: dict[str, str] | None = None
