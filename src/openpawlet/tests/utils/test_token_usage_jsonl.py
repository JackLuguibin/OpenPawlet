"""Tests for workspace usage JSONL logging."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from openpawlet.providers.base import LLMProvider, LLMResponse
from openpawlet.utils.token_usage_jsonl import TokenUsageJsonlRecorder, attach_token_usage_jsonl


class _Scripted(LLMProvider):
    def __init__(self, responses: list[LLMResponse]) -> None:
        super().__init__()
        self._responses = list(responses)
        self.calls = 0

    async def chat(self, *args, **kwargs) -> LLMResponse:
        self.calls += 1
        return self._responses.pop(0)

    def get_default_model(self) -> str:
        return "default-m"


def test_recorder_writes_under_usage(tmp_path: Path) -> None:
    rec = TokenUsageJsonlRecorder(tmp_path)
    rec.record(
        {"prompt_tokens": 1, "completion_tokens": 2},
        model="m",
        finish_reason="stop",
        streaming=False,
    )
    files = list((tmp_path / "usage").glob("token_usage_*.jsonl"))
    assert len(files) == 1
    line = files[0].read_text(encoding="utf-8").strip()
    data = json.loads(line)
    assert data["_type"] == "llm_token_usage"
    assert data["model"] == "m"
    assert data["usage"]["prompt_tokens"] == 1
    assert data["streaming"] is False


@pytest.mark.asyncio
async def test_attach_records_only_final_success_after_retry(tmp_path: Path, monkeypatch) -> None:
    async def _no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)

    provider = _Scripted(
        [
            LLMResponse(content="429 rate limit", finish_reason="error"),
            LLMResponse(
                content="ok",
                finish_reason="stop",
                usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            ),
        ]
    )
    attach_token_usage_jsonl(provider, tmp_path)
    await provider.chat_with_retry(
        messages=[{"role": "user", "content": "h"}],
        model="x-model",
    )
    assert provider.calls == 2
    paths = list((tmp_path / "usage").glob("token_usage_*.jsonl"))
    assert len(paths) == 1
    lines = [ln for ln in paths[0].read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["model"] == "x-model"
    assert row["usage"]["prompt_tokens"] == 10


@pytest.mark.asyncio
async def test_no_record_on_error_finish(tmp_path: Path) -> None:
    provider = _Scripted(
        [LLMResponse(content="bad", finish_reason="error", usage={"prompt_tokens": 1})],
    )
    attach_token_usage_jsonl(provider, tmp_path)
    await provider.chat_with_retry(messages=[{"role": "user", "content": "h"}])
    assert not (tmp_path / "usage").exists() or not list((tmp_path / "usage").glob("*.jsonl"))
