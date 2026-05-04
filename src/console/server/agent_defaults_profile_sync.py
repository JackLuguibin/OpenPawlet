"""Align workspace ``agents/<id>/profile.json`` with Settings ``agents.defaults``."""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from openpawlet.config.profile import (
    AgentProfile,
    load_profile_json,
    profile_json_path,
    profile_legacy_json_path,
    save_profile_json,
)
from openpawlet.config.schema import AgentDefaults
from openpawlet.utils.team_gateway_runtime import resolve_effective_gateway_agent_id


def resolve_main_agent_id_for_settings_sync(workspace: Path) -> str | None:
    """Return the agent id whose profile should track global agent defaults.

    Prefer an explicit ``agents/main/`` (or legacy ``main.json``) record;
    otherwise reuse :func:`~openpawlet.utils.team_gateway_runtime.resolve_effective_gateway_agent_id`.
    """
    agents = workspace / "agents"
    if not agents.is_dir():
        return None
    if (agents / "main" / "profile.json").is_file() or (agents / "main.json").is_file():
        return "main"
    return resolve_effective_gateway_agent_id(workspace)


def _apply_agent_defaults_to_main_profile(
    profile: AgentProfile, defaults: AgentDefaults
) -> AgentProfile:
    """Copy console ``agents.defaults`` fields onto the primary profile record."""
    ov = profile.overrides.model_copy(
        update={
            "model": None,
            "temperature": None,
            "provider": defaults.provider,
            "max_tokens": defaults.max_tokens,
            "context_window_tokens": defaults.context_window_tokens,
            "context_block_limit": defaults.context_block_limit,
            "max_tool_iterations": defaults.max_tool_iterations,
            "max_history_messages": defaults.max_history_messages,
            "max_tool_result_chars": defaults.max_tool_result_chars,
            "provider_retry_mode": defaults.provider_retry_mode,
            "reasoning_effort": defaults.reasoning_effort,
            "timezone": defaults.timezone,
            "disabled_skills": list(defaults.disabled_skills),
        }
    )
    return profile.model_copy(
        update={
            "model": defaults.model,
            "temperature": defaults.temperature,
            "overrides": ov,
        }
    )


def sync_main_workspace_agent_profile_from_config_defaults(
    workspace: Path, defaults: AgentDefaults
) -> None:
    """Update the primary agent ``profile.json`` when ``agents.defaults`` changes.

    No-op when the workspace has no unambiguous primary profile on disk.
    """
    aid = resolve_main_agent_id_for_settings_sync(workspace)
    if not aid:
        return
    preferred = profile_json_path(workspace, aid)
    legacy = profile_legacy_json_path(workspace, aid)
    load_path = preferred if preferred.is_file() else legacy
    if not load_path.is_file():
        return
    profile = load_profile_json(load_path)
    if profile is None:
        logger.warning("[config] Skip agent profile sync: unreadable {}", load_path)
        return
    if profile.id != aid:
        profile = profile.model_copy(update={"id": aid})
    try:
        updated = _apply_agent_defaults_to_main_profile(profile, defaults)
        save_profile_json(profile_json_path(workspace, aid), updated)
    except OSError as exc:
        logger.warning(
            "[config] Agent profile sync failed (workspace={} agent={}): {}",
            workspace,
            aid,
            exc,
        )
