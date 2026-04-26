"""Aggregated observability payload for the console UI."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ConsoleObservabilityInfo(BaseModel):
    """OpenPawlet console API process."""

    model_config = ConfigDict(extra="forbid")

    status: str = Field(description="Liveness, typically 'ok'")
    version: str = Field(description="Console server / API version string")


class NanobotGatewayInfo(BaseModel):
    """``GET {gateway}/health`` probe from the bot config's gateway host:port."""

    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(description="URL that was probed")
    ok: bool = Field(description="True when HTTP 200 and body looks healthy")
    status: str | None = Field(default=None, description="`status` field from JSON body if present")
    version: str | None = Field(
        default=None, description="`version` from nanobot gateway if present"
    )
    uptime_s: float | None = Field(default=None, description="`uptime_s` from nanobot if present")
    error: str | None = Field(default=None, description="Probe or parse error, when not ok")


class ObservabilityResponse(BaseModel):
    """GET /observability payload."""

    model_config = ConfigDict(extra="forbid")

    console: ConsoleObservabilityInfo
    nanobot_gateway: NanobotGatewayInfo


class AgentObservabilityEvent(BaseModel):
    """One observability event row (JSONL on disk; optional in-memory buffer)."""

    model_config = ConfigDict(extra="forbid")

    ts: float
    event: str = Field(description="run_start | run_end | llm | tool")
    trace_id: str | None = None
    session_key: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentObservabilityTimeline(BaseModel):
    """GET /observability/timeline — events read from data-dir JSONL (newest first)."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    source_endpoint: str
    error: str | None = None
    events: list[AgentObservabilityEvent] = Field(default_factory=list)
