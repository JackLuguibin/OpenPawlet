"""Append-only per-session transcript logs (verbatim, independent of LLM context trimming)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from openpawlet.utils.helpers import ensure_dir, safe_filename, timestamp
from openpawlet.utils.helpers import truncate_text as truncate_text_fn


class SessionTranscriptWriter:
    """Writes JSONL lines to ``workspace/transcripts/{safe_key}.jsonl``."""

    def __init__(
        self,
        workspace: Path,
        *,
        enabled: bool,
        include_full_tool_results: bool,
        max_tool_result_chars: int,
        timezone: str | None = None,
    ) -> None:
        self._workspace = workspace
        self.enabled = enabled
        self.include_full_tool_results = include_full_tool_results
        self.max_tool_result_chars = max_tool_result_chars
        self._agent_timezone = timezone
        self._dir = ensure_dir(workspace / "transcripts") if enabled else None

    def _path(self, session_key: str) -> Path:
        assert self._dir is not None
        safe_key = safe_filename(session_key.replace(":", "_"))
        return self._dir / f"{safe_key}.jsonl"

    def _append_jsonl(self, session_key: str, record: dict[str, Any]) -> None:
        if not self.enabled or self._dir is None:
            return
        path = self._path(session_key)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def raw_turn_message_to_record(self, m: dict[str, Any]) -> dict[str, Any]:
        """Build a storable record from an agent-loop message (before session truncation)."""
        role = m.get("role")
        entry: dict[str, Any] = {"role": role, "content": m.get("content")}
        for key in (
            "tool_calls",
            "tool_call_id",
            "name",
            "reasoning_content",
            "thinking_blocks",
            "reply_group_id",
            "injected_event",
            "sender_agent_id",
        ):
            if key in m:
                entry[key] = m[key]
        if m.get("timestamp"):
            entry["timestamp"] = m["timestamp"]
        else:
            entry["timestamp"] = timestamp(self._agent_timezone)

        if role == "tool" and not self.include_full_tool_results:
            content = entry.get("content")
            if isinstance(content, str) and len(content) > self.max_tool_result_chars:
                entry["content"] = truncate_text_fn(content, self.max_tool_result_chars)
            elif isinstance(content, list):
                entry["content"] = self._truncate_tool_blocks(content)
        return entry

    def _truncate_tool_blocks(self, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for block in blocks:
            if not isinstance(block, dict):
                out.append(block)
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                text = block["text"]
                if len(text) > self.max_tool_result_chars:
                    out.append(
                        {**block, "text": truncate_text_fn(text, self.max_tool_result_chars)}
                    )
                else:
                    out.append(dict(block))
            else:
                out.append(dict(block))
        return out

    def append_raw_turn_message(self, session_key: str, m: dict[str, Any]) -> None:
        """Append one message from the agent run (pre-session transforms)."""
        self._append_jsonl(session_key, self.raw_turn_message_to_record(m))

    def append_session_message_snapshot(self, session_key: str, msg: dict[str, Any]) -> None:
        """Append a message as stored on the Session (e.g. early-persisted user turn)."""
        if not self.enabled:
            return
        snap = {k: msg[k] for k in msg if not k.startswith("_")}
        self._append_jsonl(session_key, snap)

    def append_evicted(
        self,
        session_key: str,
        event: str,
        messages: list[dict[str, Any]],
        *,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Record messages removed by compaction / retain-suffix (destructive ops)."""
        if not self.enabled or not messages:
            return
        record: dict[str, Any] = {
            "_event": event,
            "timestamp": timestamp(self._agent_timezone),
            "messages": messages,
        }
        if metadata:
            record["metadata"] = metadata
        self._append_jsonl(session_key, record)

    def append_event(
        self,
        session_key: str,
        event: str,
        *,
        content: str,
        metadata: dict[str, Any] | None = None,
        source: str = "subagent_event",
    ) -> None:
        """Append a structured event row to *session_key* transcript.

        Used to embed lightweight markers (e.g. subagent start/done) inside a
        parent session transcript without faking a full assistant/tool turn.
        The record is shaped like a normal message so existing readers degrade
        gracefully, while ``metadata.event`` carries the real event type.
        """
        if not self.enabled:
            return
        meta: dict[str, Any] = {"event": event}
        if metadata:
            meta.update(metadata)
        record: dict[str, Any] = {
            "role": "system",
            "source": source,
            "content": content,
            "metadata": meta,
            "timestamp": timestamp(self._agent_timezone),
        }
        self._append_jsonl(session_key, record)
