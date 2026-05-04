"""Tests for session key helpers used by embedded runtime and channel routing."""

from openpawlet.utils.background_session import (
    is_background_ephemeral_session_key,
    is_internal_routing_only_channel,
)


def test_internal_routing_only_matches_session_derived_channels() -> None:
    assert is_internal_routing_only_channel("cron") is True
    assert is_internal_routing_only_channel("Cron") is True
    assert is_internal_routing_only_channel("temp") is True
    assert is_internal_routing_only_channel("system") is True


def test_internal_routing_only_excludes_real_channels_and_empty() -> None:
    assert is_internal_routing_only_channel("websocket") is False
    assert is_internal_routing_only_channel("telegram") is False
    assert is_internal_routing_only_channel("") is False
    assert is_internal_routing_only_channel(None) is False


def test_background_ephemeral_session_key_unchanged() -> None:
    assert is_background_ephemeral_session_key("cron:j1-abc") is True
    assert is_background_ephemeral_session_key("temp:x") is True
    assert is_background_ephemeral_session_key("system:dream") is True
    assert is_background_ephemeral_session_key("websocket:u1") is False
