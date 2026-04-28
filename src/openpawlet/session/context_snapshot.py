"""Latest-turn snapshot of the real assembled LLM context.

Every agent turn overwrites ``<workspace>/context/{safe_session_key}.jsonl``
with a single JSONL record describing the prompt that was about to be sent to
the model.  Keeping only the most recent turn avoids unbounded file growth on
long-running sessions while still giving the console a trustworthy view of
what the agent actually saw.  The record captures both a plain-text rendering
and the structured messages so the UI can display either form without
re-running the context builder.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from openpawlet.utils.helpers import ensure_dir, safe_filename, timestamp

_CONTEXT_DIR_NAME = "context"


def _text_from_content(content: Any) -> str:
    """Flatten assistant/user/tool content into a readable string for previews."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                parts.append(str(block))
                continue
            btype = block.get("type")
            if btype == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif btype == "image_url":
                meta = block.get("_meta") or {}
                path = meta.get("path") or ""
                parts.append(f"[image {path}]" if path else "[image]")
            else:
                parts.append(json.dumps(block, ensure_ascii=False))
        return "\n".join(parts)
    return str(content)


def _sanitize_message(message: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON-serialisable copy of *message* without internal markers."""
    cleaned: dict[str, Any] = {}
    for key, value in message.items():
        if isinstance(key, str) and key.startswith("_"):
            continue
        cleaned[key] = value
    return cleaned


def _render_messages_text(messages: list[dict[str, Any]]) -> str:
    """Render the message list as a human-readable block for the text view."""
    sections: list[str] = []
    for index, msg in enumerate(messages):
        role = msg.get("role", "unknown")
        header = f"--- [{index}] {role} ---"
        body_parts: list[str] = []

        content_text = _text_from_content(msg.get("content"))
        if content_text:
            body_parts.append(content_text)

        tool_calls = msg.get("tool_calls")
        if tool_calls:
            try:
                body_parts.append(
                    "tool_calls: " + json.dumps(tool_calls, ensure_ascii=False, indent=2)
                )
            except (TypeError, ValueError):
                body_parts.append(f"tool_calls: {tool_calls!r}")

        tool_call_id = msg.get("tool_call_id")
        if tool_call_id:
            body_parts.append(f"tool_call_id: {tool_call_id}")

        name = msg.get("name")
        if name:
            body_parts.append(f"name: {name}")

        sections.append(header + ("\n" + "\n".join(body_parts) if body_parts else ""))
    return "\n\n".join(sections)


class SessionContextWriter:
    """Overwrite ``context/{key}.jsonl`` with the latest assembled-context snapshot."""

    def __init__(
        self,
        workspace: Path,
        *,
        enabled: bool = True,
        timezone: str | None = None,
    ) -> None:
        self._workspace = workspace
        self.enabled = enabled
        self._timezone = timezone
        self._dir = ensure_dir(workspace / _CONTEXT_DIR_NAME) if enabled else None

    def _path(self, session_key: str) -> Path:
        assert self._dir is not None
        safe_key = safe_filename(session_key.replace(":", "_"))
        return self._dir / f"{safe_key}.jsonl"

    def path_for(self, session_key: str) -> Path | None:
        """Return the on-disk JSONL path for *session_key* (even when disabled)."""
        if self._dir is None:
            return None
        return self._path(session_key)

    @staticmethod
    def build_record(
        session_key: str,
        *,
        messages: list[dict[str, Any]],
        bot_id: str | None,
        channel: str | None,
        chat_id: str | None,
        turn_index: int | None,
        source: str,
        timezone: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build the JSONL record representing *messages* sent to the LLM."""
        sanitized: list[dict[str, Any]] = [
            _sanitize_message(m) for m in messages if isinstance(m, dict)
        ]

        system_text = ""
        if sanitized and sanitized[0].get("role") == "system":
            system_text = _text_from_content(sanitized[0].get("content"))

        rendered_text = _render_messages_text(sanitized)

        record: dict[str, Any] = {
            "session_key": session_key,
            "bot_id": bot_id,
            "channel": channel,
            "chat_id": chat_id,
            "turn_index": turn_index,
            "source": source,
            "timestamp": timestamp(timezone),
            "system_prompt": system_text,
            "messages": sanitized,
            "message_count": len(sanitized),
            "context_text": rendered_text,
        }
        if extra:
            for key, value in extra.items():
                if key not in record:
                    record[key] = value
        return record

    def write_snapshot(
        self,
        session_key: str,
        *,
        messages: list[dict[str, Any]],
        bot_id: str | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        turn_index: int | None = None,
        source: str = "agent_turn",
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Overwrite ``context/{key}.jsonl`` with a single record for this turn.

        Writing the file via a ``{path}.tmp`` rename keeps readers from ever
        seeing a partially-written record when the process is killed mid-write.
        Historical snapshots are intentionally discarded so the on-disk file
        stays small even on very long sessions.
        """
        if not self.enabled or self._dir is None or not session_key:
            return
        record = self.build_record(
            session_key,
            messages=messages,
            bot_id=bot_id,
            channel=channel,
            chat_id=chat_id,
            turn_index=turn_index,
            source=source,
            timezone=self._timezone,
            extra=extra,
        )
        path = self._path(session_key)
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        payload = json.dumps(record, ensure_ascii=False) + "\n"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(payload)
        tmp_path.replace(path)

    # Backwards-compatible alias retained for older callers that still use the
    # append-style API.  The implementation always overwrites.
    append_snapshot = write_snapshot
