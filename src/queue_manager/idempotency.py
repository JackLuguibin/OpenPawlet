"""Idempotency store that powers business-level "exactly once" semantics.

The store is intentionally simple:

- An in-memory LRU cache keyed by ``message_id`` with a wall-clock TTL.
- An optional append-only file so that broker restarts do not replay
  messages that were already accepted.

The broker calls :meth:`IdempotencyStore.try_accept` for every envelope
it receives on the ingress / egress socket.  If the id is new, the
method returns ``True`` and the broker forwards the frame; otherwise
``False`` and the frame is dropped with a metric increment.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from pathlib import Path


class IdempotencyStore:
    """LRU + TTL store with optional append-only persistence."""

    def __init__(
        self,
        *,
        window_seconds: int,
        max_entries: int,
        persist_path: Path | None = None,
    ) -> None:
        self._window = float(window_seconds)
        self._max_entries = max(1, int(max_entries))
        self._persist_path = persist_path
        self._entries: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        self._load_from_disk()

    # ---- public API ------------------------------------------------------
    def try_accept(self, message_id: str) -> bool:
        """Return ``True`` if *message_id* has not been seen recently.

        Thread-safe: the broker may call this from multiple pump tasks.
        """
        if not message_id:
            # Unknown ids are always accepted - we cannot dedupe anything
            # sensibly without a key, and dropping legitimate traffic is
            # worse than a rare double delivery.
            self._misses += 1
            return True
        now = time.monotonic()
        with self._lock:
            self._evict_expired_locked(now)
            if message_id in self._entries:
                self._entries.move_to_end(message_id)
                self._hits += 1
                return False
            self._entries[message_id] = now
            self._entries.move_to_end(message_id)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
            self._misses += 1
        self._append_to_disk(message_id)
        return True

    def stats(self) -> dict[str, int]:
        """Return the current hit / miss counters (cheap, for observability)."""
        with self._lock:
            persist_size = 0
            if self._persist_path is not None:
                try:
                    persist_size = self._persist_path.stat().st_size
                except OSError:
                    persist_size = 0
            return {
                "hits": self._hits,
                "misses": self._misses,
                "size": len(self._entries),
                "persist_size": persist_size,
            }

    def forget(self, message_id: str) -> bool:
        """Drop *message_id* from the memory cache (replay bypass helper).

        Returns True when an entry was removed.  Note this does not
        truncate the persistent file on purpose - the broker only
        needs a short-lived bypass to re-publish a frame.
        """
        if not message_id:
            return False
        with self._lock:
            return self._entries.pop(message_id, None) is not None

    def clear(self, *, scope: str = "memory") -> dict[str, int]:
        """Reset the dedupe table.

        Args:
            scope: ``memory`` wipes the in-memory cache only, ``persist``
                truncates the persistence file only, ``both`` does both.
        """
        memory_cleared = 0
        persist_bytes_cleared = 0
        if scope in {"memory", "both"}:
            with self._lock:
                memory_cleared = len(self._entries)
                self._entries.clear()
        if scope in {"persist", "both"} and self._persist_path is not None:
            try:
                persist_bytes_cleared = self._persist_path.stat().st_size
            except OSError:
                persist_bytes_cleared = 0
            try:
                self._persist_path.write_text("", encoding="utf-8")
            except OSError:
                pass
        return {
            "memory_cleared": memory_cleared,
            "persist_bytes_cleared": persist_bytes_cleared,
        }

    # ---- internals -------------------------------------------------------
    def _evict_expired_locked(self, now: float) -> None:
        cutoff = now - self._window
        while self._entries:
            first_id, first_ts = next(iter(self._entries.items()))
            if first_ts < cutoff:
                self._entries.popitem(last=False)
            else:
                break

    def _load_from_disk(self) -> None:
        if not self._persist_path or not self._persist_path.exists():
            return
        try:
            with self._persist_path.open("r", encoding="utf-8") as f:
                for line in f:
                    mid = line.strip()
                    if mid:
                        self._entries[mid] = time.monotonic()
                        if len(self._entries) > self._max_entries:
                            self._entries.popitem(last=False)
        except OSError:
            # A missing or unreadable file is non-fatal: the broker still
            # runs in memory-only mode.
            pass

    def _append_to_disk(self, message_id: str) -> None:
        if not self._persist_path:
            return
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            with self._persist_path.open("a", encoding="utf-8") as f:
                f.write(message_id + "\n")
        except OSError:
            pass
