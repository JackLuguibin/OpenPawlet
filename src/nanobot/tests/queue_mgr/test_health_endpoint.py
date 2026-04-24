"""Broker health endpoint returns metrics payload via aiohttp."""

from __future__ import annotations

import socket
import sys

import pytest

try:
    import zmq  # type: ignore  # noqa: F401

    HAS_ZMQ = True
except Exception:  # pragma: no cover
    HAS_ZMQ = False

pytestmark = [
    pytest.mark.skipif(not HAS_ZMQ, reason="pyzmq not installed"),
    pytest.mark.skipif(
        sys.platform == "win32", reason="broker sockets flaky on Windows CI"
    ),
]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.mark.asyncio
async def test_health_endpoint_returns_metrics() -> None:
    import aiohttp

    from queue_manager.config import QueueManagerSettings
    from queue_manager.service import QueueManagerBroker

    ports = [_free_port() for _ in range(7)]
    settings = QueueManagerSettings(
        host="127.0.0.1",
        ingress_port=ports[0],
        worker_port=ports[1],
        egress_port=ports[2],
        delivery_port=ports[3],
        events_ingress_port=ports[4],
        events_delivery_port=ports[5],
        health_host="127.0.0.1",
        health_port=ports[6],
    )
    broker = QueueManagerBroker(settings)
    await broker.start()
    try:
        async with aiohttp.ClientSession() as client:
            async with client.get(f"http://127.0.0.1:{ports[6]}/health") as r:
                assert r.status == 200
                body = await r.json()
        assert body["status"] == "ok"
        assert "metrics" in body
        assert "version" in body
    finally:
        await broker.stop()
