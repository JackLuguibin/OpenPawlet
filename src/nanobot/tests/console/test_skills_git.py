"""Tests for the Skills Git source feature.

Splits into three layers:

* pure-function tests for the sync engine helpers (no subprocess required);
* HTTP CRUD tests against the FastAPI router using ``monkeypatch`` to stub
  the actual ``sync_repo`` engine;
* an optional end-to-end test that spins up a local bare git repository and
  exercises the real ``git`` subprocess path. Skipped automatically when
  the ``git`` executable is unavailable.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.config import ServerSettings


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------


def test_inject_token_url_basic_https() -> None:
    from console.server.models.skills_git import SkillsGitAuth
    from console.server.skills_git_sync import _inject_token_into_url

    auth = SkillsGitAuth(kind="token", token_env="TEST_TOKEN", username="oauth2")
    os.environ["TEST_TOKEN"] = "secret-xyz"
    try:
        out = _inject_token_into_url(
            "https://github.com/owner/repo.git", auth, bot_id=None
        )
    finally:
        os.environ.pop("TEST_TOKEN", None)
    assert out == "https://oauth2:secret-xyz@github.com/owner/repo.git"


def test_inject_token_rejects_ssh_scheme() -> None:
    from console.server.models.skills_git import SkillsGitAuth
    from console.server.skills_git_sync import GitSyncError, _inject_token_into_url

    auth = SkillsGitAuth(kind="token", token_env="X")
    os.environ["X"] = "v"
    try:
        with pytest.raises(GitSyncError):
            _inject_token_into_url("ssh://git@host/repo.git", auth, None)
    finally:
        os.environ.pop("X", None)


def test_inject_token_no_op_for_none_auth() -> None:
    from console.server.models.skills_git import SkillsGitAuth
    from console.server.skills_git_sync import _inject_token_into_url

    out = _inject_token_into_url(
        "https://example.com/r.git",
        SkillsGitAuth(kind="none"),
        bot_id=None,
    )
    assert out == "https://example.com/r.git"


def test_redact_secrets_strips_creds() -> None:
    from console.server.skills_git_sync import _redact_secrets

    msg = "fatal: could not read https://oauth2:abcdef@github.com/foo.git"
    assert "abcdef" not in _redact_secrets(msg)
    assert "***" in _redact_secrets(msg)


def test_validate_subpath_rejects_traversal() -> None:
    from console.server.skills_git_sync import GitSyncError, _validate_subpath

    assert _validate_subpath("skills/x") == "skills/x"
    assert _validate_subpath("skills\\x") == "skills/x"
    with pytest.raises(GitSyncError):
        _validate_subpath("../escape")
    with pytest.raises(GitSyncError):
        _validate_subpath("./.")


def test_iter_due_repos_picks_first_run_and_overdue() -> None:
    from console.server.models.skills_git import SkillsGitRepo
    from console.server.skills_git_sync import iter_due_repos

    now = 1_700_000_000.0
    repos = [
        SkillsGitRepo(
            id="a",
            name="a",
            url="https://x/a.git",
            auto_update=True,
            interval_minutes=10,
        ),  # never synced -> due
        SkillsGitRepo(
            id="b",
            name="b",
            url="https://x/b.git",
            auto_update=True,
            interval_minutes=10,
            last_sync_at="2023-11-14T22:13:20+00:00",  # ~now -> not due
        ),
        SkillsGitRepo(
            id="c",
            name="c",
            url="https://x/c.git",
            auto_update=False,
            interval_minutes=5,
        ),  # auto disabled
    ]
    # ``b``'s ISO time corresponds to roughly ``now``; its 10 min interval
    # has not elapsed yet, so only ``a`` is due.
    due_ids = [r.id for r in iter_due_repos(repos, now)]
    assert due_ids == ["a"]
    # Far in the future -> b is also due.
    due_ids = [r.id for r in iter_due_repos(repos, now + 10_000)]
    assert set(due_ids) == {"a", "b"}


# ---------------------------------------------------------------------------
# HTTP CRUD tests (sync engine stubbed)
# ---------------------------------------------------------------------------


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated workspace + nanobot ``config.json`` for the router under test.

    The console resolves config paths through
    :func:`console.server.bots_registry._legacy_config_path` whenever no
    multi-bot ``bot_id`` is supplied (which is the common single-instance
    case and what our tests exercise).  Stubbing that single helper
    redirects every downstream caller — routers, sync engine, workspace
    helpers, caches — to a temp file without touching the user's real
    ``~/.nanobot`` directory.
    """
    work = tmp_path / "work"
    work.mkdir()
    cfg_path = tmp_path / "nanobot_config.json"
    cfg_path.write_text(
        json.dumps({"agents": {"defaults": {"workspace": str(work)}}}),
        encoding="utf-8",
    )

    from console.server import bots_registry

    monkeypatch.setattr(bots_registry, "_legacy_config_path", lambda: cfg_path)

    # The workspace_root cache memoises by (path, mtime); clear it so the
    # stubbed config is observed fresh in every test.
    from console.server.cache import config_cache

    config_cache().invalidate(cfg_path)

    return work


