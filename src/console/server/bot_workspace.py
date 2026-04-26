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

from console.server.nanobot_user_config import resolve_config_path
from nanobot.config.loader import load_config
from nanobot.utils.helpers import local_now

_CONSOLE_DIR = ".nanobot_console"
_RUNTIME_STATE_FILE = "runtime_state.json"
_MEMORY_DIR = "memory"
_AGENTS_FILE = "agents.json"
# Per-agent OpenPawlet console configs (under workspace root, e.g. ``agents/agent-abc.json``).
_AGENTS_DIR = "agents"
_TEAMS_FILE = "teams.json"
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


def _workspace_root_uncached(path: Path) -> Path:
    cfg = load_config(path)
    return cfg.workspace_path.resolve()


def workspace_root(bot_id: str | None) -> Path:
    """Return expanded workspace directory from nanobot ``config.json``.

    Cached by ``(path, mtime_ns)`` so /api/v1 routers that touch it on
    every request (status, dashboard, sessions, observability, ...) do
    not re-parse the config file each time.
    """
    from console.server.cache import config_cache

    return config_cache().get_or_load(resolve_config_path(bot_id), _workspace_root_uncached)


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


def _has_symlink_in_chain(base: Path, target: Path) -> bool:
    """Return True if any path component between base and target is a symlink.

    base must already be a fully resolved real path; target is a candidate
    inside it.  Walking the chain prevents an attacker from planting a
    symlink in the workspace tree to redirect writes outside it.
    """
    current = target
    base_resolved = base
    while True:
        try:
            if current.is_symlink():
                return True
        except OSError:
            return True
        if current == base_resolved:
            return False
        parent = current.parent
        if parent == current:
            return False
        current = parent


def safe_join(base: Path, rel: str | None, *, must_exist: bool) -> Path:
    """Join *rel* under *base* defending against traversal and symlink escapes.

    Used by every router that turns a user-supplied relative path into a
    filesystem path under a controlled root (workspace, skill bundle, ...).
    Rejects:
      - absolute paths or ``..`` segments via :func:`_normalize_rel_path`
      - resolved paths that escape *base*
      - any symlink in the resolved chain (we never want to follow links
        out of the controlled root, regardless of what they point to today)
    """
    try:
        base_real = base.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Base directory missing") from exc
    normalized = _normalize_rel_path(rel)
    if not normalized:
        target = base_real
    else:
        target = (base_real / normalized).resolve()
    try:
        target.relative_to(base_real)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path escapes base directory") from exc
    if _has_symlink_in_chain(base_real, target):
        raise HTTPException(status_code=400, detail="Symlinked path is not allowed")
    if must_exist and not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return target


def resolve_workspace_path(
    bot_id: str | None,
    rel: str | None,
    *,
    must_exist: bool,
) -> Path:
    """Resolve ``rel`` under the workspace root; reject traversal and symlinks."""
    return safe_join(workspace_root(bot_id), rel, must_exist=must_exist)


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
    """JSON file for custom categories, overrides, and legacy migration marker.

    Per-agent records live under :func:`workspace_agents_dir` as ``<id>.json``.
    """
    return console_state_dir(bot_id) / _AGENTS_FILE


def workspace_agents_dir(bot_id: str | None) -> Path:
    """``<workspace>/agents/`` (per-agent ``.json`` files)."""
    d = workspace_root(bot_id) / _AGENTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def assert_safe_agent_id(agent_id: str) -> str:
    """Reject path traversal; ``agent_id`` must be a single path segment."""
    s = (agent_id or "").strip()
    if not s or s != Path(s).name or ".." in s:
        raise HTTPException(status_code=400, detail="Invalid agent id")
    return s


def agent_workspace_json_path(bot_id: str | None, agent_id: str) -> Path:
    """``<workspace>/agents/<agent_id>.json`` (legacy single-file layout)."""
    aid = assert_safe_agent_id(agent_id)
    return workspace_agents_dir(bot_id) / f"{aid}.json"


_AGENT_BOOTSTRAP_FILES: dict[str, str] = {
    "soul": "SOUL.md",
    "user": "USER.md",
    "agents": "AGENTS.md",
    "tools": "TOOLS.md",
}


def agent_profile_dir(bot_id: str | None, agent_id: str) -> Path:
    """``<workspace>/agents/<agent_id>/`` (per-agent profile directory)."""
    aid = assert_safe_agent_id(agent_id)
    return workspace_agents_dir(bot_id) / aid


