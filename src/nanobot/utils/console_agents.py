"""Load optional per-agent rows from OpenPawlet console (per-file under ``agents/``)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nanobot.config.schema import Config


def console_agent_display_name(workspace: Path, agent_id: str) -> str:
    """Return the display ``name`` from the console agent row, if any."""
    row = load_console_agent_row(workspace, (agent_id or "").strip())
    if isinstance(row, dict):
        n = row.get("name")
        if isinstance(n, str) and n.strip():
            return n.strip()
    return ""


def load_console_agent_row(workspace: Path, agent_id: str) -> dict[str, Any] | None:
    """Return the agent dict for *agent_id*, or None.

    Lookup order (first hit wins):

    1. ``<workspace>/agents/<id>/profile.json`` — new layout that pairs
       the agent record with its bootstrap markdown files in the same
       directory.
    2. ``<workspace>/agents/<id>.json`` — legacy single-file Console
       record.
    3. ``.nanobot_console/agents.json`` ``agents`` array (very old).
    """
    aid = (agent_id or "").strip()
    if not aid:
        return None
    new_dir = workspace / "agents" / aid / "profile.json"
    if new_dir.is_file():
        try:
            raw = json.loads(new_dir.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return None
        if isinstance(raw, dict):
            return raw
    per = workspace / "agents" / f"{aid}.json"
    if per.is_file():
        try:
            raw = json.loads(per.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return None
        if isinstance(raw, dict):
            return raw
    path = workspace / ".nanobot_console" / "agents.json"
    if not path.is_file():
        return None
    try:
        blob = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    if not isinstance(blob, dict):
        return None
    agents = blob.get("agents")
    if not isinstance(agents, list):
        return None
    for item in agents:
        if isinstance(item, dict) and str(item.get("id", "")) == aid:
            return item
    return None


def load_console_team_row(workspace: Path, team_id: str) -> dict[str, Any] | None:
    """Return team dict from ``.nanobot_console/teams.json`` for *team_id*, or None."""
    tid = (team_id or "").strip()
    if not tid:
        return None
    path = workspace / ".nanobot_console" / "teams.json"
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    teams = raw.get("teams")
    if not isinstance(teams, list):
        return None
    for item in teams:
        if isinstance(item, dict) and str(item.get("id", "")) == tid:
            return item
    return None


def disabled_skills_for_allowlist(
    workspace: Path,
    allowlist: list[str] | None,
) -> set[str] | None:
    """If *allowlist* is non-empty, return skill names to disable (all except allowlist)."""
    if not allowlist:
        return None
    from nanobot.agent.skills import SkillsLoader

    allow = {str(x).strip() for x in allowlist if str(x).strip()}
    loader = SkillsLoader(workspace, disabled_skills=set())
    all_names = {s["name"] for s in loader.list_skills(filter_unavailable=False)}
    return all_names - allow


def resolve_gateway_identity_overrides(
    config: Config,
    workspace: Path,
    *,
    logical_agent_id: str | None,
    team_id: str | None = None,
) -> tuple[str, list[str] | None, str | None]:
    """model, disabled_skills, console_system_prompt for :class:`AgentLoop` in ``gateway``."""
    _gw_model = config.agents.defaults.model
    _gw_disabled: list[str] | None = config.agents.defaults.disabled_skills
    _gw_console_prompt: str | None = None
    if logical_agent_id:
        _row = load_console_agent_row(workspace, logical_agent_id)
    else:
        _row = None
    if _row and isinstance(_row, dict):
        m = _row.get("model")
        if m:
            _gw_model = str(m)
        # Build a console system prompt that incorporates the agent's
        # explicit ``system_prompt`` plus an inline persona block when
        # the new bootstrap files exist on disk. This keeps the gateway
        # path consistent with sub-agent profile resolution without
        # requiring AgentLoop to know about ProfileStore.
        bits: list[str] = []
        sp = _row.get("system_prompt")
        if isinstance(sp, str) and sp.strip():
            bits.append(str(sp).strip())
        bootstrap_block = _read_console_agent_bootstrap(
            workspace, str(_row.get("id", logical_agent_id or "")).strip()
        )
        if bootstrap_block:
            bits.append(bootstrap_block)
        if bits:
            _gw_console_prompt = "\n\n---\n\n".join(bits)
        raw_sk = _row.get("skills")
        if isinstance(raw_sk, list) and raw_sk:
            _deny = disabled_skills_for_allowlist(
                workspace, [str(x) for x in raw_sk if str(x).strip()]
            )
            if _deny is not None:
                _base = set(_gw_disabled or [])
                _gw_disabled = sorted(_base | _deny)
        # Per-agent explicit denylist (independent persona feature).
        raw_deny = _row.get("skills_denylist")
        if isinstance(raw_deny, list) and raw_deny:
            _base = set(_gw_disabled or [])
            for entry in raw_deny:
                name = str(entry).strip()
                if name:
                    _base.add(name)
            _gw_disabled = sorted(_base)
    _tid = (team_id or "").strip() or None
    if not _tid:
        _tid = os.environ.get("NANOBOT_TEAM_ID", "").strip() or None
    if _tid:
        _trow = load_console_team_row(workspace, _tid)
        if isinstance(_trow, dict):
            # Same allowlist mechanics as per-agent ``skills`` in console agent JSON: only
            # listed skills stay enabled; others are added to ``disabled_skills``. Combined
            # with the agent allowlist, effective enabled skills are the intersection.
            _tsk = _trow.get("team_skills")
            if isinstance(_tsk, list) and _tsk:
                _deny_t = disabled_skills_for_allowlist(
                    workspace, [str(x) for x in _tsk if str(x).strip()]
                )
                if _deny_t is not None:
                    _base = set(_gw_disabled or [])
                    _gw_disabled = sorted(_base | _deny_t)
            _extra_bits: list[str] = []
            _cn = _trow.get("context_notes")
            if isinstance(_cn, str) and _cn.strip():
                _extra_bits.append(f"# Team instructions\n\n{_cn.strip()}")
            if _extra_bits:
                _merged_team = "\n\n---\n\n".join(_extra_bits)
                _gw_console_prompt = (
                    f"{_gw_console_prompt}\n\n---\n\n{_merged_team}"
                    if _gw_console_prompt
                    else _merged_team
                )
    return _gw_model, _gw_disabled, _gw_console_prompt


_BOOTSTRAP_NAMES: tuple[tuple[str, str], ...] = (
    ("agents", "AGENTS.md"),
    ("soul", "SOUL.md"),
    ("user", "USER.md"),
    ("tools", "TOOLS.md"),
)


def _read_console_agent_bootstrap(workspace: Path, agent_id: str) -> str:
    """Return concatenated SOUL/USER/AGENTS/TOOLS markdown for *agent_id*.

    Looks under ``<workspace>/agents/<agent_id>/<NAME>.md``; missing
    files are skipped. Returns an empty string if none exist.
    """
    aid = (agent_id or "").strip()
    if not aid:
        return ""
    base = workspace / "agents" / aid
    if not base.is_dir():
        return ""
    parts: list[str] = []
    for _key, filename in _BOOTSTRAP_NAMES:
        path = base / filename
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        if not content.strip():
            continue
        parts.append(f"## (agent) {filename}\n\n{content.strip()}")
    return "\n\n".join(parts)
