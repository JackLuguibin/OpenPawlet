"""Workspace paths, console state files, and safe path I/O for bot-scoped APIs."""

from __future__ import annotations

import json
import re
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from loguru import logger
from nanobot.config.loader import load_config

from console.server.nanobot_user_config import resolve_config_path

_CONSOLE_DIR = ".nanobot_console"
_RUNTIME_STATE_FILE = "runtime_state.json"
_MEMORY_DIR = "memory"
_AGENTS_FILE = "agents.json"
_TOOL_LOGS_FILE = "tool_logs.json"
_PROFILE_FILES: dict[str, str] = {
    "soul": "SOUL.md",
    "user": "USER.md",
    "heartbeat": "HEARTBEAT.md",
    "tools": "TOOLS.md",
    "agents": "AGENTS.md",
}
# Matches ``nanobot.agent.memory.MemoryStore`` (MEMORY.md + HISTORY.md).
_MEMORY_FILES = {"long_term": "MEMORY.md", "history": "HISTORY.md"}
# Older console builds used these names under the same directory.
_MEMORY_LEGACY = {"long_term": "long_term.md", "history": "history.md"}
_CURSOR_SKILLS = Path(".cursor") / "skills"


def workspace_root(bot_id: str | None) -> Path:
    """Return expanded workspace directory from nanobot ``config.json``."""
    cfg = load_config(resolve_config_path(bot_id))
    return cfg.workspace_path.resolve()


def console_state_dir(bot_id: str | None) -> Path:
    """Directory for console-managed JSON state (under workspace)."""
    root = workspace_root(bot_id)
    d = root / _CONSOLE_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def runtime_state_path(bot_id: str | None) -> Path:
    """JSON file for API-reported bot running flag and start time."""
    return console_state_dir(bot_id) / _RUNTIME_STATE_FILE


def read_bot_runtime(bot_id: str | None) -> tuple[bool, float]:
    """Return ``(running, uptime_seconds)`` from persisted console state."""
    path = runtime_state_path(bot_id)
    data = load_json_file(path, {"running": False, "started_at": None})
    running = bool(data.get("running"))
    started = data.get("started_at")
    if not running or started is None:
        return False, 0.0
    try:
        if isinstance(started, (int, float)):
            start_ts = float(started)
        elif isinstance(started, str):
            dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            start_ts = dt.timestamp()
        else:
            return running, 0.0
    except (ValueError, TypeError, OSError):
        return running, 0.0
    return True, max(0.0, time.time() - start_ts)


def set_bot_running(bot_id: str | None, running: bool) -> None:
    """Persist running flag; set ``started_at`` when transitioning to running."""
    path = runtime_state_path(bot_id)
    data = load_json_file(path, {"running": False, "started_at": None})
    if running:
        if not data.get("running"):
            data["started_at"] = iso_now()
        data["running"] = True
    else:
        data["running"] = False
        data["started_at"] = None
    save_json_file(path, data)


def is_bot_running(bot_id: str | None) -> bool:
    """Return the persisted *running* flag for dashboard / bot list."""
    data = load_json_file(runtime_state_path(bot_id), {"running": False})
    return bool(data.get("running"))


def normalize_workspace_rel_path(raw: str | None) -> str:
    """Return a safe relative path segment under the workspace (exported API)."""
    return _normalize_rel_path(raw)


def _normalize_rel_path(raw: str | None) -> str:
    """Return a POSIX relative path without leading slashes or ``..`` segments."""
    if raw is None or raw.strip() == "":
        return ""
    parts: list[str] = []
    for segment in raw.replace("\\", "/").strip("/").split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            raise HTTPException(status_code=400, detail="Invalid path")
        parts.append(segment)
    return "/".join(parts)


def resolve_workspace_path(
    bot_id: str | None,
    rel: str | None,
    *,
    must_exist: bool,
) -> Path:
    """Resolve ``rel`` under the workspace root; reject path traversal."""
    root = workspace_root(bot_id)
    normalized = _normalize_rel_path(rel)
    target = (root / normalized).resolve() if normalized else root
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path escapes workspace") from exc
    if must_exist and not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return target


def read_text(path: Path) -> str:
    """Read UTF-8 text; replace undecodable bytes."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("[workspace] read failed {}: {}", path, exc)
        raise HTTPException(status_code=500, detail="Failed to read file") from exc


def write_text(path: Path, content: str) -> None:
    """Write UTF-8 text, creating parent directories."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        logger.warning("[workspace] write failed {}: {}", path, exc)
        raise HTTPException(status_code=500, detail="Failed to write file") from exc


