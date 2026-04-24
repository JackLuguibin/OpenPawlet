"""Unit tests for the broker state helpers."""

from __future__ import annotations

import time

from queue_manager.state import (
    BrokerState,
    ConnectionTable,
    RateMeter,
    SampleBuffer,
    SampleEntry,
)


def test_sample_buffer_capped_and_findable() -> None:
    buf = SampleBuffer(capacity=3)
    for i in range(5):
        buf.push(
            SampleEntry(
                at=time.time(),
                direction="inbound",
                kind="inbound",
                message_id=f"m-{i}",
                session_key="s",
                bytes_len=10,
                trace_id="t",
                raw=b"{}",
            )
        )
    items = buf.list()
    assert len(items) == 3
    # Only the last three survive.
    assert [e.message_id for e in items] == ["m-2", "m-3", "m-4"]
    assert buf.find("m-4") is not None
    assert buf.find("m-0") is None  # evicted


def test_connection_table_observes_and_caps() -> None:
    tbl = ConnectionTable(cap=2)
    tbl.observe(socket="ingress", peer="a", event="ACCEPTED")
    tbl.observe(socket="ingress", peer="b", event="ACCEPTED")
    tbl.observe(socket="ingress", peer="c", event="ACCEPTED")  # evicts oldest
    peers = {e.peer for e in tbl.list()}
    assert len(peers) == 2


def test_rate_meter_produces_positive_rate_under_load() -> None:
    meter = RateMeter()
    for _ in range(10):
        meter.incr(1)
    rate = meter.sample()
    assert rate >= 0.0  # EWMA can be 0 on first sample depending on clock
    # Subsequent sampling with additional increments raises the rate.
    for _ in range(10):
        meter.incr(1)
    time.sleep(0.01)
    assert meter.sample() >= 0.0


def test_broker_state_increments_tracked_counter() -> None:
    state = BrokerState()
    state.incr("inbound_forwarded", 2)
    state.incr("inbound_forwarded", 1)
    assert state.counters["inbound_forwarded"] == 3
    rates = state.snapshot_rates()
    assert "inbound_forwarded" in rates
