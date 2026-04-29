"""Tests for ``merge_config_section`` (SPA config patches)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

_ouc_path = SRC / "console" / "server" / "openpawlet_user_config.py"
_spec = importlib.util.spec_from_file_location("openpawlet_user_config_under_test", _ouc_path)
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)
merge_config_section = _mod.merge_config_section


def test_tools_mcp_servers_patch_replaces_map(tmp_path: Path) -> None:
    """Sending ``mcpServers`` must drop servers omitted from the payload."""
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "tools": {
                    "mcpServers": {
                        "drop-me": {"command": "echo"},
                        "keep-me": {"command": "npx", "args": ["-y", "x"]},
                    },
                    "restrictToWorkspace": True,
                }
            }
        ),
        encoding="utf-8",
    )
    merged = merge_config_section(
        path,
        "tools",
        {"mcpServers": {"keep-me": {"command": "npx", "args": ["-y", "y"]}}},
    )
    assert merged["tools"]["mcpServers"] == {"keep-me": {"command": "npx", "args": ["-y", "y"]}}
    assert merged["tools"]["restrictToWorkspace"] is True
