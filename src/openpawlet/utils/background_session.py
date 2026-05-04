"""Session keys for main-agent background work (Dream, cron without explicit session)."""

from __future__ import annotations

# Channel ``system`` + chat id ``dream``: consolidated Dream runs and default cron turns.
MAIN_AGENT_DREAM_SESSION_KEY = "system:dream"

# First segment of keys like ``cron:*``, ``temp:*``, ``system:dream`` after ``session_key_channel_chat``.
# These name segments are routing/session semantics only — no matching channel plugin exists.
_INTERNAL_ROUTING_ONLY_CHANNELS = frozenset({"cron", "temp", "system"})


def is_internal_routing_only_channel(channel: str | None) -> bool:
    """True when outbound delivery uses a synthetic channel name (no bus adapter)."""
    c = (channel or "").strip().lower()
    return bool(c) and c in _INTERNAL_ROUTING_ONLY_CHANNELS


def is_background_ephemeral_session_key(key: str) -> bool:
    """True when the console should group this key under temporary / background sessions."""
    k = (key or "").strip()
    if not k:
        return False
    if k == MAIN_AGENT_DREAM_SESSION_KEY:
        return True
    if k.startswith("temp:"):
        return True
    # Legacy per-job keys when no session_key was set on the cron payload.
    if k.startswith("cron:"):
        return True
    return False
