"""End-to-end tests for the unified console FastAPI application.

Covers the consolidated layout where the console hosts the REST surface,
the OpenAI-compatible ``/v1/*`` routes, the ``/queues/*`` admin surface,
the ``/nanobot-ws/*`` reverse-proxy and the SPA fallback in a single
process.

The embedded nanobot runtime is disabled via ``OPENPAWLET_DISABLE_EMBEDDED``
so the test does not need real provider credentials, MCP servers or
channel configuration; the agent loop is monkeypatched in directly when
needed.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.config import ServerSettings


@pytest.fixture
def disable_embedded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENPAWLET_DISABLE_EMBEDDED", "1")


@pytest.fixture
def settings() -> ServerSettings:
    """Settings tuned for tests: localhost loopback, no SPA, narrow CORS."""
    return ServerSettings(
        host="127.0.0.1",
        port=8000,
        cors_origins=["http://test.example"],
        cors_allow_credentials=True,
        title="UnifiedTest",
        version="0.0.0-test",
    )


@pytest.fixture
def app_no_embed(disable_embedded: None, settings: ServerSettings):
    """A fresh unified app with the embedded runtime disabled."""
    return create_app(settings, mount_spa=False)


def test_lifespan_brings_up_and_tears_down_subsystems(
    monkeypatch: pytest.MonkeyPatch, settings: ServerSettings
) -> None:
    """A fake EmbeddedNanobot must see start() then stop() during lifespan."""
    monkeypatch.delenv("OPENPAWLET_DISABLE_EMBEDDED", raising=False)
    started = asyncio.Event()
    stopped = asyncio.Event()

    class _FakeAgent:
        model = "fake-model"

    class _FakeBus:
        inbound_size = 0
        outbound_size = 0

    class _FakeSessions:
        pass

    class _FakeEmbedded:
        agent = _FakeAgent()
        message_bus = _FakeBus()
        session_manager = _FakeSessions()

        @classmethod
        def from_environment(cls, **_kw: Any) -> _FakeEmbedded:
            return cls()

        async def start(self) -> None:
            started.set()

        async def stop(self) -> None:
            stopped.set()

    import nanobot.runtime.embedded as embedded_mod

    monkeypatch.setattr(embedded_mod, "EmbeddedNanobot", _FakeEmbedded)

    app = create_app(settings, mount_spa=False)
    with TestClient(app) as client:
        assert started.is_set()
        # Settings should now have agent_loop wired up via lifespan.
        assert client.app.state.agent_loop is not None
        assert client.app.state.message_bus is not None
    assert stopped.is_set()


def test_cors_middleware_applied(app_no_embed) -> None:
    with TestClient(app_no_embed) as client:
        resp = client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://test.example",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.headers.get("access-control-allow-origin") == "http://test.example"


def test_validation_error_envelope(app_no_embed) -> None:
    """OpenAI handler returns a JSON error envelope on bad payloads."""

    # Wire a fake agent so the handler reaches the JSON parser path.
    class _FakeAgent:
        async def process_direct(self, **_kw: Any) -> Any:  # pragma: no cover
            return None

    app_no_embed.state.agent_loop = _FakeAgent()
    app_no_embed.state.openai_session_locks = {}

    with TestClient(app_no_embed) as client:
        resp = client.post(
            "/v1/chat/completions",
            content=b"not json",
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["message"] == "Invalid JSON body"


def test_internal_error_envelope(app_no_embed, monkeypatch: pytest.MonkeyPatch) -> None:
    """Uncaught exceptions in routes are wrapped in ErrorResponse."""

    @app_no_embed.get("/api/v1/__boom__")
    async def _boom() -> dict[str, str]:
        raise RuntimeError("boom")

    with TestClient(app_no_embed, raise_server_exceptions=False) as client:
        resp = client.get("/api/v1/__boom__")
    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "INTERNAL_ERROR"
    assert "message" in body["error"]


def test_v1_models_endpoint(app_no_embed) -> None:
    with TestClient(app_no_embed) as client:
        resp = client.get("/v1/models")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["object"] == "list"
    assert any(m["id"] for m in payload["data"])


def test_v1_chat_completions_json_path(monkeypatch: pytest.MonkeyPatch, app_no_embed) -> None:
    """Non-streaming JSON body returns OpenAI-shaped response."""

    class _FakeResponse:
        content = "hello world"
        metadata: dict[str, Any] = {}

    class _FakeAgent:
        async def process_direct(self, **_kw: Any) -> _FakeResponse:
            return _FakeResponse()

    app_no_embed.state.agent_loop = _FakeAgent()
    app_no_embed.state.model_name = "fake-model"
    app_no_embed.state.openai_session_locks = {}

    with TestClient(app_no_embed) as client:
        resp = client.post(
            "/v1/chat/completions",
            json={
                "model": "fake-model",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "hello world"
    assert body["model"] == "fake-model"


def test_v1_chat_completions_sse_path(monkeypatch: pytest.MonkeyPatch, app_no_embed) -> None:
    """Streaming returns SSE chunks ending with ``data: [DONE]``."""

    class _FakeAgent:
        async def process_direct(
            self,
            *,
            on_stream=None,
            on_stream_end=None,
            **_kw: Any,
        ) -> Any:
            if on_stream is not None:
                await on_stream("hel")
                await on_stream("lo")
            if on_stream_end is not None:
                await on_stream_end()

            class _R:
                content = "hello"
                metadata: dict[str, Any] = {}

            return _R()

    app_no_embed.state.agent_loop = _FakeAgent()
    app_no_embed.state.model_name = "fake-model"
    app_no_embed.state.openai_session_locks = {}

    with TestClient(app_no_embed) as client:
        with client.stream(
            "POST",
            "/v1/chat/completions",
            json={
                "model": "fake-model",
                "stream": True,
                "messages": [{"role": "user", "content": "hi"}],
            },
        ) as resp:
            assert resp.status_code == 200
            text = "".join(part.decode() for part in resp.iter_bytes())
    assert "data: [DONE]" in text
    assert "hel" in text and "lo" in text


def test_queues_snapshot_in_process_mode(app_no_embed) -> None:
    with TestClient(app_no_embed) as client:
        resp = client.get("/queues/snapshot")
    assert resp.status_code == 200
    snap = resp.json()
    assert snap["status"] == "ok"
    assert snap["topology"] == {"mode": "in_process"}
    assert snap["metrics"] == {"inbound_pending": 0, "outbound_pending": 0}


def test_queues_pause_returns_disabled(app_no_embed) -> None:
    """Pause/replay must return 409 in the in-process layout."""
    with TestClient(app_no_embed) as client:
        resp = client.post("/queues/pause", json={"direction": "both", "paused": True})
    assert resp.status_code == 409
    assert resp.json()["mode"] == "in_process"


def test_console_v1_queues_snapshot(app_no_embed) -> None:
    """The /api/v1/queues/snapshot route uses the in-process bus directly."""
    with TestClient(app_no_embed) as client:
        resp = client.get("/api/v1/queues/snapshot")
    assert resp.status_code == 200
    snap = resp.json()
    assert snap["topology"] == {"mode": "in_process"}


def test_root_returns_service_descriptor_when_spa_disabled(app_no_embed) -> None:
    with TestClient(app_no_embed) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert "service" in body and "version" in body


def test_spa_fallback_serves_index_when_dist_present(
    tmp_path, monkeypatch: pytest.MonkeyPatch, settings: ServerSettings, disable_embedded: None
) -> None:
    """When dist/ exists, the SPA mount serves index.html for unknown paths."""
    dist = tmp_path / "dist"
    dist.mkdir()
    index = dist / "index.html"
    index.write_text("<!doctype html><html><body>spa-test</body></html>", encoding="utf-8")

    import console.server.app as app_module

    monkeypatch.setattr(app_module, "_spa_dist_dir", lambda: dist)

    app = create_app(settings, mount_spa=True)
    with TestClient(app) as client:
        resp = client.get("/some/deep/spa/route")
    assert resp.status_code == 200
    assert "spa-test" in resp.text


def test_spa_skipped_when_dist_missing(
    tmp_path, monkeypatch: pytest.MonkeyPatch, settings: ServerSettings, disable_embedded: None
) -> None:
    """When dist/ is missing, the JSON service descriptor still works."""
    import console.server.app as app_module

    monkeypatch.setattr(app_module, "_spa_dist_dir", lambda: tmp_path / "missing")

    app = create_app(settings, mount_spa=True)
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json()["service"] == settings.title


def test_signal_handlers_install_cross_platform_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """install_async_signal_handlers should fall back to signal.signal on NotImplementedError."""
    from console.server import signals

    class _DummyLoop:
        def __init__(self) -> None:
            self.attempted: list[int] = []

        def add_signal_handler(self, sig: int, _cb) -> None:
            self.attempted.append(sig)
            raise NotImplementedError

    fallbacks: list[int] = []
    monkeypatch.setattr(signals.signal, "signal", lambda sig, _cb: fallbacks.append(sig))

    loop = _DummyLoop()

    def _stop() -> None:  # pragma: no cover - never invoked
        pass

    signals.install_async_signal_handlers(loop, _stop)
    # Both SIGINT (and SIGTERM where available) attempted on the loop and then on signal.signal.
    assert signals.signal.SIGINT in loop.attempted
    assert signals.signal.SIGINT in fallbacks


@pytest.mark.skipif(not sys.platform.startswith("win"), reason="Windows-only check")
def test_configure_windows_event_loop_policy_sets_selector_on_win() -> None:
    from console.server import signals

    signals.configure_windows_event_loop_policy()
    policy = asyncio.get_event_loop_policy()
    assert isinstance(policy, asyncio.WindowsSelectorEventLoopPolicy)


@pytest.mark.skipif(sys.platform.startswith("win"), reason="POSIX-only no-op check")
def test_configure_windows_event_loop_policy_noop_on_posix() -> None:
    from console.server import signals

    before = type(asyncio.get_event_loop_policy())
    signals.configure_windows_event_loop_policy()
    after = type(asyncio.get_event_loop_policy())
    assert before is after


def test_npm_executable_prefers_cmd_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``console web ...`` must call npm.cmd on Windows hosts."""
    import console.cli as cli_mod

    # Pretend we're on Windows.
    monkeypatch.setattr(cli_mod.os, "name", "nt")

    seen: list[str] = []

    def _which(name: str) -> str | None:
        seen.append(name)
        return f"C:/{name}" if name.endswith(".cmd") else None

    monkeypatch.setattr(cli_mod.shutil, "which", _which)
    found = cli_mod._npm_executable()
    assert found.endswith("npm.cmd")
    assert seen[0] == "npm.cmd"  # cmd attempted first


def test_in_process_message_bus_has_no_zmq_dependency() -> None:
    """``build_message_bus`` always returns the in-process MessageBus."""
    from nanobot.bus.factory import build_message_bus
    from nanobot.bus.queue import MessageBus

    bus = build_message_bus()
    assert isinstance(bus, MessageBus)


def test_zmq_module_has_been_removed() -> None:
    """Importing ``nanobot.bus.zmq_bus`` must fail in the consolidated layout."""
    import importlib

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("nanobot.bus.zmq_bus")


def test_queue_manager_package_has_been_removed() -> None:
    """The ``queue_manager`` package was removed alongside the broker process."""
    import importlib

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("queue_manager")
