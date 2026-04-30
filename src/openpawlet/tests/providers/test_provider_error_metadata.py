from types import SimpleNamespace

from openpawlet.providers.anthropic_provider import AnthropicProvider
from openpawlet.providers.openai_compat_provider import OpenAICompatProvider


def _fake_response(
    *,
    status_code: int,
    headers: dict[str, str] | None = None,
    text: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        status_code=status_code,
        headers=headers or {},
        text=text,
    )


def test_openai_handle_error_extracts_structured_metadata() -> None:
    class FakeStatusError(Exception):
        """Test stub exception."""

    err = FakeStatusError("boom")
    err.status_code = 409
    err.response = _fake_response(
        status_code=409,
        headers={"retry-after-ms": "250", "x-should-retry": "false"},
        text='{"error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    err.body = {"error": {"type": "rate_limit_exceeded", "code": "rate_limit_exceeded"}}

    response = OpenAICompatProvider._handle_error(err)

    assert response.finish_reason == "error"
    assert response.error_status_code == 409
    assert response.error_type == "rate_limit_exceeded"
    assert response.error_code == "rate_limit_exceeded"
    assert response.error_retry_after_s == 0.25
    assert response.error_should_retry is False


def test_openai_handle_error_marks_timeout_kind() -> None:
    class FakeTimeoutError(Exception):
        """Test stub exception."""

    response = OpenAICompatProvider._handle_error(FakeTimeoutError("timeout"))

    assert response.finish_reason == "error"
    assert response.error_kind == "timeout"


def test_anthropic_handle_error_extracts_structured_metadata() -> None:
    class FakeStatusError(Exception):
        """Test stub exception."""

    err = FakeStatusError("boom")
    err.status_code = 408
    err.response = _fake_response(
        status_code=408,
        headers={"retry-after": "1.5", "x-should-retry": "true"},
    )
    err.body = {"type": "error", "error": {"type": "rate_limit_error"}}

    response = AnthropicProvider._handle_error(err)

    assert response.finish_reason == "error"
    assert response.error_status_code == 408
    assert response.error_type == "rate_limit_error"
    assert response.error_retry_after_s == 1.5
    assert response.error_should_retry is True


def test_anthropic_handle_error_marks_connection_kind() -> None:
    class FakeConnectionError(Exception):
        """Test stub exception."""

    response = AnthropicProvider._handle_error(FakeConnectionError("connection"))

    assert response.finish_reason == "error"
    assert response.error_kind == "connection"
