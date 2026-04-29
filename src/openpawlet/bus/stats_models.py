"""Pydantic models for :class:`~openpawlet.bus.queue.MessageBus` statistics and queue HTTP APIs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BusDedupeStats(BaseModel):
    """Dedupe counters on queue snapshots (in-process bus typically reports zeros)."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    hits: int = 0
    misses: int = 0
    size: int = 0
    persist_size: int = 0


class BusPausedFlags(BaseModel):
    """Pause switches aligned with :class:`~openpawlet.bus.queue.MessageBus`."""

    model_config = ConfigDict(extra="forbid")

    inbound: bool = False
    outbound: bool = False
    events: bool = False


class MessageBusStatsSnapshot(BaseModel):
    """Structured form of :meth:`~openpawlet.bus.queue.MessageBus.stats_snapshot`."""

    model_config = ConfigDict(extra="forbid")

    metrics: dict[str, int] = Field(default_factory=dict)
    rates: dict[str, float] = Field(default_factory=dict)
    paused: BusPausedFlags = Field(default_factory=BusPausedFlags)
    dedupe: BusDedupeStats = Field(default_factory=BusDedupeStats)
    samples: list[dict[str, Any]] = Field(default_factory=list)


class QueueModeBlock(BaseModel):
    """``settings`` / ``topology`` ``mode`` field on queue HTTP snapshots."""

    model_config = ConfigDict(extra="forbid")

    mode: str


class QueuesHttpSnapshot(BaseModel):
    """Full JSON body for ``GET .../queues/snapshot`` (in-process broker)."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    version: str
    uptime_s: float
    settings: QueueModeBlock
    topology: QueueModeBlock
    metrics: dict[str, int]
    rates: dict[str, float]
    paused: BusPausedFlags
    dedupe: BusDedupeStats
    connections: list[Any] = Field(default_factory=list)
    samples: list[dict[str, Any]] = Field(default_factory=list)


class QueuesHealthResponse(BaseModel):
    """Subset returned by ``GET .../queues/health``."""

    model_config = ConfigDict(extra="forbid")

    status: str
    version: str
    uptime_s: float
    metrics: dict[str, int]


class QueuesStreamTick(BaseModel):
    """WebSocket ``type: tick`` payload (omit ``samples`` when not subscribed)."""

    model_config = ConfigDict(extra="forbid")

    type: str = "tick"
    at: float
    metrics: dict[str, int]
    rates: dict[str, float]
    paused: BusPausedFlags
    dedupe: BusDedupeStats
    connections: list[Any] = Field(default_factory=list)
    samples: list[dict[str, Any]] | None = None


class QueuesGoneBody(BaseModel):
    """JSON body for queue admin endpoints that return 410 in the in-process layout."""

    model_config = ConfigDict(extra="forbid")

    error: str
    mode: str


__all__ = [
    "BusDedupeStats",
    "BusPausedFlags",
    "MessageBusStatsSnapshot",
    "QueueModeBlock",
    "QueuesGoneBody",
    "QueuesHealthResponse",
    "QueuesHttpSnapshot",
    "QueuesStreamTick",
]
