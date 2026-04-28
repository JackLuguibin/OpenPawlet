"""
OpenPawlet - A lightweight AI agent framework
"""

import tomllib
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path


def _read_pyproject_version() -> str | None:
    """Read the source-tree version when package metadata is unavailable."""
    # src/openpawlet/__init__.py -> repo root is parents[2]
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    if not pyproject.exists():
        return None
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    return data.get("project", {}).get("version")


def _resolve_version() -> str:
    try:
        return _pkg_version("open-pawlet")
    except PackageNotFoundError:
        # Source checkouts often import openpawlet without installed dist-info.
        return _read_pyproject_version() or "0.0.0"


__version__ = _resolve_version()
__logo__ = "🐈"

from openpawlet.openpawlet import OpenPawlet, RunResult

__all__ = ["OpenPawlet", "RunResult"]