@pytest.fixture
def app_no_embed(monkeypatch: pytest.MonkeyPatch):
    """A fresh FastAPI app with the embedded runtime disabled."""
    monkeypatch.setenv("OPENPAWLET_DISABLE_EMBEDDED", "1")
    settings = ServerSettings(
        host="127.0.0.1",
        port=8000,
        cors_origins=["http://test.example"],
        cors_allow_credentials=True,
        title="SkillsGitTest",
        version="0.0.0-test",
    )
    return create_app(settings, mount_spa=False)


def test_crud_lifecycle_via_http(
    workspace: Path, app_no_embed, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Stub the sync engine: never actually invoke git.
    from console.server.routers.v1 import skills_git as router_mod
    from console.server.models.skills_git import SkillsGitSyncResult

    captured: dict[str, str] = {}

    def fake_sync(repo, bot_id):  # noqa: ANN001 - test stub
        captured["url"] = repo.url
        captured["bot"] = str(bot_id)
        return SkillsGitSyncResult(
            id=repo.id,
            name=repo.name,
            status="ok",
            message="stub-ok",
            commit_sha="deadbeef",
            synced_skills=["my-skill"],
            duration_ms=1,
        )

    monkeypatch.setattr(router_mod, "sync_repo", fake_sync)

    with TestClient(app_no_embed) as client:
        # Empty list initially.
        resp = client.get("/api/v1/skills/git")
        assert resp.status_code == 200
        assert resp.json()["data"] == []

        # Create.
        resp = client.post(
            "/api/v1/skills/git",
            json={
                "name": "my-skills",
                "url": "https://github.com/owner/repo.git",
                "branch": "main",
                "kind": "single",
                "target": "my-skill",
                "auth": {"kind": "none"},
                "auto_update": False,
                "interval_minutes": 60,
            },
        )
        assert resp.status_code == 200, resp.text
        repo = resp.json()["data"]
        repo_id = repo["id"]
        assert repo["name"] == "my-skills"
        assert repo["last_sync_status"] is None

        # List again -> 1 entry.
        resp = client.get("/api/v1/skills/git")
        assert len(resp.json()["data"]) == 1

        # Update.
        resp = client.put(
            f"/api/v1/skills/git/{repo_id}",
            json={
                "name": "renamed",
                "url": "https://github.com/owner/repo.git",
                "branch": "main",
                "kind": "single",
                "target": "my-skill",
                "auth": {"kind": "none"},
                "auto_update": True,
                "interval_minutes": 30,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["name"] == "renamed"
        assert resp.json()["data"]["auto_update"] is True

        # Sync (uses stub).
        resp = client.post(f"/api/v1/skills/git/{repo_id}/sync")
        assert resp.status_code == 200, resp.text
        body = resp.json()["data"]
        assert body["status"] == "ok"
        assert body["synced_skills"] == ["my-skill"]
        assert captured["url"] == "https://github.com/owner/repo.git"

        # Telemetry persisted.
        resp = client.get("/api/v1/skills/git")
        repo_after = resp.json()["data"][0]
        assert repo_after["last_sync_status"] == "ok"
        assert repo_after["last_commit_sha"] == "deadbeef"

        # Delete.
        resp = client.delete(f"/api/v1/skills/git/{repo_id}")
        assert resp.status_code == 200

        resp = client.get("/api/v1/skills/git")
        assert resp.json()["data"] == []


def test_url_validation_rejects_garbage(workspace: Path, app_no_embed) -> None:
    with TestClient(app_no_embed) as client:
        resp = client.post(
            "/api/v1/skills/git",
            json={
                "name": "x",
                "url": "ftp://nope/r.git",
                "kind": "single",
                "auth": {"kind": "none"},
                "auto_update": False,
                "interval_minutes": 60,
            },
        )
    assert resp.status_code == 400


def test_invalid_repo_entry_does_not_break_list(
    workspace: Path, app_no_embed
) -> None:
    """A malformed legacy entry in skillsGit.repos must be silently skipped."""
    from console.server.nanobot_user_config import (
        load_raw_config,
        resolve_config_path,
        save_full_config,
    )

    cfg_path = resolve_config_path(None)
    raw = load_raw_config(cfg_path)
    raw.setdefault("skillsGit", {})["repos"] = [
        {"id": "broken"},  # missing required url, name
        {
            "id": "good",
            "name": "good",
            "url": "https://github.com/foo/bar.git",
            "kind": "single",
            "auth": {"kind": "none"},
            "auto_update": False,
            "interval_minutes": 60,
        },
    ]
    save_full_config(cfg_path, raw)

    with TestClient(app_no_embed) as client:
        resp = client.get("/api/v1/skills/git")
    assert resp.status_code == 200
    rows = resp.json()["data"]
    assert [r["id"] for r in rows] == ["good"]


# ---------------------------------------------------------------------------
# Optional end-to-end git test
# ---------------------------------------------------------------------------


def _have_git() -> bool:
    if shutil.which("git") is None:
        return False
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True, timeout=5)
        return True
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


@pytest.mark.skipif(not _have_git(), reason="git executable not available")
def test_real_clone_single_bundle(workspace: Path, tmp_path: Path) -> None:
    """End-to-end: create a bare repo with one SKILL.md and sync it."""
    from console.server.models.skills_git import SkillsGitRepo
    from console.server.skills_git_sync import sync_repo

    # 1) Create source repo with one skill bundle.
    source = tmp_path / "src-repo"
    source.mkdir()

    def git(*args: str, cwd: Path = source) -> None:
        subprocess.run(  # noqa: S603 - argv list, no shell
            ["git", *args],
            cwd=str(cwd),
            check=True,
            capture_output=True,
            env={
                **os.environ,
                "GIT_AUTHOR_NAME": "test",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "test",
                "GIT_COMMITTER_EMAIL": "t@t",
            },
        )

    git("init", "--initial-branch=main")
    skill_md = source / "SKILL.md"
    skill_md.write_text("# my-skill\n\nHello from skill.\n", encoding="utf-8")
    (source / "scripts").mkdir()
    (source / "scripts" / "run.sh").write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "init")

    # 2) Build a SkillsGitRepo pointing at that local path.
    repo = SkillsGitRepo(
        id="local1",
        name="local-test",
        url=str(source),
        branch="main",
        kind="single",
        target="my-skill",
    )

    # 3) Sync into our isolated workspace.
    started = time.time()
    result = sync_repo(repo, bot_id=None)
    elapsed = time.time() - started

    assert result.status == "ok", result.message
    assert "my-skill" in result.synced_skills
    assert result.commit_sha
    assert elapsed < 60  # sanity guard

    target_skill = workspace / ".cursor" / "skills" / "my-skill"
    assert (target_skill / "SKILL.md").is_file()
    assert (target_skill / "scripts" / "run.sh").is_file()
    # The cache lives under .cursor/.skills-git-cache/<id>/.
    assert (workspace / ".cursor" / ".skills-git-cache" / "local1" / ".git").is_dir()
