#!/usr/bin/env python3
"""Bump open-pawlet release version across the repo (SemVer semantics, PEP 440 strings).

Requires the ``dev`` extra (``packaging``). From repo root, after ``pip install -e ".[dev]"``
(or ``uv sync --extra dev`` / ``uv run python ...`` if you use uv)::

  python scripts/bump_open_pawlet_version.py --dry-run
  python scripts/bump_open_pawlet_version.py --patch --yes

With a venv::

  .venv/bin/python scripts/bump_open_pawlet_version.py
  .venv/bin/python scripts/bump_open_pawlet_version.py --patch --yes
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Literal

from packaging.version import InvalidVersion, Version
from questionary import Choice, select

REPO_ROOT = Path(__file__).resolve().parents[1]

PYPROJECT = REPO_ROOT / "pyproject.toml"
SCHEMA = REPO_ROOT / "src" / "console" / "server" / "config" / "schema.py"
WEB_PKG = REPO_ROOT / "src" / "console" / "web" / "package.json"
WEB_LOCK = REPO_ROOT / "src" / "console" / "web" / "package-lock.json"

PreKind = Literal["a", "b", "rc"]


def _release_tuple(v: Version) -> tuple[int, int, int]:
    rel = v.release
    if not rel:
        return (0, 0, 0)
    major = rel[0]
    minor = rel[1] if len(rel) > 1 else 0
    patch = rel[2] if len(rel) > 2 else 0
    return (major, minor, patch)


def _format_stable(major: int, minor: int, patch: int) -> str:
    return f"{major}.{minor}.{patch}"


def _format_prerelease(major: int, minor: int, patch: int, kind: PreKind, n: int) -> str:
    base = _format_stable(major, minor, patch)
    if kind == "rc":
        return f"{base}rc{n}"
    return f"{base}{kind}{n}"


def bump_major(v: Version) -> str:
    major, minor, patch = _release_tuple(v)
    return _format_stable(major + 1, 0, 0)


def bump_minor(v: Version) -> str:
    major, minor, patch = _release_tuple(v)
    return _format_stable(major, minor + 1, 0)


def bump_patch(v: Version) -> str:
    major, minor, patch = _release_tuple(v)
    return _format_stable(major, minor, patch + 1)


def bump_to_stable_release(v: Version) -> str:
    """Strip prerelease/dev/post/local; return X.Y.Z from the release segment."""
    major, minor, patch = _release_tuple(v)
    return _format_stable(major, minor, patch)


def _normalize_pre_kind(kind: str) -> PreKind:
    k = kind.lower().strip()
    if k in ("alpha", "a"):
        return "a"
    if k in ("beta", "b"):
        return "b"
    if k in ("rc", "c"):
        return "rc"
    raise ValueError(f"Unknown prerelease kind: {kind!r} (use alpha, beta, rc)")


def _pre_kind_from_version(v: Version) -> PreKind | None:
    if not v.pre:
        return None
    tag = v.pre[0]
    if tag == "a":
        return "a"
    if tag == "b":
        return "b"
    if tag == "rc":
        return "rc"
    return None


def bump_prerelease(v: Version, kind: PreKind) -> str:
    """Add or increment a PEP 440 prerelease (a/b/rc) on the current release line."""
    major, minor, patch = _release_tuple(v)
    if v.pre is None:
        # Next patch line, first prerelease (e.g. 1.2.3 -> 1.2.4a1)
        return _format_prerelease(major, minor, patch + 1, kind, 1)
    pk = _pre_kind_from_version(v)
    n = v.pre[1] if v.pre else 1
    if pk == kind:
        return _format_prerelease(major, minor, patch, kind, n + 1)
    # Switch prerelease type on same X.Y.Z
    return _format_prerelease(major, minor, patch, kind, 1)


def read_project_version() -> str:
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    v = data.get("project", {}).get("version")
    if not v or not isinstance(v, str):
        raise ValueError(f"Missing [project] version in {PYPROJECT}")
    return v


def validate_version_string(s: str) -> Version:
    try:
        return Version(s)
    except InvalidVersion as e:
        raise SystemExit(f"Invalid PEP 440 version {s!r}: {e}") from e


def replace_pyproject_version(content: str, new_version: str) -> str:
    lines = content.splitlines(keepends=True)
    in_project_header = False
    replaced = False
    out: list[str] = []
    for line in lines:
        st = line.strip()
        if st == "[project]":
            in_project_header = True
        elif in_project_header and st.startswith("[") and st != "[project]":
            in_project_header = False
        if in_project_header and not replaced and re.match(r"^\s*version\s*=\s*\"", line):
            line = re.sub(r'version\s*=\s*"[^"]*"', f'version = "{new_version}"', line, count=1)
            replaced = True
        out.append(line)
    if not replaced:
        raise ValueError("Could not find version = under [project] in pyproject.toml")
    return "".join(out)


def replace_schema_api_version(content: str, new_version: str) -> str:
    pat = (
        r'(version:\s*str\s*=\s*Field\(default=")([^"]+)'
        r'("\s*,\s*description="API version"\))'
    )

    def _repl(m: re.Match[str]) -> str:
        return m.group(1) + new_version + m.group(3)

    new_content, n = re.subn(pat, _repl, content, count=1)
    if n == 1:
        return new_content
    # ServerSettings.version may use default_factory=_resolve_package_version(); then
    # the reported API version follows pyproject.toml / the wheel and needs no edit here.
    if re.search(
        r"version:\s*str\s*=\s*Field\(\s*\n\s*default_factory=_resolve_package_version",
        content,
    ):
        return content
    raise ValueError("Could not patch ServerSettings.version Field in schema.py")


def apply_version(new_version: str, dry_run: bool) -> list[Path]:
    validate_version_string(new_version)
    targets: list[tuple[Path, str]] = []

    pp = PYPROJECT.read_text(encoding="utf-8")
    targets.append((PYPROJECT, replace_pyproject_version(pp, new_version)))

    sc = SCHEMA.read_text(encoding="utf-8")
    targets.append((SCHEMA, replace_schema_api_version(sc, new_version)))

    wj = WEB_PKG.read_text(encoding="utf-8")
    wdata = json.loads(wj)
    wdata["version"] = new_version
    targets.append((WEB_PKG, json.dumps(wdata, indent=2, ensure_ascii=False) + "\n"))

    wl = WEB_LOCK.read_text(encoding="utf-8")
    wldata = json.loads(wl)
    wldata["version"] = new_version
    if "" in wldata.get("packages", {}):
        wldata["packages"][""]["version"] = new_version
    targets.append((WEB_LOCK, json.dumps(wldata, indent=2, ensure_ascii=False) + "\n"))

    if dry_run:
        return [p for p, _ in targets]

    for path, text in targets:
        path.write_text(text, encoding="utf-8")
    return [p for p, _ in targets]


def interactive_choose(current: str) -> str:
    v = validate_version_string(current)
    # Choice(title, value): first arg is label, second is returned when selected.
    action = select(
        "Release step (SemVer + PEP 440 prereleases)",
        choices=[
            Choice("Major (breaking)", "major"),
            Choice("Minor (features)", "minor"),
            Choice("Patch (fixes)", "patch"),
            Choice("Prerelease (alpha / beta / rc)", "prerelease"),
            Choice("Release (strip prerelease → stable X.Y.Z)", "release"),
            Choice("Abort", "abort"),
        ],
        default="patch",
    ).ask()

    if action is None or action == "abort":
        raise SystemExit(0)

    if action == "prerelease":
        kind = select(
            "Prerelease kind",
            choices=[
                Choice("Alpha (a)", "alpha"),
                Choice("Beta (b)", "beta"),
                Choice("Release candidate (rc)", "rc"),
            ],
            default="alpha",
        ).ask()
        if kind is None:
            raise SystemExit(0)
        pk = _normalize_pre_kind(kind)
        return bump_prerelease(v, pk)

    if action == "release":
        return bump_to_stable_release(v)

    if action == "major":
        return bump_major(v)
    if action == "minor":
        return bump_minor(v)
    if action == "patch":
        return bump_patch(v)
    raise RuntimeError(f"Unhandled action {action!r}")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Bump open-pawlet version across the repository.")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--major", action="store_true", help="Increment major (stable).")
    g.add_argument("--minor", action="store_true", help="Increment minor (stable).")
    g.add_argument("--patch", action="store_true", help="Increment patch (stable).")
    g.add_argument(
        "--prerelease",
        metavar="KIND",
        help="Prerelease bump: alpha|beta|rc (PEP 440: a/b/rc).",
    )
    g.add_argument(
        "--release",
        action="store_true",
        help="Drop prerelease/dev/post/local; keep X.Y.Z stable only.",
    )
    p.add_argument("--yes", "-y", action="store_true", help="Skip confirmation.")
    p.add_argument("--dry-run", action="store_true", help="Print target version and files; do not write.")
    p.add_argument(
        "--git-add",
        action="store_true",
        help="After writing, run git add on touched files (no commit).",
    )
    return p.parse_args(argv)


def resolve_new_version(args: argparse.Namespace, current: str) -> str:
    v = validate_version_string(current)
    if args.major:
        return bump_major(v)
    if args.minor:
        return bump_minor(v)
    if args.patch:
        return bump_patch(v)
    if args.prerelease:
        pk = _normalize_pre_kind(args.prerelease)
        return bump_prerelease(v, pk)
    if args.release:
        return bump_to_stable_release(v)
    return interactive_choose(current)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    current = read_project_version()
    new_version = resolve_new_version(args, current)

    print(f"Current: {current}")
    print(f"New:     {new_version}")

    if current == new_version:
        print("No version change.", file=sys.stderr)
        raise SystemExit(1)

    paths = apply_version(new_version, dry_run=True)
    print("Files to update:")
    for path in paths:
        print(f"  {path.relative_to(REPO_ROOT)}")

    if args.dry_run:
        print("(dry-run: no files written)")
        return

    if not args.yes:
        from questionary import confirm

        ok = confirm("Write these changes?", default=True).ask()
        if not ok:
            raise SystemExit(1)

    apply_version(new_version, dry_run=False)
    print("Version bump written.")

    if args.git_add:
        rel = [str(p.relative_to(REPO_ROOT)) for p in paths]
        subprocess.run(["git", "add", *rel], cwd=REPO_ROOT, check=True)
        print("Staged:", ", ".join(rel))


if __name__ == "__main__":
    main()
