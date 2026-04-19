"""
nanobot - A lightweight AI agent framework
"""

from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path
import tomllib


def _read_pyproject_version() -> str | None:
    """Read the source-tree version when package metadata is unavailable."""
    # src/nanobot/__init__.py -> repo root is parents[2]
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    if not pyproject.exists():
        return None
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    return data.get("project", {}).get("version")


def _resolve_version() -> str:
    for dist_name in ("open-pawlet", "nanobot-ai"):
        try:
            return _pkg_version(dist_name)
        except PackageNotFoundError:
            continue
    # Source checkouts often import nanobot without installed dist-info.
    return _read_pyproject_version() or "0.0.0"


__version__ = _resolve_version()
__logo__ = "🐈"

from nanobot.nanobot import Nanobot, RunResult

__all__ = ["Nanobot", "RunResult"]