def agent_profile_json_path(bot_id: str | None, agent_id: str) -> Path:
    """``<workspace>/agents/<agent_id>/profile.json``."""
    return agent_profile_dir(bot_id, agent_id) / "profile.json"


def agent_bootstrap_keys() -> tuple[str, ...]:
    """Stable ordered tuple of valid bootstrap keys (``soul``/``user``/...)."""
    return tuple(_AGENT_BOOTSTRAP_FILES.keys())


def agent_bootstrap_path(bot_id: str | None, agent_id: str, key: str) -> Path:
    """``<workspace>/agents/<agent_id>/<NAME>.md`` for a given bootstrap key."""
    if key not in _AGENT_BOOTSTRAP_FILES:
        raise HTTPException(status_code=400, detail="Unknown profile key")
    return agent_profile_dir(bot_id, agent_id) / _AGENT_BOOTSTRAP_FILES[key]


def migrate_agent_profile_layout(bot_id: str | None, agent_id: str) -> None:
    """Move ``agents/<id>.json`` → ``agents/<id>/profile.json`` if needed.

    Idempotent: a no-op when the new file already exists or the legacy
    file is missing. The old file is removed only after the new file is
    written successfully.
    """
    aid = assert_safe_agent_id(agent_id)
    legacy = workspace_agents_dir(bot_id) / f"{aid}.json"
    new_path = agent_profile_json_path(bot_id, aid)
    if new_path.is_file() or not legacy.is_file():
        return
    try:
        new_path.parent.mkdir(parents=True, exist_ok=True)
        new_path.write_text(legacy.read_text(encoding="utf-8"), encoding="utf-8")
        legacy.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("[workspace] migrate agent profile failed {}: {}", aid, exc)


def teams_state_path(bot_id: str | None) -> Path:
    """JSON file backing team records and team rooms."""
    return console_state_dir(bot_id) / _TEAMS_FILE


def save_active_team_gateway(bot_id: str | None, team_id: str, room_id: str) -> None:
    """Persist which team+room the nanobot gateway should bind on next startup."""
    from nanobot.utils.team_gateway_runtime import active_team_gateway_path

    tid = (team_id or "").strip()
    rid = (room_id or "").strip()
    if not tid or not rid:
        return
    path = active_team_gateway_path(workspace_root(bot_id))
    save_json_file(
        path,
        {"team_id": tid, "room_id": rid, "updated_at": iso_now()},
    )


def clear_active_team_gateway_for_team(bot_id: str | None, team_id: str) -> None:
    """Remove gateway pointer when it references the deleted team."""
    from nanobot.utils.team_gateway_runtime import active_team_gateway_path

    tid = (team_id or "").strip()
    if not tid:
        return
    path = active_team_gateway_path(workspace_root(bot_id))
    if not path.is_file():
        return
    data = load_json_file(path, {})
    if isinstance(data, dict) and str(data.get("team_id", "")).strip() == tid:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("[workspace] unlink active_team_gateway failed {}: {}", path, exc)


def tool_logs_path(bot_id: str | None) -> Path:
    """JSON array file for tool invocation logs (optional external writer)."""
    return console_state_dir(bot_id) / _TOOL_LOGS_FILE


def iso_now() -> str:
    """ISO-8601 ``now`` in the configured agent timezone (see ``agents.defaults.timezone``)."""
    from console.server.nanobot_user_config import read_default_timezone, resolve_config_path

    return local_now(read_default_timezone(resolve_config_path(None))).isoformat()


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
    """Atomically write JSON with indentation, retrying replace on Windows.

    On Windows ``tmp.replace(path)`` can briefly raise ``PermissionError``
    when antivirus / search indexer holds the destination open.  A short
    exponential backoff makes the operation robust without surfacing a
    500 to the caller.
    """
    import time as _time

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError as exc:
        logger.warning("[workspace] JSON write failed {}: {}", path, exc)
        raise HTTPException(status_code=500, detail="Failed to save state") from exc
    last_exc: OSError | None = None
    for attempt in range(3):
        try:
            tmp.replace(path)
            return
        except PermissionError as exc:
            last_exc = exc
            _time.sleep(0.05 * (2**attempt))
        except OSError as exc:
            logger.warning("[workspace] JSON replace failed {}: {}", path, exc)
            raise HTTPException(status_code=500, detail="Failed to save state") from exc
    logger.warning("[workspace] JSON replace exhausted retries {}: {}", path, last_exc)
    raise HTTPException(status_code=500, detail="Failed to save state") from last_exc