def profile_file_path(bot_id: str | None, key: str) -> Path:
    """Absolute path to a bootstrap markdown file in the workspace root."""
    if key not in _PROFILE_FILES:
        raise HTTPException(status_code=400, detail="Unknown profile key")
    root = workspace_root(bot_id)
    return root / _PROFILE_FILES[key]


def read_memory_text(bot_id: str | None, kind: str) -> str:
    """Read long-term or history from ``<workspace>/memory/``.

    Prefers nanobot's ``MEMORY.md`` / ``HISTORY.md``, then legacy ``long_term.md`` /
    ``history.md``.
    """
    if kind not in _MEMORY_FILES:
        raise HTTPException(status_code=400, detail="Unknown memory kind")
    base = workspace_root(bot_id) / _MEMORY_DIR
    primary = base / _MEMORY_FILES[kind]
    if primary.is_file():
        return read_text(primary)
    legacy = base / _MEMORY_LEGACY[kind]
    if legacy.is_file():
        return read_text(legacy)
    return ""


def agents_state_path(bot_id: str | None) -> Path:
    """JSON file backing multi-agent records and categories."""
    return console_state_dir(bot_id) / _AGENTS_FILE


def tool_logs_path(bot_id: str | None) -> Path:
    """JSON array file for tool invocation logs (optional external writer)."""
    return console_state_dir(bot_id) / _TOOL_LOGS_FILE


def iso_now() -> str:
    """UTC ISO-8601 timestamp with ``Z`` suffix."""
    return datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str = "") -> str:
    """Short unique id for agents and log rows."""
    suffix = uuid.uuid4().hex[:12]
    return f"{prefix}{suffix}" if prefix else suffix


_SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")


def validate_skill_name(name: str) -> str:
    """Return ``name`` if safe for a filesystem skill folder."""
    n = name.strip()
    if not _SKILL_NAME_RE.fullmatch(n):
        raise HTTPException(status_code=400, detail="Invalid skill name")
    return n


def workspace_skill_dir(bot_id: str | None, name: str) -> Path:
    """``<workspace>/.cursor/skills/<name>`` (skill bundle root)."""
    n = validate_skill_name(name)
    return workspace_root(bot_id) / _CURSOR_SKILLS / n


def workspace_skill_md_path(bot_id: str | None, name: str) -> Path:
    """``<workspace>/.cursor/skills/<name>/SKILL.md``."""
    return workspace_skill_dir(bot_id, name) / "SKILL.md"


def validate_skill_bundle_rel_path(raw: str) -> str:
    """Normalize a path under a skill folder; forbid ``SKILL.md`` and traversal."""
    normalized = _normalize_rel_path(raw)
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid file path")
    last = Path(normalized).parts[-1]
    if last.upper() == "SKILL.MD":
        raise HTTPException(
            status_code=400,
            detail="SKILL.md must be set via the main content field",
        )
    return normalized


def validate_skill_bundle_dir_rel_path(raw: str) -> str:
    """Normalize a directory path under a skill bundle (no ``SKILL.md`` segment)."""
    normalized = _normalize_rel_path(raw)
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid directory path")
    last = Path(normalized).parts[-1]
    if last.upper() == "SKILL.MD":
        raise HTTPException(status_code=400, detail="Invalid directory name")
    return normalized


def iter_workspace_skill_dirs(bot_id: str | None) -> list[Path]:
    """List skill directories under ``.cursor/skills`` that contain ``SKILL.md``."""
    base = workspace_root(bot_id) / _CURSOR_SKILLS
    if not base.is_dir():
        return []
    result: list[Path] = []
    for child in sorted(base.iterdir()):
        if child.is_dir() and (child / "SKILL.md").is_file():
            result.append(child)
    return result


def skill_description_preview(md_path: Path, limit: int = 240) -> str:
    """First non-empty lines of a skill file as description."""
    try:
        text = md_path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:limit]
    return ""


def load_json_file(path: Path, default: Any) -> Any:
    """Load JSON object from ``path``; return ``default`` if missing or invalid."""
    if not path.is_file():
        return default
    try:
        with path.open(encoding="utf-8") as f:
            data: Any = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("[workspace] bad JSON {}: {}", path, exc)
        return default
    return data


def save_json_file(path: Path, data: Any) -> None:
    """Atomically write JSON with indentation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp.replace(path)
    except OSError as exc:
        logger.warning("[workspace] JSON save failed {}: {}", path, exc)
        raise HTTPException(status_code=500, detail="Failed to save state") from exc
