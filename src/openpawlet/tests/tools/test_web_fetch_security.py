"""Tests for web_fetch SSRF protection and untrusted content marking."""

from __future__ import annotations

import json
import socket
from unittest.mock import patch

import pytest

from openpawlet.agent.tools.web import WebFetchTool
from openpawlet.config.schema import WebFetchConfig


def _fake_resolve_private(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 0))]


def _fake_resolve_public(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]


@pytest.mark.asyncio
async def test_web_fetch_execute_strips_url_wrappers_before_validation():
    """Models often wrap URLs in quotes or backticks; strip before _validate_url_safe."""
    tool = WebFetchTool()
    with patch("openpawlet.agent.tools.web._validate_url_safe") as mock_validate:
        mock_validate.return_value = (False, "stub")
        await tool.execute(url=' `\t"https://example.com/path"\' ')
        mock_validate.assert_called_once()
        assert mock_validate.call_args[0][0] == "https://example.com/path"


@pytest.mark.asyncio
async def test_web_fetch_blocks_private_ip():
    tool = WebFetchTool()
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_private):
        result = await tool.execute(url="http://169.254.169.254/computeMetadata/v1/")
    data = json.loads(result)
    assert "error" in data
    assert "private" in data["error"].lower() or "blocked" in data["error"].lower()


@pytest.mark.asyncio
async def test_web_fetch_blocks_localhost():
    tool = WebFetchTool()

    def _resolve_localhost(hostname, port, family=0, type_=0):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]

    with patch("openpawlet.security.network.socket.getaddrinfo", _resolve_localhost):
        result = await tool.execute(url="http://localhost/admin")
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_web_fetch_result_contains_untrusted_flag():
    """When fetch succeeds, result JSON must include untrusted=True and the banner."""
    tool = WebFetchTool()

    fake_html = "<html><head><title>Test</title></head><body><p>Hello world</p></body></html>"

    class FakeResponse:
        status_code = 200
        url = "https://example.com/page"
        text = fake_html
        headers = {"content-type": "text/html"}

        def raise_for_status(self):
            return None

        def json(self):
            return {}

    async def _fake_get(self, url, **kwargs):
        return FakeResponse()

    with (
        patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_public),
        patch("httpx.AsyncClient.get", _fake_get),
    ):
        result = await tool.execute(url="https://example.com/page")

    data = json.loads(result)
    assert data.get("untrusted") is True
    assert "[External content" in data.get("text", "")


@pytest.mark.asyncio
async def test_web_fetch_blocks_private_redirect_before_returning_image(monkeypatch):
    tool = WebFetchTool()

    class FakeStreamResponse:
        headers = {"content-type": "image/png"}
        url = "http://127.0.0.1/secret.png"
        content = b"\x89PNG\r\n\x1a\n"

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aread(self):
            return self.content

        def raise_for_status(self):
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs):
            return

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None):
            return FakeStreamResponse()

    monkeypatch.setattr("openpawlet.agent.tools.web.httpx.AsyncClient", FakeClient)

    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_public):
        result = await tool.execute(url="https://example.com/image.png")

    data = json.loads(result)
    assert "error" in data
    assert "redirect blocked" in data["error"].lower()


def test_web_fetch_tool_stores_custom_user_agent():
    tool = WebFetchTool(user_agent="OpenPawletTestUA/2")
    assert tool.user_agent == "OpenPawletTestUA/2"


@pytest.mark.asyncio
async def test_web_fetch_skips_jina_when_disabled(monkeypatch):
    """When fetch.use_jina_reader is False, execute must never call _fetch_jina."""

    async def boom(self, url, max_chars):
        raise RuntimeError("_fetch_jina should not run")

    monkeypatch.setattr(WebFetchTool, "_fetch_jina", boom)

    tool = WebFetchTool(config=WebFetchConfig(use_jina_reader=False))

    fake_html = "<html><head><title>T</title></head><body><p>Hello world</p></body></html>"

    class FakeResponse:
        status_code = 200
        url = "https://example.com/page"
        text = fake_html
        headers = {"content-type": "text/html"}
        content = b""

        def raise_for_status(self):
            return None

        def json(self):
            return {}

    class FakeStreamResponse:
        headers = {"content-type": "text/html"}
        url = "https://example.com/page"

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def aread(self):
            return b""

        def raise_for_status(self):
            return None

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            return

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None):
            return FakeStreamResponse()

        async def get(self, url, **kwargs):
            return FakeResponse()

    monkeypatch.setattr("openpawlet.agent.tools.web.httpx.AsyncClient", FakeClient)

    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_public):
        result = await tool.execute(url="https://example.com/page")

    data = json.loads(result)
    assert data.get("untrusted") is True
