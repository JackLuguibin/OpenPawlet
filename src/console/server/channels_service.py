"""Channel list, update, and disable backed by ``config.json`` and runtime state."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import ValidationError

from console.server.bot_workspace import read_bot_runtime
from console.server.models.channels import ChannelRefreshResult
from console.server.models.status import ChannelStatus
from console.server.nanobot_user_config import (
    build_config_response,
    load_raw_config,
    merge_config_section,
    resolve_config_path,
    save_full_config,
    validate_core_config,
)

# Keys reserved for ``ChannelsConfig`` (not plugin channel names).
_RESERVED_CHANNELS_ROOT_KEYS = frozenset(
    {"sendProgress", "sendToolHints", "sendMaxRetries"}
)


class ChannelNotFoundError(Exception):
    """Raised when a plugin channel name is missing from ``channels``."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"Unknown channel: {name}")


def _is_channel_plugin_entry(key: str, value: Any) -> bool:
    """Return True if ``key``/``value`` is a plugin channel block under ``channels``."""
    if key in _RESERVED_CHANNELS_ROOT_KEYS:
        return False
    return isinstance(value, dict)


def _enabled_from_config(channel_dict: dict[str, Any]) -> bool:
    """Match Channels UI: missing ``enabled`` is treated as enabled."""
    return channel_dict.get("enabled") is not False


def _runtime_status(
    enabled: bool,
    running: bool,
) -> Literal["online", "offline", "error"]:
    """Derive connectivity label from bot process and channel switch."""
    if not enabled:
        return "offline"
    if running:
        return "online"
    return "offline"


def plugin_channel_names(bot_id: str | None) -> list[str]:
    """Return sorted plugin channel keys under ``channels`` (excludes reserved keys)."""
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, dict):
        return []
    names: list[str] = []
    for name in channels_raw.keys():
        value = channels_raw[name]
        if _is_channel_plugin_entry(name, value):
            names.append(name)
    return sorted(names)


def list_channel_statuses(bot_id: str | None) -> list[ChannelStatus]:
    """Build channel rows from ``channels`` in ``config.json`` plus runtime."""
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, dict):
        return []
    running, _ = read_bot_runtime(bot_id)
    rows: list[ChannelStatus] = []
    for name in sorted(channels_raw.keys()):
        value = channels_raw[name]
        if not _is_channel_plugin_entry(name, value):
            continue
        channel_dict = value
        enabled = _enabled_from_config(channel_dict)
        status = _runtime_status(enabled, running)
        rows.append(
            ChannelStatus(
                name=name,
                enabled=enabled,
                status=status,
                stats={},
            )
        )
    return rows


def merge_channel_patch(
    bot_id: str | None,
    name: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Deep-merge ``patch`` into ``channels.<name>`` and persist.

    Returns the saved channel dict.
    """
    if name in _RESERVED_CHANNELS_ROOT_KEYS:
        msg = f"Reserved channel key: {name}"
        raise ValueError(msg)
    path = resolve_config_path(bot_id)
    merged = merge_config_section(path, "channels", {name: patch})
    ok, errors = validate_core_config(merged)
    if not ok:
        msg = "; ".join(errors) if errors else "Invalid configuration"
        raise ValueError(msg)
    try:
        save_full_config(path, merged)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    data = build_config_response(path)
    channels_out = data.get("channels")
    if not isinstance(channels_out, dict):
        return {}
    entry = channels_out.get(name)
    return entry if isinstance(entry, dict) else {}


def disable_channel(bot_id: str | None, name: str) -> None:
    """Set ``channels.<name>.enabled`` to False."""
    if name in _RESERVED_CHANNELS_ROOT_KEYS:
        msg = f"Reserved channel key: {name}"
        raise ValueError(msg)
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, dict) or name not in channels_raw:
        raise ChannelNotFoundError(name)
    merge_channel_patch(bot_id, name, {"enabled": False})


def refresh_channel_results(
    bot_id: str | None,
    names: list[str],
) -> list[ChannelRefreshResult]:
    """Re-read config and report success per channel.

    Actual connectivity is not probed here.
    """
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, dict):
        channels_raw = {}
    results: list[ChannelRefreshResult] = []
    for name in names:
        if name in _RESERVED_CHANNELS_ROOT_KEYS:
            results.append(
                ChannelRefreshResult(
                    name=name,
                    success=False,
                    message="Reserved channel key",
                )
            )
            continue
        if name not in channels_raw:
            results.append(
                ChannelRefreshResult(
                    name=name,
                    success=False,
                    message="Unknown channel",
                )
            )
            continue
        results.append(
            ChannelRefreshResult(name=name, success=True, message=None),
        )
    return results


def channel_plugin_exists(bot_id: str | None, name: str) -> bool:
    """Return True if ``name`` is a plugin block under ``channels``."""
    if name in _RESERVED_CHANNELS_ROOT_KEYS:
        return False
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, dict):
        return False
    if name not in channels_raw:
        return False
    return _is_channel_plugin_entry(name, channels_raw[name])
