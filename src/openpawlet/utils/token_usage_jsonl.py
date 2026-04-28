"""Append-only JSONL log of LLM token usage under workspace/usage/."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from openpawlet.utils.helpers import ensure_dir, local_now


@dataclass
class TokenUsageJsonlRecorder:
    """Write one JSON object per line to ``usage/token_usage_YYYY-MM-DD.jsonl`` (local calendar day)."""

    workspace: Path
    timezone: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self.workspace = Path(self.workspace).expanduser().resolve()

    def record(
        self,
        usage: dict[str, Any],
        *,
        model: str | None,
        finish_reason: str,
        streaming: bool,
    ) -> None:
        if not usage:
            return
        normalized: dict[str, int] = {}
        for k, v in usage.items():
            try:
                normalized[k] = int(v or 0)
            except (TypeError, ValueError):
                continue
        if not normalized:
            return
        now = local_now(self.timezone)
        row: dict[str, Any] = {
            "_type": "llm_token_usage",
            "timestamp": now.isoformat(),
            "model": (model or "unknown").strip() or "unknown",
            "finish_reason": finish_reason,
            "streaming": streaming,
            "usage": normalized,
        }
        path = self.workspace / "usage" / f"token_usage_{now.date().isoformat()}.jsonl"
        line = json.dumps(row, ensure_ascii=False) + "\n"
        with self._lock:
            ensure_dir(path.parent)
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)


def attach_token_usage_jsonl(
    provider: Any, workspace: str | Path, *, timezone: str | None = None
) -> None:
    """Attach :class:`TokenUsageJsonlRecorder` to *provider* for the given workspace root."""
    provider.attach_token_usage_jsonl(workspace, timezone=timezone)
