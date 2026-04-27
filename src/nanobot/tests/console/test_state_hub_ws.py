"""Tests for the ``/ws/state`` server-driven state push channel.

Covers:

    * the welcome + initial-snapshot handshake the SPA relies on for fast
      hydration without an extra ``GET /status`` round-trip;
    * the ``ping``/``pong`` keepalive (round-trip RTT measurement);
    * routing by ``bot_id`` so a frame published for one bot is not
      delivered to a subscriber listening to another bot;
    * the resubscribe flow used when the SPA switches active bots
      mid-connection.

The embedded nanobot runtime is disabled via
``OPENPAWLET_DISABLE_EMBEDDED`` to keep the test hermetic.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.state_hub import (
    publish_channels_update,
    publish_status_update,
)


@pytest.fixture
def app_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("OPENPAWLET_DISABLE_EMBEDDED", "1")
    app = create_app()
    return TestClient(app)


def _drain_until(ws, predicate, max_frames: int = 10):  # type: ignore[no-untyped-def]
    """Read frames until *predicate* matches or *max_frames* is exhausted."""
    for _ in range(max_frames):
        frame = ws.receive_json()
        if predicate(frame):
            return frame
    raise AssertionError("predicate never matched")


def test_welcome_frame_sent_immediately(app_client: TestClient) -> None:
    """The first frame after upgrade must be ``welcome``.

    The SPA waits for this frame before it sends ``subscribe`` messages,
    so any regression would manifest as cold-start subscriptions never
    binding to a bot.
    """
    with app_client:
        with app_client.websocket_connect("/ws/state") as ws:
            first = ws.receive_json()
    assert first["type"] == "welcome"
    assert "ping_interval" in first["data"]


def test_initial_snapshots_pushed_when_bot_id_supplied(
    app_client: TestClient,
) -> None:
    """``?bot_id=`` triggers the four hydration snapshots in any order."""
    expected = {
        "status_update",
        "sessions_update",
        "channels_update",
        "mcp_update",
    }
    with app_client:
        with app_client.websocket_connect("/ws/state?bot_id=t") as ws:
            assert ws.receive_json()["type"] == "welcome"
            seen: set[str] = set()
            for _ in range(8):
                frame = ws.receive_json()
                seen.add(frame["type"])
                if expected.issubset(seen):
                    break
    assert expected.issubset(seen), f"missing snapshots: {expected - seen}"


def test_ping_pong_roundtrip(app_client: TestClient) -> None:
    with app_client:
        with app_client.websocket_connect("/ws/state") as ws:
            ws.receive_json()  # consume welcome
            ws.send_json({"type": "ping", "t": 42.5})
            pong = _drain_until(ws, lambda f: f.get("type") == "pong")
    assert pong["data"]["t"] == 42.5


def test_publish_routed_to_matching_bot(app_client: TestClient) -> None:
    """A frame published for ``bot_id`` reaches a subscriber on that bot.

    We deliberately verify only the positive direction here: confirming
    the *negative* (a subscriber for a different bot does **not** see
    the frame) would require waiting for "nothing to happen" inside a
    ``TestClient`` WS thread, which has no non-blocking peek API.
    Routing isolation is exercised by the unit tests on
    :class:`StateHub` directly.
    """
    with app_client:
        with app_client.websocket_connect("/ws/state?bot_id=A") as ws_a:
            ws_a.receive_json()  # welcome
            publish_channels_update("A", [{"name": "fake", "enabled": True}])
            # Wait for *our* publish, not the initial-snapshot one (the
            # SPA cannot tell the difference but tests need to so they
            # don't false-positive on bootstrap data).
            frame = _drain_until(
                ws_a,
                lambda f: f.get("type") == "channels_update"
                and any(
                    isinstance(c, dict) and c.get("name") == "fake"
                    for c in f.get("data", {}).get("channels", [])
                ),
            )
    assert frame["data"]["bot_id"] == "A"


def test_subscribe_retargets_existing_socket(app_client: TestClient) -> None:
    """The SPA switches active bot without dropping the connection."""
    with app_client:
        with app_client.websocket_connect("/ws/state") as ws:
            ws.receive_json()  # welcome
            ws.send_json({"type": "subscribe", "bot_id": "Z"})
            publish_status_update("Z", {"running": True, "channels": []})
            frame = _drain_until(
                ws, lambda f: f.get("type") == "status_update"
                and f.get("data", {}).get("bot_id") == "Z"
            )
    assert frame["data"]["bot_id"] == "Z"
