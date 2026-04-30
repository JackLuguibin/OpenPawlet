"""Tests for built-in ``/history`` command."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from openpawlet.command.builtin import (
    _format_history_message,
    cmd_history,
)
from openpawlet.command.router import CommandContext


def test_format_history_message_skips_tool_role() -> None:
    assert _format_history_message({"role": "tool", "content": "x"}) is None


def test_format_history_message_truncates_long_text() -> None:
    text = "a" * 300
    out = _format_history_message({"role": "user", "content": text})
    assert out is not None
    assert out.endswith("…")
    assert len(out) < len(text) + 20


@pytest.mark.asyncio
async def test_cmd_history_prefix_count() -> None:
    sess = MagicMock()
    sess.get_history = MagicMock(
        return_value=[
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
            {"role": "user", "content": "c"},
        ]
    )
    loop = MagicMock()
    loop.sessions.get_or_create = MagicMock(return_value=sess)
    msg = MagicMock()
    msg.channel = "telegram"
    msg.chat_id = "1"
    msg.metadata = {}

    ctx = CommandContext(msg=msg, session=None, key="sk", raw="/history 2", args="2", loop=loop)
    out = await cmd_history(ctx)
    assert "Last 2" in out.content
    assert "c" in out.content
    assert "b" in out.content
    assert "a" not in out.content.split("👤")[1]  # first user line dropped from tail-2 formatted


@pytest.mark.asyncio
async def test_cmd_history_invalid_args_returns_usage() -> None:
    loop = MagicMock()
    sess = MagicMock()
    loop.sessions.get_or_create = MagicMock(return_value=sess)
    msg = MagicMock(channel="telegram", chat_id="1", metadata={})
    ctx = CommandContext(
        msg=msg, session=None, key="sk", raw="/history x", args="x", loop=loop
    )
    out = await cmd_history(ctx)
    assert "Usage:" in out.content
