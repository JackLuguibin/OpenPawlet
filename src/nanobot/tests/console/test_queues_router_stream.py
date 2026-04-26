"""Tests for ``console.server.queues_router`` snapshot/stream endpoints.

The HTTP / WebSocket surface should reflect live ``MessageBus`` stats
once a bus is wired into ``app.state.message_bus``. Sample frames must
only flow after the client opts in via ``subscribe(['samples'])``.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.config import ServerSettings
from nanobot.bus.events import InboundMessage, OutboundMessage
from nanobot.bus.queue import MessageBus


@pytest.fixture
def app_with_bus(monkeypatch: pytest.MonkeyPatch):
    """Console app with the embedded runtime disabled and a real bus injected."""
    monkeypatch.setenv("OPENPAWLET_DISABLE_EMBEDDED", "1")
    settings = ServerSettings(
        host="127.0.0.1",
        port=8000,
        cors_origins=["http://test.example"],
        cors_allow_credentials=True,
        title="QueuesRouterTest",
        version="0.0.0-test",
    )
    app = create_app(settings, mount_spa=False)
    bus = MessageBus()
    app.state.message_bus = bus
    return app, bus


def _seed_bus(bus: MessageBus) -> None:
    """Push two messages so counters/samples are non-trivial."""
    import asyncio

    async def _go() -> None:
        await bus.publish_inbound(
            InboundMessage(channel="test", sender_id="u1", chat_id="c1", content="hello")
        )
        await bus.publish_outbound(
            OutboundMessage(channel="test", chat_id="c1", content="world")
        )

    asyncio.run(_go())


def test_snapshot_includes_metrics_rates_and_samples(app_with_bus) -> None:
    app, bus = app_with_bus
    _seed_bus(bus)
    with TestClient(app) as client:
        resp = client.get("/queues/snapshot")
    assert resp.status_code == 200
    snap = resp.json()
    assert snap["topology"] == {"mode": "in_process"}
    metrics = snap["metrics"]
    assert metrics["inbound_published_total"] == 1
    assert metrics["outbound_published_total"] == 1
    rates = snap["rates"]
    assert rates.get("inbound_forwarded", 0.0) > 0.0
    samples = snap["samples"]
    assert len(samples) == 2
    assert {s["direction"] for s in samples} == {
        "inbound_published",
        "outbound_published",
    }


def test_stream_tick_omits_samples_until_subscribed(app_with_bus) -> None:
    app, bus = app_with_bus
    _seed_bus(bus)
    with TestClient(app) as client:
        with client.websocket_connect("/queues/stream") as ws:
            tick = ws.receive_json()
            assert tick["type"] == "tick"
            assert "samples" not in tick
            assert tick["metrics"]["inbound_published_total"] == 1

            ws.send_text(json.dumps({"op": "subscribe", "topics": ["samples"]}))
            after = ws.receive_json()
            assert after["type"] == "tick"
            assert isinstance(after.get("samples"), list)
            assert len(after["samples"]) == 2

            ws.send_text(json.dumps({"op": "unsubscribe", "topics": ["samples"]}))
            cleared = ws.receive_json()
            assert cleared["type"] == "tick"
            assert "samples" not in cleared


def test_stream_alias_path_works(app_with_bus) -> None:
    """The legacy ``/queues-ws`` alias must hit the same handler."""
    app, _ = app_with_bus
    with TestClient(app) as client:
        with client.websocket_connect("/queues-ws") as ws:
            tick = ws.receive_json()
    assert tick["type"] == "tick"
    assert "metrics" in tick
