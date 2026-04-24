"""Console ingress tagger: inject envelope fields into browser frames."""

from __future__ import annotations

import json

from console.server.queue_envelope import tag_inbound_text_frame
from nanobot.bus.envelope import (
    KEY_DEDUPE_KEY,
    KEY_MESSAGE_ID,
    KEY_TRACE_ID,
)


def test_tagger_injects_envelope_fields_when_missing() -> None:
    frame = json.dumps({"type": "chat", "chat_id": "c-42", "content": "hi"})
    tagged = tag_inbound_text_frame(frame)
    payload = json.loads(tagged)
    assert payload[KEY_MESSAGE_ID]
    assert payload[KEY_TRACE_ID]
    assert payload[KEY_DEDUPE_KEY]
    # Dedupe key must be a function of the chat_id so replays collapse.
    assert "c-42" in payload[KEY_DEDUPE_KEY]


def test_tagger_preserves_existing_envelope_fields() -> None:
    original_mid = "m-fixed-123"
    frame = json.dumps({
        "type": "chat",
        "chat_id": "c-1",
        "content": "",
        KEY_MESSAGE_ID: original_mid,
        KEY_TRACE_ID: "t-fixed",
        KEY_DEDUPE_KEY: "custom-dedupe",
    })
    tagged = tag_inbound_text_frame(frame)
    payload = json.loads(tagged)
    assert payload[KEY_MESSAGE_ID] == original_mid
    assert payload[KEY_TRACE_ID] == "t-fixed"
    assert payload[KEY_DEDUPE_KEY] == "custom-dedupe"


def test_tagger_ignores_non_json_frames() -> None:
    assert tag_inbound_text_frame("ping") == "ping"
    assert tag_inbound_text_frame("[1,2,3]") == "[1,2,3]"  # non-dict JSON


def test_tagger_handles_malformed_input_gracefully() -> None:
    assert tag_inbound_text_frame("{broken json") == "{broken json"
