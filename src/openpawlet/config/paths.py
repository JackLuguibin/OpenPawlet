"""Runtime path helpers derived from the active config context."""

from __future__ import annotations

import time
from pathlib import Path

from openpawlet.config.loader import get_config_path
from openpawlet.utils.helpers import ensure_dir, safe_filename


def get_data_dir() -> Path:
    """Return the instance-level runtime data directory."""
    return ensure_dir(get_config_path().parent)


def get_runtime_subdir(name: str) -> Path:
    """Return a named runtime subdirectory under the instance data dir."""
    return ensure_dir(get_data_dir() / name)


def get_media_dir(channel: str | None = None) -> Path:
    """Return the media directory, optionally namespaced per channel."""
    base = get_runtime_subdir("media")
    return ensure_dir(base / channel) if channel else base


def get_cron_dir() -> Path:
    """Return the cron storage directory."""
    return get_runtime_subdir("cron")


def get_logs_dir() -> Path:
    """Return the logs directory."""
    return get_runtime_subdir("logs")


def get_workspace_path(workspace: str | None = None) -> Path:
    """Resolve and ensure the agent workspace path."""
    if workspace:
        path = Path(workspace).expanduser()
    else:
        path = Path.home() / ".openpawlet" / "workspace"
    return ensure_dir(path)


def is_default_workspace(workspace: str | Path | None) -> bool:
    """Return whether a workspace resolves to OpenPawlet's default workspace path."""
    default_path = Path.home() / ".openpawlet" / "workspace"
    if workspace is not None:
        current = Path(workspace).expanduser()
    else:
        current = default_path
    return current.resolve(strict=False) == default_path.resolve(strict=False)


def get_cli_history_path() -> Path:
    """Return the shared CLI history file path."""
    return Path.home() / ".openpawlet" / "history" / "cli_history"


def get_bridge_install_dir() -> Path:
    """Return the shared WhatsApp bridge installation directory."""
    return Path.home() / ".openpawlet" / "bridge"


def get_legacy_sessions_dir() -> Path:
    """Return the legacy global session directory used for migration fallback."""
    return Path.home() / ".openpawlet" / "sessions"


def workspace_console_subdir(workspace: Path) -> Path:
    """State directory under *workspace* (``.openpawlet_console``)."""
    return workspace / ".openpawlet_console"


def observability_jsonl_path_for_session(session_key: str | None) -> Path:
    """Daily JSONL path under the agent workspace for observability events.

    With a session: ``<workspace>/observability/sessions/{safe_key}/events_YYYY-MM-DD.jsonl``.
    Without: ``<workspace>/observability/events_YYYY-MM-DD.jsonl`` (same basename layout as before).
    """
    from openpawlet.config.loader import load_config

    day = time.strftime("%Y-%m-%d", time.localtime())
    ws = load_config().workspace_path.resolve()
    base = ws / "observability"
    key = (session_key or "").strip()
    if key:
        safe = safe_filename(key.replace(":", "_"))
        return base / "sessions" / safe / f"events_{day}.jsonl"
    return base / f"events_{day}.jsonl"
