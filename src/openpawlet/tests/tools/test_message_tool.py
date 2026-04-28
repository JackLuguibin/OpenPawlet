import pytest

from openpawlet.agent.tools.message import MessageTool
from openpawlet.bus.events import OutboundMessage


@pytest.mark.asyncio
async def test_message_tool_returns_error_when_no_target_context() -> None:
    tool = MessageTool()
    result = await tool.execute(content="test")
    assert result == "Error: No target channel/chat specified"


@pytest.mark.asyncio
async def test_message_tool_marks_channel_delivery_only_when_enabled() -> None:
    """Default (user-turn) MessageTool sends must NOT carry the proactive flag.
    Only sends inside an active record_channel_delivery scope (e.g. cron) do."""
    sent: list[OutboundMessage] = []

    async def _send(msg: OutboundMessage) -> None:
        sent.append(msg)

    tool = MessageTool(send_callback=_send)

    await tool.execute(content="normal", channel="telegram", chat_id="1")
    token = tool.set_record_channel_delivery(True)
    try:
        await tool.execute(content="cron", channel="telegram", chat_id="1")
    finally:
        tool.reset_record_channel_delivery(token)
    await tool.execute(content="back-to-normal", channel="telegram", chat_id="1")

    assert len(sent) == 3
    assert "_record_channel_delivery" not in (sent[0].metadata or {})
    assert sent[1].metadata.get("_record_channel_delivery") is True
    assert "_record_channel_delivery" not in (sent[2].metadata or {})


@pytest.mark.asyncio
async def test_message_tool_passes_normalized_buttons_to_outbound() -> None:
    sent: list[OutboundMessage] = []

    async def _send(msg: OutboundMessage) -> None:
        sent.append(msg)

    tool = MessageTool(send_callback=_send)
    result = await tool.execute(
        content="Pick one",
        channel="telegram",
        chat_id="1",
        buttons=[["Yes", "No"], ["Maybe"]],
    )

    assert "with 3 button(s)" in result
    assert sent[0].buttons == [["Yes", "No"], ["Maybe"]]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        "not-a-list",
        [["ok"], "not-a-row"],
        [["ok", None]],
        [["", "blank"]],
    ],
)
async def test_message_tool_rejects_malformed_buttons(bad) -> None:
    """Malformed buttons must fail fast at the tool layer, not at the channel."""
    tool = MessageTool(send_callback=lambda _msg: None)
    result = await tool.execute(
        content="hi",
        channel="telegram",
        chat_id="1",
        buttons=bad,
    )
    assert result == "Error: buttons must be a list of list of strings"


def test_buttons_as_text_helper_format() -> None:
    """Canonical [label] chip format, one row per line; empty input -> ''."""
    assert MessageTool.buttons_as_text(None) == ""
    assert MessageTool.buttons_as_text([]) == ""
    assert MessageTool.buttons_as_text([["A", "B"], ["C"]]) == "[A] [B]\n[C]"
