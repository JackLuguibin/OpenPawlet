"""Runtime state aggregation for the Queue Manager broker.

This module keeps everything the admin UI wants to look at in one
place so the HTTP / WebSocket layers only need to serialize the
result of a single :meth:`BrokerState.snapshot` call.

Components:

- :class:`RateMeter` - cheap EWMA counter used for per-direction rates.
- :class:`SampleBuffer` - fixed-size ring of recent message envelopes
  (metadata only, full payload bytes stored so they can be replayed).
- :class:`ConnectionTable` - socket event observer fed by ZeroMQ monitor
  frames.  Stores peer/role/last-event per tracked connection.
- :class:`BrokerState` - owns all of the above plus the pause flags.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

# Bound the connection table: ZeroMQ inproc tests can produce many
# peers quickly, and a runaway producer must not blow up memory.
_CONNECTIONS_HARD_CAP = 500
_DEFAULT_SAMPLE_CAP = 100


@dataclass
class SampleEntry:
    """A single entry in :class:`SampleBuffer` (metadata + raw bytes)."""

    at: float
    direction: str  # "inbound" or "outbound"
    kind: str  # envelope kind field
    message_id: str
    session_key: str
    bytes_len: int
    trace_id: str
    raw: bytes = field(repr=False)

    def as_dict(self) -> dict[str, Any]:
        """JSON-friendly projection (never include ``raw`` here)."""
        return {
            "at": self.at,
            "direction": self.direction,
            "kind": self.kind,
            "message_id": self.message_id,
            "session_key": self.session_key,
            "bytes": self.bytes_len,
            "trace_id": self.trace_id,
        }


class SampleBuffer:
    """Thread-safe ring buffer of :class:`SampleEntry`."""

    def __init__(self, capacity: int = _DEFAULT_SAMPLE_CAP) -> None:
        self._capacity = max(1, int(capacity))
        self._items: deque[SampleEntry] = deque(maxlen=self._capacity)
        self._lock = threading.Lock()

    def push(self, entry: SampleEntry) -> None:
        with self._lock:
            self._items.append(entry)

    def list(self) -> list[SampleEntry]:
        with self._lock:
            return list(self._items)

    def find(self, message_id: str) -> SampleEntry | None:
        """Return the most recent entry for *message_id* (or None)."""
        if not message_id:
            return None
        with self._lock:
            for entry in reversed(self._items):
                if entry.message_id == message_id:
                    return entry
        return None

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


class RateMeter:
    """Bucketed counter that yields ``per_second`` rates via EWMA."""

    def __init__(self, alpha: float = 0.3) -> None:
        self._alpha = float(alpha)
        self._lock = threading.Lock()
        self._ewma: float = 0.0
        self._last_ts: float = time.monotonic()
        self._pending: float = 0.0

    def incr(self, amount: float = 1.0) -> None:
        with self._lock:
            self._pending += amount

    def sample(self) -> float:
        """Compute the current rate and reset the pending counter."""
        now = time.monotonic()
        with self._lock:
            elapsed = max(1e-6, now - self._last_ts)
            observed = self._pending / elapsed
            self._ewma = (
                (1 - self._alpha) * self._ewma + self._alpha * observed
                if self._last_ts > 0
                else observed
            )
            self._pending = 0.0
            self._last_ts = now
            return round(self._ewma, 3)


@dataclass
class ConnectionEntry:
    """One observed peer connection on a broker socket."""

    socket: str  # "ingress" / "worker" / "egress" / "delivery"
    peer: str
    since: float
    last_event: str
    last_event_at: float
    event_count: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "socket": self.socket,
            "peer": self.peer,
            "since": self.since,
            "last_event": self.last_event,
            "last_event_at": self.last_event_at,
            "event_count": self.event_count,
        }


class ConnectionTable:
    """Bounded, thread-safe map of (socket, peer) to :class:`ConnectionEntry`."""

    def __init__(self, cap: int = _CONNECTIONS_HARD_CAP) -> None:
        self._cap = max(1, int(cap))
        self._entries: dict[tuple[str, str], ConnectionEntry] = {}
        self._lock = threading.Lock()

    def observe(
        self,
        *,
        socket: str,
        peer: str,
        event: str,
    ) -> None:
        """Record a socket monitor event for (socket, peer)."""
        if not peer:
            return
        now = time.time()
        key = (socket, peer)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                if len(self._entries) >= self._cap:
                    # Drop the oldest entry to keep the table bounded.
                    oldest_key = next(iter(self._entries))
                    self._entries.pop(oldest_key, None)
                entry = ConnectionEntry(
                    socket=socket,
                    peer=peer,
                    since=now,
                    last_event=event,
                    last_event_at=now,
                    event_count=1,
                )
                self._entries[key] = entry
                return
            entry.last_event = event
            entry.last_event_at = now
            entry.event_count += 1
            if event in {"DISCONNECTED", "CLOSED"}:
                # Keep the row so the UI can show "recently disconnected"
                # until it naturally ages out via LRU eviction.
                pass

    def drop_peer(self, socket: str, peer: str) -> None:
        with self._lock:
            self._entries.pop((socket, peer), None)

    def list(self) -> list[ConnectionEntry]:
        with self._lock:
            return list(self._entries.values())


class BrokerState:
    """Holds everything the admin HTTP/WS layers want to expose."""

    def __init__(self, *, sample_capacity: int = _DEFAULT_SAMPLE_CAP) -> None:
        self.counters: dict[str, int] = {
            "inbound_forwarded": 0,
            "inbound_dropped_duplicate": 0,
            "inbound_dropped_paused": 0,
            "inbound_bytes_total": 0,
            "outbound_forwarded": 0,
            "outbound_dropped_duplicate": 0,
            "outbound_dropped_paused": 0,
            "outbound_bytes_total": 0,
            "malformed_frames": 0,
            "replayed": 0,
            "dedupe_clears": 0,
        }
        self.rates: dict[str, RateMeter] = {
            "inbound_forwarded": RateMeter(),
            "inbound_dropped_duplicate": RateMeter(),
            "outbound_forwarded": RateMeter(),
            "outbound_dropped_duplicate": RateMeter(),
        }
        self.samples = SampleBuffer(capacity=sample_capacity)
        self.connections = ConnectionTable()
        self.paused: dict[str, bool] = {"inbound": False, "outbound": False}

    # --- counters ----
    def incr(self, name: str, amount: int = 1) -> None:
        if name in self.counters:
            self.counters[name] += amount
        else:
            self.counters[name] = amount
        rate = self.rates.get(name)
        if rate is not None:
            rate.incr(float(amount))

    # --- samples ----
    def record_sample(self, entry: SampleEntry) -> None:
        self.samples.push(entry)

    # --- snapshot ----
    def snapshot_rates(self) -> dict[str, float]:
        return {name: meter.sample() for name, meter in self.rates.items()}
