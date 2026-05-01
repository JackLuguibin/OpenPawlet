"""Fail when pyproject and frontend package versions drift.

Run as part of CI to keep the wheel version and the SPA ``package.json`` in
lock-step.  FastAPI ``info.version`` is resolved from installed metadata at
runtime (see ``openpawlet_distribution_version``).
and exits non-zero on mismatch so PRs surface the divergence early.
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
PACKAGE_JSON = ROOT / "src" / "console" / "web" / "package.json"


def _read_pyproject_version() -> str:
    with PYPROJECT.open("rb") as f:
        data = tomllib.load(f)
    return str(data["project"]["version"]).strip()


def _read_package_json_version() -> str:
    with PACKAGE_JSON.open(encoding="utf-8") as f:
        data = json.load(f)
    return str(data["version"]).strip()


def main() -> int:
    py_ver = _read_pyproject_version()
    web_ver = _read_package_json_version()
    print(f"pyproject.toml       version = {py_ver}")
    print(f"web/package.json     version = {web_ver}")
    if py_ver != web_ver:
        print(
            "ERROR: version mismatch; bump both files in lock-step.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
