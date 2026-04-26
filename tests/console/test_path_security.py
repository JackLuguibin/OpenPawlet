"""Path traversal and symlink defenses for ``safe_join``.

These tests target ``console.server.bot_workspace.safe_join`` directly so
they do not need the FastAPI app or nanobot config; the regressions they
guard against (escape via ``..``, symlinked parent, symlinked leaf) are
the same that would otherwise let a malicious POST /workspace/file or
PUT /skills/.../bundle write outside its controlled root.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

# Make the ``console`` package importable when running ``pytest`` directly
# from a checkout (the project's ``pyproject.toml`` already adds ``src/``
# for the main suite, but our new tests/console/ tree is registered via
# the same conftest discovery mechanism).
ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from console.server.bot_workspace import safe_join  # noqa: E402


def test_safe_join_returns_root_for_empty_rel(tmp_path: Path) -> None:
    assert safe_join(tmp_path, None, must_exist=False) == tmp_path.resolve()
    assert safe_join(tmp_path, "", must_exist=False) == tmp_path.resolve()


def test_safe_join_accepts_nested(tmp_path: Path) -> None:
    target = safe_join(tmp_path, "a/b/c.txt", must_exist=False)
    assert target == (tmp_path / "a" / "b" / "c.txt").resolve()


def test_safe_join_rejects_dotdot(tmp_path: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        safe_join(tmp_path, "../escape.txt", must_exist=False)
    assert exc.value.status_code == 400


def test_safe_join_rejects_absolute(tmp_path: Path) -> None:
    abs_target = "/etc/passwd" if os.name != "nt" else "C:/Windows/System32/cmd.exe"
    # _normalize_rel_path strips leading slashes, so the path becomes
    # ``etc/passwd`` underneath the base; that's still safe.  We use a
    # genuine traversal attempt below to force the rejection branch.
    with pytest.raises(HTTPException):
        safe_join(tmp_path, "../" + abs_target.lstrip("/"), must_exist=False)


def test_safe_join_rejects_backslash_traversal(tmp_path: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        safe_join(tmp_path, "..\\escape.txt", must_exist=False)
    assert exc.value.status_code == 400


def test_safe_join_rejects_symlinked_leaf(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("symlink creation requires elevated privileges on Windows")
    outside = tmp_path.parent / "outside_target.txt"
    outside.write_text("secret", encoding="utf-8")
    link = tmp_path / "link.txt"
    link.symlink_to(outside)
    with pytest.raises(HTTPException) as exc:
        safe_join(tmp_path, "link.txt", must_exist=True)
    assert exc.value.status_code == 400


def test_safe_join_rejects_symlinked_parent(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("symlink creation requires elevated privileges on Windows")
    outside_dir = tmp_path.parent / "outside_dir"
    outside_dir.mkdir()
    (outside_dir / "leaf.txt").write_text("secret", encoding="utf-8")
    link = tmp_path / "linked_parent"
    link.symlink_to(outside_dir, target_is_directory=True)
    with pytest.raises(HTTPException) as exc:
        safe_join(tmp_path, "linked_parent/leaf.txt", must_exist=True)
    assert exc.value.status_code == 400


def test_safe_join_must_exist_404(tmp_path: Path) -> None:
    with pytest.raises(HTTPException) as exc:
        safe_join(tmp_path, "missing.txt", must_exist=True)
    assert exc.value.status_code == 404
