"""Tests for the Queue Manager idempotency store.

The store is the main mechanism that lifts the ZeroMQ broker from
"at-least-once" to "business-level exactly once", so it is worth
exercising dedupe, eviction and persistence in isolation.
"""

from __future__ import annotations

from pathlib import Path

from queue_manager.idempotency import IdempotencyStore


def test_first_accept_then_duplicate_rejected(tmp_path: Path) -> None:
    store = IdempotencyStore(window_seconds=60, max_entries=128)
    assert store.try_accept("m-a") is True
    assert store.try_accept("m-a") is False
    stats = store.stats()
    assert stats["hits"] == 1
    assert stats["misses"] == 1


def test_empty_message_id_is_always_accepted() -> None:
    store = IdempotencyStore(window_seconds=60, max_entries=128)
    assert store.try_accept("") is True
    assert store.try_accept("") is True


def test_lru_eviction_drops_oldest_entries() -> None:
    store = IdempotencyStore(window_seconds=60, max_entries=2)
    assert store.try_accept("m-1") is True
    assert store.try_accept("m-2") is True
    assert store.try_accept("m-3") is True  # evicts m-1
    # m-2 is still within capacity, duplicate rejected.
    assert store.try_accept("m-2") is False
    # m-1 was evicted, so it can slip in again (known trade-off of LRU
    # dedupe without persistence).
    assert store.try_accept("m-1") is True


def test_persistence_replays_seen_ids(tmp_path: Path) -> None:
    path = tmp_path / "dedupe.log"
    first = IdempotencyStore(window_seconds=600, max_entries=128, persist_path=path)
    assert first.try_accept("m-x") is True

    # A fresh store loading the same file must reject m-x to emulate
    # broker-restart crash recovery.
    second = IdempotencyStore(window_seconds=600, max_entries=128, persist_path=path)
    assert second.try_accept("m-x") is False
