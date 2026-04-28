"""Helpers for tagging Console-originated frames with a Queue Manager envelope.

The Console WebSocket proxy is a transparent tunnel to the OpenPawlet
gateway.  To reach business-level "exactly once", we need every logical
user-initiated frame (a chat message, a /stop command, ...) to carry a
stable ``message_id`` so the broker can dedupe replays after restarts
or reconnects.  Clients are free to generate their own ``message_id``;
when they don't we inject one here before the frame crosses the
process boundary.

The tagger operates on JSON text frames only - binary frames are
forwarded unchanged.  Non-JSON text frames (ping / pong helpers) are
also forwarded unchanged since they have no business semantics.
"""

from __future__ import annotations

import json
from typing import Any

from openpawlet.bus.envelope import (
    KEY_DEDUPE_KEY,
    KEY_MESSAGE_ID,
    KEY_TRACE_ID,
    build_dedupe_key,
    new_message_id,
    new_trace_id,
)


def tag_inbound_text_frame(
    frame: str,
    *,
    channel: str = "websocket",
    chat_id_field: str = "chat_id",
) -> str:
    """Return *frame* with a Queue Manager envelope injected when applicable.

    Args:
        frame: Raw text frame received from the browser.
        channel: Logical channel name (default ``websocket``).
        chat_id_field: JSON field that identifies the chat id, used to
            derive a stable :func:`build_dedupe_key`.
    """
    try:
        payload: Any = json.loads(frame)
    except Exception:
        return frame
    if not isinstance(payload, dict):
        return frame
    changed = False
    if not payload.get(KEY_MESSAGE_ID):
        payload[KEY_MESSAGE_ID] = new_message_id()
        changed = True
    if not payload.get(KEY_TRACE_ID):
        payload[KEY_TRACE_ID] = new_trace_id()
        changed = True
    if not payload.get(KEY_DEDUPE_KEY):
        chat_id = str(payload.get(chat_id_field) or payload.get("chatId") or "anon")
        payload[KEY_DEDUPE_KEY] = build_dedupe_key(
            channel=channel,
            chat_id=chat_id,
            message_id=str(payload[KEY_MESSAGE_ID]),
        )
        changed = True
    if not changed:
        return frame
    return json.dumps(payload, ensure_ascii=False)
