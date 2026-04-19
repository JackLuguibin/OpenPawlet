"""Wait for backend TCP ports before starting the Vite dev server (honcho-friendly)."""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import time
from urllib.parse import urlencode


def wait_for_tcp(host: str, port: int, timeout: float) -> None:
    """Block until ``host:port`` accepts a connection or ``timeout`` seconds pass."""
    deadline = time.monotonic() + timeout
    label = f"{host}:{port}"
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return
        except OSError:
            time.sleep(0.25)
    print(
        f"timeout: nothing accepted TCP on {label} after {timeout}s.",
        file=sys.stderr,
    )
    raise SystemExit(1)


async def _wait_until_nanobot_ws_handshake(uri: str, deadline: float) -> None:
    """Run a real WebSocket upgrade, then close (OK for ``websockets`` servers)."""
    import websockets

    last_exc: BaseException | None = None
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        open_timeout = min(5.0, max(1.0, remaining))
        try:
            async with websockets.connect(
                uri,
                ping_interval=None,
                open_timeout=open_timeout,
                close_timeout=3,
            ) as ws:
                await ws.close()
            return
        except Exception as exc:
            last_exc = exc
            await asyncio.sleep(0.25)
    raise TimeoutError(last_exc)


def wait_for_nanobot_websocket(host: str, port: int, timeout: float) -> None:
    """Block until a WebSocket handshake to the nanobot gateway succeeds."""
    query = urlencode({"client_id": "nanobot-web"})
    uri = f"ws://{host}:{port}/?{query}"
    label = f"{host}:{port}"
    deadline = time.monotonic() + timeout
    try:
        asyncio.run(_wait_until_nanobot_ws_handshake(uri, deadline))
    except TimeoutError as exc:
        inner = exc.args[0] if exc.args else None
        print(
            f"timeout: WebSocket handshake to {label} did not succeed after "
            f"{timeout}s (last error: {inner!r}).",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc


def wait_for_dev_stack() -> None:
    """Wait for the console HTTP API and the nanobot gateway WebSocket port."""
    api_port = int(
        os.environ.get("NANOBOT_SERVER_PORT")
        or os.environ.get("VITE_API_PORT")
        or "8000",
    )
    ws_host = os.environ.get("VITE_NANOBOT_WS_HOST") or "127.0.0.1"
    ws_port = int(os.environ.get("VITE_NANOBOT_WS_PORT") or "8765")
    per = float(os.environ.get("WAIT_FOR_DEV_STACK_TIMEOUT") or "90")

    wait_for_tcp("127.0.0.1", api_port, per)
    wait_for_nanobot_websocket(ws_host, ws_port, per)
