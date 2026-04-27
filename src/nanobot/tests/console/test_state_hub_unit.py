"""Unit tests for :class:`console.server.state_hub.StateHub`.

These run without spinning up the FastAPI app so we can exercise the
fan-out routing rules (per-bot delivery, wildcard delivery, slow-consumer
drop-oldest behaviour) deterministically.  The integration tests
(``test_state_hub_ws.py``) cover the wire format on top of this.
"""

from __future__ import annotations

import asyncio

import pytest

from console.server.state_hub import StateHub


@pytest.mark.asyncio
async def test_per_bot_routing_isolates_subscribers() -> None:
    """A frame for bot A must reach A's subscriber but not B's."""
    hub = StateHub()
    hub.bind_loop(asyncio.get_running_loop())
    sub_a = await hub.register_subscriber("A")
    sub_b = await hub.register_subscriber("B")

    hub.publish({"type": "status_update", "data": {"x": 1}}, bot_id="A")

    frame_a = await asyncio.wait_for(sub_a.queue.get(), timeout=0.5)
    assert frame_a["data"]["x"] == 1

    # B should not receive anything; with a short timeout we treat the
    # absence as success.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(sub_b.queue.get(), timeout=0.1)


@pytest.mark.asyncio
async def test_wildcard_publish_reaches_every_subscriber() -> None:
    """``bot_id=None`` is the broadcast channel (used for ``bots_update``)."""
    hub = StateHub()
    hub.bind_loop(asyncio.get_running_loop())
    sub_a = await hub.register_subscriber("A")
    sub_b = await hub.register_subscriber("B")

    hub.publish({"type": "bots_update", "data": {}}, bot_id=None)

    frame_a = await asyncio.wait_for(sub_a.queue.get(), timeout=0.5)
    frame_b = await asyncio.wait_for(sub_b.queue.get(), timeout=0.5)
    assert frame_a["type"] == frame_b["type"] == "bots_update"


@pytest.mark.asyncio
async def test_subscriber_with_no_filter_receives_targeted_frames() -> None:
    """Subscribers that have not picked a bot still get every frame.

    The handler binds ``bot_id`` from the connect-time query parameter
    or the SPA's ``subscribe`` frame; until either runs the subscriber
    is in wildcard mode.  This matches the welcome-then-subscribe
    handshake the SPA uses.
    """
    hub = StateHub()
    hub.bind_loop(asyncio.get_running_loop())
    sub = await hub.register_subscriber()  # no bot_id

    hub.publish({"type": "status_update", "data": {"x": 1}}, bot_id="A")
    frame = await asyncio.wait_for(sub.queue.get(), timeout=0.5)
    assert frame["data"]["x"] == 1


@pytest.mark.asyncio
async def test_slow_subscriber_loses_oldest_frame_not_newest() -> None:
    """Drop-oldest preserves the freshest state for late drains."""
    hub = StateHub()
    hub.bind_loop(asyncio.get_running_loop())
    sub = await hub.register_subscriber("A")
    # Force the queue to its bound by hand so we can prove drop-oldest
    # without flooding 64 frames first.
    sub.queue = asyncio.Queue(maxsize=2)

    hub.publish({"type": "status_update", "data": {"i": 1}}, bot_id="A")
    hub.publish({"type": "status_update", "data": {"i": 2}}, bot_id="A")
    # Yield once so the call_soon_threadsafe-scheduled callbacks run.
    await asyncio.sleep(0)
    hub.publish({"type": "status_update", "data": {"i": 3}}, bot_id="A")
    await asyncio.sleep(0)

    # Queue size is 2; the oldest (i=1) was dropped to make room for i=3.
    received = [
        (await asyncio.wait_for(sub.queue.get(), timeout=0.5))["data"]["i"]
        for _ in range(2)
    ]
    assert received == [2, 3]


@pytest.mark.asyncio
async def test_unregister_drops_subscriber_from_dispatch() -> None:
    hub = StateHub()
    hub.bind_loop(asyncio.get_running_loop())
    sub = await hub.register_subscriber("A")
    await hub.unregister_subscriber(sub)
    hub.publish({"type": "status_update", "data": {}}, bot_id="A")
    await asyncio.sleep(0)
    assert sub.queue.empty()
    assert hub.subscriber_count == 0
