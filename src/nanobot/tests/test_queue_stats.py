"""Tests for the in-process queue manager stats added to ``MessageBus``.

These cover the counters/rate-window/samples bookkeeping introduced so
``/queues/snapshot`` and ``/queues/stream`` keep parity with the legacy
ZMQ broker, but in a single-process layout without persistence.
"""

from __future__ import annotations

import asyncio

import pytest

from nanobot.bus.events import AgentEvent, InboundMessage, OutboundMessage
from nanobot.bus.queue import _RATE_WINDOW_S, _SAMPLE_CAPACITY, MessageBus


def _ib(text: str = "hi") -> InboundMessage:
    return InboundMessage(channel="test", sender_id="u1", chat_id="c1", content=text)


def _ob(text: str = "ack") -> OutboundMessage:
    return OutboundMessage(channel="test", chat_id="c1", content=text)


@pytest.mark.asyncio
async def test_publish_consume_updates_counters_and_samples() -> None:
    bus = MessageBus()
    for i in range(3):
        await bus.publish_inbound(_ib(f"in-{i}"))
        await bus.publish_outbound(_ob(f"out-{i}"))
    # Drain so consume_* counters move too.
    for _ in range(3):
        await bus.consume_inbound()
        await bus.consume_outbound()

    snap = bus.stats_snapshot()
    metrics = snap["metrics"]
    assert metrics["inbound_pending"] == 0
    assert metrics["outbound_pending"] == 0
    assert metrics["inbound_published_total"] == 3
    assert metrics["inbound_consumed_total"] == 3
    assert metrics["outbound_published_total"] == 3
    assert metrics["outbound_consumed_total"] == 3

    # Only publish_* should produce samples (consume samples=False).
    samples = snap["samples"]
    assert len(samples) == 6
    directions = {s["direction"] for s in samples}
    assert directions == {"inbound_published", "outbound_published"}
    for sample in samples:
        assert sample["message_id"]
        assert sample["trace_id"]
        assert sample["bytes"] > 0
        assert "kind" in sample and sample["kind"].startswith("channel:test")


@pytest.mark.asyncio
async def test_rates_decay_when_window_elapses() -> None:
    bus = MessageBus()
    await bus.publish_inbound(_ib())
    rates_now = bus.stats_snapshot()["rates"]
    assert rates_now["inbound_published"] > 0
    assert rates_now["inbound_forwarded"] == rates_now["inbound_published"]

    # Reach into the rate window and age the sample past _RATE_WINDOW_S so
    # _trim_rate_window() drops it on the next snapshot. Avoids a real sleep.
    aged = [(ts - (_RATE_WINDOW_S + 1.0), direction) for ts, direction in bus._rate_window]
    bus._rate_window.clear()
    bus._rate_window.extend(aged)

    rates_after = bus.stats_snapshot()["rates"]
    assert rates_after.get("inbound_published", 0.0) == 0.0
    assert rates_after.get("inbound_forwarded", 0.0) == 0.0


@pytest.mark.asyncio
async def test_samples_buffer_is_bounded_fifo() -> None:
    bus = MessageBus()
    overflow = _SAMPLE_CAPACITY + 5
    for i in range(overflow):
        await bus.publish_inbound(_ib(f"msg-{i}"))

    samples = bus.recent_samples()
    assert len(samples) == _SAMPLE_CAPACITY
    # The oldest 5 entries must have been dropped (FIFO eviction).
    first_session = samples[0]["session_key"]
    assert first_session == "test:c1"
    # Newest sample reflects the latest published payload bytes.
    assert samples[-1]["bytes"] == len(f"msg-{overflow - 1}".encode())


@pytest.mark.asyncio
async def test_event_publish_increments_event_counters() -> None:
    bus = MessageBus()
    sub = bus.subscribe_events(agent_id="alice")
    try:
        await bus.publish_event(AgentEvent(topic="cron.fired", source_agent="system"))
        # Drain the delivered event so the subscription queue does not leak.
        await asyncio.wait_for(sub.get(), timeout=0.5)
    finally:
        sub.close()

    metrics = bus.stats_snapshot()["metrics"]
    assert metrics["events_published_total"] == 1
    assert metrics["events_delivered_total"] == 1
    assert metrics["events_dropped_mailbox_total"] == 0
