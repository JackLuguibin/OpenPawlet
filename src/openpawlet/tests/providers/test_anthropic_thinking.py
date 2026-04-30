"""Tests for Anthropic provider thinking / reasoning_effort modes."""

from __future__ import annotations

from unittest.mock import patch

from openpawlet.providers.anthropic_provider import AnthropicProvider


def _make_provider(model: str = "claude-sonnet-4-6") -> AnthropicProvider:
    with patch("anthropic.AsyncAnthropic"):
        return AnthropicProvider(api_key="sk-test", default_model=model)


def _build(provider: AnthropicProvider, reasoning_effort: str | None, **overrides):
    defaults = dict(
        messages=[{"role": "user", "content": "hello"}],
        tools=None,
        model=None,
        max_tokens=4096,
        temperature=0.7,
        reasoning_effort=reasoning_effort,
        tool_choice=None,
        supports_caching=False,
    )
    defaults.update(overrides)
    return provider._build_kwargs(**defaults)


def test_adaptive_sets_type_adaptive() -> None:
    kw = _build(_make_provider(), "adaptive")
    assert kw["thinking"] == {"type": "adaptive"}


def test_adaptive_forces_temperature_one() -> None:
    kw = _build(_make_provider(), "adaptive")
    assert kw["temperature"] == 1.0


def test_adaptive_does_not_inflate_max_tokens() -> None:
    kw = _build(_make_provider(), "adaptive", max_tokens=2048)
    assert kw["max_tokens"] == 2048


def test_adaptive_no_budget_tokens() -> None:
    kw = _build(_make_provider(), "adaptive")
    assert "budget_tokens" not in kw["thinking"]


def test_high_uses_enabled_with_budget() -> None:
    kw = _build(_make_provider(), "high", max_tokens=4096)
    assert kw["thinking"]["type"] == "enabled"
    assert kw["thinking"]["budget_tokens"] == max(8192, 4096)
    assert kw["max_tokens"] >= kw["thinking"]["budget_tokens"] + 4096


def test_low_uses_small_budget() -> None:
    kw = _build(_make_provider(), "low")
    assert kw["thinking"] == {"type": "enabled", "budget_tokens": 1024}


def test_none_does_not_enable_thinking() -> None:
    kw = _build(_make_provider(), None)
    assert "thinking" not in kw
    assert kw["temperature"] == 0.7


def test_opus_4_7_omits_temperature_adaptive() -> None:
    kw = _build(_make_provider("claude-opus-4-7"), "adaptive")
    assert "temperature" not in kw
    assert kw["thinking"] == {"type": "adaptive"}


def test_opus_4_7_omits_temperature_enabled() -> None:
    kw = _build(_make_provider("claude-opus-4-7"), "high", max_tokens=4096)
    assert "temperature" not in kw
    assert kw["thinking"]["type"] == "enabled"


def test_opus_4_7_omits_temperature_none() -> None:
    kw = _build(_make_provider("claude-opus-4-7"), None)
    assert "temperature" not in kw
    assert "thinking" not in kw


def test_reasoning_effort_none_string_disables_thinking() -> None:
    kw = _build(_make_provider(), "none")
    assert "thinking" not in kw
    assert kw["temperature"] == 0.7


def test_merge_consecutive_drops_trailing_assistant_keeps_prior_user() -> None:
    """Anthropic forbids conversations ending with an assistant turn."""
    merged = AnthropicProvider._merge_consecutive(
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": [{"type": "text", "text": "partial"}]},
        ]
    )
    assert len(merged) == 1
    assert merged[0]["role"] == "user"
    assert merged[0]["content"] == "hi"


def test_merge_consecutive_assistant_only_turn_rerouted_to_user() -> None:
    """Empty history after stripping trailing assistant becomes one user message."""
    merged = AnthropicProvider._merge_consecutive(
        [
            {"role": "assistant", "content": [{"type": "text", "text": "orphan reply"}]},
        ]
    )
    assert len(merged) == 1
    assert merged[0]["role"] == "user"
    assert merged[0]["content"] == [{"type": "text", "text": "orphan reply"}]


def test_merge_consecutive_prepends_when_leading_assistant_after_merge() -> None:
    """When merge leaves a leading assistant (e.g. merged user+assistant blocks), prepend opener."""
    from openpawlet.providers.base import _SYNTHETIC_USER_CONTENT

    merged = AnthropicProvider._merge_consecutive(
        [
            {"role": "assistant", "content": [{"type": "text", "text": "say hi"}]},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": [{"type": "text", "text": "draft"}]},
        ]
    )
    assert merged[0]["role"] == "user"
    assert merged[0]["content"] == _SYNTHETIC_USER_CONTENT
