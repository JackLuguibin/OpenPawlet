"""Unit tests for the unified Queue Manager envelope + event dataclasses."""

from __future__ import annotations

from nanobot.bus.envelope import (
    build_dedupe_key,
    new_message_id,
    new_trace_id,
)
from nanobot.bus.events import InboundMessage, OutboundMessage


def test_new_message_id_is_unique_and_prefixed() -> None:
    mid1 = new_message_id()
    mid2 = new_message_id()
    assert mid1 != mid2
    assert mid1.startswith("m-")


def test_new_trace_id_is_unique_and_prefixed() -> None:
    t1 = new_trace_id()
    t2 = new_trace_id()
    assert t1 != t2
    assert t1.startswith("t-")


def test_build_dedupe_key_is_stable_for_same_inputs() -> None:
    k1 = build_dedupe_key(channel="ws", chat_id="c1", message_id="m-abc")
    k2 = build_dedupe_key(channel="ws", chat_id="c1", message_id="m-abc")
    assert k1 == k2
    assert "ws" in k1 and "c1" in k1 and "m-abc" in k1


def test_inbound_message_auto_populates_envelope_fields() -> None:
    msg = InboundMessage(
        channel="websocket",
        sender_id="u1",
        chat_id="c1",
        content="hello",
    )
    assert msg.message_id.startswith("m-")
    assert msg.dedupe_key is not None
    assert msg.trace_id.startswith("t-")
    assert msg.event_seq == 0
    assert msg.attempt == 0


def test_inbound_message_preserves_explicit_envelope_fields() -> None:
    msg = InboundMessage(
        channel="ws",
        sender_id="u",
        chat_id="c",
        content="",
        message_id="m-fixed",
        dedupe_key="custom-key",
        trace_id="t-fixed",
        event_seq=7,
        attempt=2,
    )
    assert msg.message_id == "m-fixed"
    assert msg.dedupe_key == "custom-key"
    assert msg.trace_id == "t-fixed"
    assert msg.event_seq == 7
    assert msg.attempt == 2


def test_outbound_message_auto_populates_envelope_fields() -> None:
    msg = OutboundMessage(channel="ws", chat_id="c", content="hi")
    assert msg.message_id.startswith("m-")
    assert msg.dedupe_key is not None
    assert msg.trace_id.startswith("t-")
