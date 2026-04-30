"""Helpers for restart notification messages."""

from __future__ import annotations

import json
import os
import time
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

RESTART_NOTIFY_CHANNEL_ENV = "OPENPAWLET_RESTART_NOTIFY_CHANNEL"
RESTART_NOTIFY_CHAT_ID_ENV = "OPENPAWLET_RESTART_NOTIFY_CHAT_ID"
RESTART_NOTIFY_METADATA_ENV = "OPENPAWLET_RESTART_NOTIFY_METADATA"
RESTART_STARTED_AT_ENV = "OPENPAWLET_RESTART_STARTED_AT"


@dataclass(frozen=True)
class RestartNotice:
    channel: str
    chat_id: str
    started_at_raw: str
    metadata: dict[str, Any] = field(default_factory=dict)


def format_restart_completed_message(started_at_raw: str) -> str:
    """Build restart completion text and include elapsed time when available."""
    elapsed_suffix = ""
    if started_at_raw:
        with suppress(ValueError):
            elapsed_s = max(0.0, time.time() - float(started_at_raw))
            elapsed_suffix = f" in {elapsed_s:.1f}s"
    return f"Restart completed{elapsed_suffix}."


_ALL_RESTART_NOTICE_ENV_KEYS = (
    RESTART_NOTIFY_CHANNEL_ENV,
    RESTART_NOTIFY_CHAT_ID_ENV,
    RESTART_NOTIFY_METADATA_ENV,
    RESTART_STARTED_AT_ENV,
)


def _peek_nonempty(key: str) -> str:
    return os.environ.get(key, "").strip()


def _peek_restart_metadata_json() -> dict[str, Any]:
    raw = os.environ.get(RESTART_NOTIFY_METADATA_ENV, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _purge_all_restart_notice_env() -> None:
    for k in _ALL_RESTART_NOTICE_ENV_KEYS:
        os.environ.pop(k, None)


def set_restart_notice_to_env(
    *, channel: str, chat_id: str, metadata: dict[str, Any] | None = None,
) -> None:
    """Write restart notice env values for the next process."""
    os.environ[RESTART_NOTIFY_CHANNEL_ENV] = channel
    os.environ[RESTART_NOTIFY_CHAT_ID_ENV] = chat_id
    os.environ[RESTART_STARTED_AT_ENV] = str(time.time())
    if metadata:
        try:
            os.environ[RESTART_NOTIFY_METADATA_ENV] = json.dumps(metadata, default=str)
        except (TypeError, ValueError):
            os.environ.pop(RESTART_NOTIFY_METADATA_ENV, None)
    else:
        os.environ.pop(RESTART_NOTIFY_METADATA_ENV, None)


def consume_restart_notice_from_env() -> RestartNotice | None:
    """Read and clear restart notice env values once for this process."""
    try:
        channel = _peek_nonempty(RESTART_NOTIFY_CHANNEL_ENV)
        chat_id = _peek_nonempty(RESTART_NOTIFY_CHAT_ID_ENV)
        started_at_raw = _peek_nonempty(RESTART_STARTED_AT_ENV)
        metadata = _peek_restart_metadata_json()

        if not (channel and chat_id):
            return None
        return RestartNotice(
            channel=channel,
            chat_id=chat_id,
            started_at_raw=started_at_raw,
            metadata=metadata,
        )
    finally:
        _purge_all_restart_notice_env()


def should_show_cli_restart_notice(notice: RestartNotice, session_id: str) -> bool:
    """Return True when a restart notice should be shown in this CLI session."""
    if notice.channel != "cli":
        return False
    if ":" in session_id:
        _, cli_chat_id = session_id.split(":", 1)
    else:
        cli_chat_id = session_id
    return not notice.chat_id or notice.chat_id == cli_chat_id
