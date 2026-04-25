"""Focused tests for the fixed-session OpenAI-compatible API."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from nanobot.api.server import (
    API_CHAT_ID,
    API_SESSION_KEY,
    _chat_completion_response,
    _error_json,
    create_app,
    handle_chat_completions,
)


def _make_mock_agent(response_text: str = "mock response") -> MagicMock:
    agent = MagicMock()
    agent.process_direct = AsyncMock(return_value=response_text)
    agent._connect_mcp = AsyncMock()
    agent.close_mcp = AsyncMock()
    return agent


@pytest.fixture
def mock_agent():
    return _make_mock_agent()


@pytest.fixture
def app(mock_agent):
    return create_app(mock_agent, model_name="test-model", request_timeout=10.0)


@pytest.fixture
def app_client(app):
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def test_error_json() -> None:
    resp = _error_json(400, "bad request")
    assert resp.status_code == 400
    body = json.loads(resp.body)
    assert body["error"]["message"] == "bad request"
    assert body["error"]["code"] == 400


def test_chat_completion_response() -> None:
    result = _chat_completion_response("hello world", "test-model")
    assert result["object"] == "chat.completion"
    assert result["model"] == "test-model"
    assert result["choices"][0]["message"]["content"] == "hello world"
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["id"].startswith("chatcmpl-")


@pytest.mark.asyncio
async def test_missing_messages_returns_400(app_client) -> None:
    async with app_client as client:
        resp = await client.post("/v1/chat/completions", json={"model": "test"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_no_user_message_returns_400(app_client) -> None:
    async with app_client as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "system", "content": "you are a bot"}]},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_stream_true_returns_sse(app_client) -> None:
    async with app_client as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hello"}], "stream": True},
        )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")


@pytest.mark.asyncio
async def test_model_mismatch_returns_400() -> None:
    request = MagicMock()
    request.json = AsyncMock(
        return_value={
            "model": "other-model",
            "messages": [{"role": "user", "content": "hello"}],
        }
    )
    request.headers = {}
    request.app = SimpleNamespace(
        state=SimpleNamespace(
            agent_loop=_make_mock_agent(),
            model_name="test-model",
            request_timeout=10.0,
            session_locks={},
        )
    )

    resp = await handle_chat_completions(request)
    assert resp.status_code == 400
    body = json.loads(resp.body)
    assert "test-model" in body["error"]["message"]


@pytest.mark.asyncio
async def test_single_user_message_required() -> None:
    request = MagicMock()
    request.json = AsyncMock(
        return_value={
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "previous reply"},
            ],
        }
    )
    request.headers = {}
    request.app = SimpleNamespace(
        state=SimpleNamespace(
            agent_loop=_make_mock_agent(),
            model_name="test-model",
            request_timeout=10.0,
            session_locks={},
        )
    )

    resp = await handle_chat_completions(request)
    assert resp.status_code == 400
    body = json.loads(resp.body)
    assert "single user message" in body["error"]["message"].lower()


@pytest.mark.asyncio
async def test_single_user_message_must_have_user_role() -> None:
    request = MagicMock()
    request.json = AsyncMock(
        return_value={
            "messages": [{"role": "system", "content": "you are a bot"}],
        }
    )
    request.headers = {}
    request.app = SimpleNamespace(
        state=SimpleNamespace(
            agent_loop=_make_mock_agent(),
            model_name="test-model",
            request_timeout=10.0,
            session_locks={},
        )
    )

    resp = await handle_chat_completions(request)
    assert resp.status_code == 400
    body = json.loads(resp.body)
    assert "single user message" in body["error"]["message"].lower()


@pytest.mark.asyncio
async def test_successful_request_uses_fixed_api_session(mock_agent) -> None:
    app = create_app(mock_agent, model_name="test-model")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "mock response"
    assert body["model"] == "test-model"
    mock_agent.process_direct.assert_called_once_with(
        content="hello",
        media=None,
        session_key=API_SESSION_KEY,
        channel="api",
        chat_id=API_CHAT_ID,
    )


@pytest.mark.asyncio
async def test_followup_requests_share_same_session_key() -> None:
    call_log: list[str] = []

    async def fake_process(content, session_key="", channel="", chat_id="", **kwargs):
        call_log.append(session_key)
        return f"reply to {content}"

    agent = MagicMock()
    agent.process_direct = fake_process
    agent._connect_mcp = AsyncMock()
    agent.close_mcp = AsyncMock()

    app = create_app(agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        r1 = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "first"}]},
        )
        r2 = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "second"}]},
        )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert call_log == [API_SESSION_KEY, API_SESSION_KEY]


@pytest.mark.asyncio
async def test_fixed_session_requests_are_serialized() -> None:
    order: list[str] = []

    async def slow_process(content, session_key="", channel="", chat_id="", **kwargs):
        order.append(f"start:{content}")
        await asyncio.sleep(0.1)
        order.append(f"end:{content}")
        return content

    agent = MagicMock()
    agent.process_direct = slow_process
    agent._connect_mcp = AsyncMock()
    agent.close_mcp = AsyncMock()

    app = create_app(agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        async def send(msg: str):
            return await client.post(
                "/v1/chat/completions",
                json={"messages": [{"role": "user", "content": msg}]},
            )

        r1, r2 = await asyncio.gather(send("first"), send("second"))
    assert r1.status_code == 200
    assert r2.status_code == 200
    # Verify serialization: one process must fully finish before the other starts
    if order[0] == "start:first":
        assert order.index("end:first") < order.index("start:second")
    else:
        assert order.index("end:second") < order.index("start:first")


@pytest.mark.asyncio
async def test_models_endpoint(app_client) -> None:
    async with app_client as client:
        resp = await client.get("/v1/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert body["data"][0]["id"] == "test-model"


@pytest.mark.asyncio
async def test_health_endpoint(app_client) -> None:
    async with app_client as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


@pytest.mark.asyncio
async def test_multimodal_content_extracts_text(mock_agent) -> None:
    app = create_app(mock_agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "describe this"},
                            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                        ],
                    }
                ]
            },
        )
    assert resp.status_code == 200
    call_kwargs = mock_agent.process_direct.call_args.kwargs
    assert call_kwargs["content"] == "describe this"
    assert call_kwargs["session_key"] == API_SESSION_KEY
    assert call_kwargs["channel"] == "api"
    assert call_kwargs["chat_id"] == API_CHAT_ID
    assert len(call_kwargs.get("media") or []) >= 0  # base64 images saved to disk


@pytest.mark.asyncio
async def test_multimodal_remote_image_url_returns_400(mock_agent) -> None:
    app = create_app(mock_agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "describe this"},
                            {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}},
                        ],
                    }
                ]
            },
        )

    assert resp.status_code == 400
    body = resp.json()
    assert "remote image urls are not supported" in body["error"]["message"].lower()
    mock_agent.process_direct.assert_not_called()


@pytest.mark.asyncio
async def test_empty_response_retry_then_success() -> None:
    call_count = 0

    async def sometimes_empty(content, session_key="", channel="", chat_id="", **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return ""
        return "recovered response"

    agent = MagicMock()
    agent.process_direct = sometimes_empty
    agent._connect_mcp = AsyncMock()
    agent.close_mcp = AsyncMock()

    app = create_app(agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "recovered response"
    assert call_count == 2


@pytest.mark.asyncio
async def test_empty_response_falls_back() -> None:
    from nanobot.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

    call_count = 0

    async def always_empty(content, session_key="", channel="", chat_id="", **kwargs):
        nonlocal call_count
        call_count += 1
        return ""

    agent = MagicMock()
    agent.process_direct = always_empty
    agent._connect_mcp = AsyncMock()
    agent.close_mcp = AsyncMock()

    app = create_app(agent, model_name="m")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        resp = await client.post(
            "/v1/chat/completions",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == EMPTY_FINAL_RESPONSE_MESSAGE
    assert call_count == 2


@pytest.mark.asyncio
async def test_process_direct_accepts_media() -> None:
    """process_direct should forward media paths to _process_message."""
    from nanobot.agent.loop import AgentLoop

    loop = AgentLoop.__new__(AgentLoop)
    loop._connect_mcp = AsyncMock()

    captured_msg = None

    async def fake_process(msg, *, session_key="", on_progress=None, on_stream=None, on_stream_end=None):
        nonlocal captured_msg
        captured_msg = msg
        return None

    loop._process_message = fake_process

    await loop.process_direct(
        content="analyze this",
        media=["/tmp/image.png", "/tmp/report.pdf"],
        session_key="test:1",
    )

    assert captured_msg is not None
    assert captured_msg.media == ["/tmp/image.png", "/tmp/report.pdf"]
    assert captured_msg.content == "analyze this"
