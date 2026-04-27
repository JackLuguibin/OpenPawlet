"""Minimal ``.env`` reader/writer used by the console.

The console ships its own implementation (rather than depending on
``python-dotenv``) because the format we accept is intentionally a strict
subset: no command substitution, no exports, no continuation lines.  The
helpers here also know how to JSON-quote values that contain whitespace,
newlines, comments or quotes so a write/read round-trip is lossless.
"""

from __future__ import annotations

import json
from pathlib import Path

__all__ = ["parse_dotenv_file", "write_dotenv_file"]


def _dotenv_value_needs_quoting(value: str) -> bool:
    """Return True if ``value`` should be JSON-quoted for ``.env``."""
    if not value:
        return False
    if any(c in value for c in "\n\r#\"'"):
        return True
    if value.startswith(" ") or value.endswith(" "):
        return True
    return False


def _strip_inline_quotes(value: str) -> str:
    """Strip a single matched pair of ``"`` or ``'`` from *value* if present."""
    if len(value) >= 2 and value[0] in "\"'":
        quote = value[0]
        if value.endswith(quote):
            return value[1:-1]
    return value


def parse_dotenv_file(path: Path) -> dict[str, str]:
    """Parse a minimal KEY=VALUE ``.env`` file into a string dict.

    Lines that are blank, start with ``#``, or contain no ``=`` are silently
    skipped.  Values surrounded by matching ``"`` or ``'`` are unquoted.
    """
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        if not key:
            continue
        result[key] = _strip_inline_quotes(value.strip())
    return result


def write_dotenv_file(path: Path, vars_map: dict[str, str]) -> None:
    """Write *vars_map* to *path* as sorted ``KEY=VALUE`` lines.

    Values containing whitespace, newlines or quote characters are emitted as
    JSON strings so they round-trip cleanly via :func:`parse_dotenv_file`.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for key in sorted(vars_map.keys()):
        val = vars_map[key]
        encoded = json.dumps(val, ensure_ascii=False) if _dotenv_value_needs_quoting(val) else val
        lines.append(f"{key}={encoded}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
