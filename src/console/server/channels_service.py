"""Channel list, update, and disable backed by ``config.json`` and runtime state."""

from __future__ import annotations

from typing import Any, Literal

from loguru import logger
from pydantic import ValidationError

from console.server.bot_workspace import read_bot_runtime
from console.server.models.channels import ChannelRefreshResult
from console.server.models.status import ChannelStatus
from console.server.openpawlet_user_config import (
    build_config_response,
    load_raw_config,
    merge_config_section,
    resolve_config_path,
    save_full_config,
    validate_core_config,
)

# Root keys of ``openpawlet.config.schema.ChannelsConfig`` (camelCase / snake_case
# as in JSON). These are not plugin channel names.
_CHANNELS_CONFIG_ROOT_KEYS = frozenset(
    {
        "sendProgress",
        "sendToolHints",
        "sendToolEvents",
        "sendReasoningContent",
        "sendMaxRetries",
        "transcriptionProvider",
        "transcriptionLanguage",
        "sessionTurnLifecycleChannels",
        "send_progress",
        "send_tool_hints",
        "send_tool_events",
        "send_reasoning_content",
        "send_max_retries",
        "transcription_provider",
        "transcription_language",
        "session_turn_lifecycle_channels",
    }
)
_RESERVED_CHANNELS_ROOT_KEYS = _CHANNELS_CONFIG_ROOT_KEYS


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


def _discover_available_channel_names() -> list[str]:
    """Return all installable channel plugin names (built-in + entry-point).

    Failures are swallowed: discovery should never break the API surface.
    Returns an empty list when the openpawlet package is unavailable for any
    reason (e.g. broken install during dev). Names are de-duplicated.
    """
    try:
        from openpawlet.channels.registry import (
            discover_channel_names,
            discover_plugins,
        )
    except Exception:  # noqa: BLE001 - keep API resilient
        return []
    names: set[str] = set()
    try:
        names.update(discover_channel_names())
    except Exception as exc:  # noqa: BLE001
        logger.debug("discover_channel_names failed: {}", exc)
    try:
        names.update(discover_plugins().keys())
    except Exception as exc:  # noqa: BLE001
        logger.debug("discover_plugins failed: {}", exc)
    return sorted(names)


def list_channel_statuses(bot_id: str | None) -> list[ChannelStatus]:
    """Build channel rows for the UI.

    Includes every channel plugin currently installed (built-in modules and
    external entry points) so the user always sees a card per channel even
    when ``config.json`` has no entry for it yet. Channels missing from
    ``channels`` in the config show up as disabled rows so the user can
    open Edit, fill in credentials and enable them.
    """
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    channels_raw = raw.get("channels") if isinstance(raw.get("channels"), dict) else {}
    running, _ = read_bot_runtime(bot_id)

    configured: dict[str, dict[str, Any]] = {}
    for name, value in channels_raw.items():
        if _is_channel_plugin_entry(name, value):
            configured[name] = value

    all_names = set(configured.keys()) | set(_discover_available_channel_names())
    rows: list[ChannelStatus] = []
    for name in sorted(all_names):
        channel_dict = configured.get(name)
        if channel_dict is None:
            # Plugin is installed but not yet configured: render as disabled
            # template card so the Channels page is never empty out of the box.
            enabled = False
        else:
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
