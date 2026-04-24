"""Unit tests for the Console-side queues HTTP proxy."""

from __future__ import annotations

import pytest


class _FakeResponse:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body
        self.text = str(body)

    def json(self) -> dict:
        return self._body


class _FakeClient:
    """Minimal ``httpx.AsyncClient`` stand-in that echoes a canned response."""

    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.last_url: str | None = None
        self.last_headers: dict | None = None
        self.last_json: dict | None = None

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *exc) -> None:  # noqa: D401 - stub
        return None

    async def get(self, url: str, headers=None):
        self.last_url = url
        self.last_headers = dict(headers or {})
        return self.response

    async def post(self, url: str, json=None, headers=None):
        self.last_url = url
        self.last_headers = dict(headers or {})
        self.last_json = json
        return self.response


@pytest.mark.asyncio
async def test_snapshot_adds_bearer_when_token_configured(monkeypatch) -> None:
    import httpx

    from console.server.config.schema import ServerSettings
    from console.server.routers.v1 import queues as queues_mod

    settings = ServerSettings(
        queue_manager_admin_token="secret",
        queue_manager_host="127.0.0.1",
        queue_manager_admin_port=7186,
    )
    fake = _FakeClient(_FakeResponse(200, {"status": "ok"}))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)
    result = await queues_mod.queues_snapshot(settings)
    assert result == {"status": "ok"}
    assert fake.last_headers.get("Authorization") == "Bearer secret"
    assert fake.last_url.endswith("/queues/snapshot")


@pytest.mark.asyncio
async def test_pause_proxies_payload(monkeypatch) -> None:
    import httpx

    from console.server.config.schema import ServerSettings
    from console.server.routers.v1 import queues as queues_mod

    settings = ServerSettings(queue_manager_admin_token="")
    fake = _FakeClient(
        _FakeResponse(200, {"paused": {"inbound": True, "outbound": False}, "changed": ["inbound"]})
    )
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)

    body = queues_mod.PauseBody(direction="inbound", paused=True)
    result = await queues_mod.queues_pause(body, settings)
    assert result["changed"] == ["inbound"]
    assert fake.last_json == {"direction": "inbound", "paused": True}
    # No Authorization header when the token is empty.
    assert "Authorization" not in fake.last_headers


@pytest.mark.asyncio
async def test_proxy_surfaces_broker_401(monkeypatch) -> None:
    import httpx
    from fastapi import HTTPException

    from console.server.config.schema import ServerSettings
    from console.server.routers.v1 import queues as queues_mod

    settings = ServerSettings(queue_manager_admin_token="bad")
    fake = _FakeClient(_FakeResponse(401, {"error": "unauthorized"}))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)
    with pytest.raises(HTTPException) as exc_info:
        await queues_mod.queues_snapshot(settings)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_proxy_surfaces_unreachable(monkeypatch) -> None:
    import httpx
    from fastapi import HTTPException

    from console.server.config.schema import ServerSettings
    from console.server.routers.v1 import queues as queues_mod

    class _ExplodingClient(_FakeClient):
        async def get(self, url: str, headers=None):
            raise httpx.ConnectError("broker down")

    settings = ServerSettings()
    fake = _ExplodingClient(_FakeResponse(0, {}))
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fake)
    with pytest.raises(HTTPException) as exc_info:
        await queues_mod.queues_snapshot(settings)
    assert exc_info.value.status_code == 503
