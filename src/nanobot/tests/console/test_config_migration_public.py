"""Verify that ``migrate_config`` is a stable public symbol on nanobot.

The console layer reads ``~/.nanobot/config.json`` via this helper; we need
it to be a first-class API so the console does not keep depending on a
private underscore-prefixed alias.
"""

from __future__ import annotations

from nanobot.config.loader import _migrate_config, migrate_config


def test_migrate_config_is_public() -> None:
    # Pure-function check: the legacy alias and the public name behave the same.
    legacy_input = {
        "tools": {
            "myEnabled": True,
            "mySet": ["foo"],
            "exec": {"restrictToWorkspace": True},
        }
    }
    out_public = migrate_config(dict(legacy_input))
    out_private = _migrate_config(dict(legacy_input))

    assert out_public == out_private
    tools = out_public["tools"]
    assert tools.get("restrictToWorkspace") is True
    assert tools.get("my") == {"enable": True, "allowSet": ["foo"]}
    assert "myEnabled" not in tools
    assert "mySet" not in tools


def test_backwards_compatible_alias() -> None:
    assert _migrate_config is migrate_config
