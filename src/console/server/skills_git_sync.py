"""Git source synchronisation for the Skills system.

The console-side counterpart to the ``skillsGit`` config block.  We wrap
the system ``git`` executable (rather than dulwich) because:

* it transparently supports HTTPS Personal Access Tokens, system
  ``credential.helper`` setups, http(s) proxies, large file storage and
  git-lfs, and SSH keys with passphrase prompts forwarded to the agent;
* it matches whatever git the user has configured on their machine,
  avoiding subtle protocol-v2 incompatibilities seen with dulwich on
  some self-hosted forges;
* it is already a hard requirement for any contributor working on this
  repository, so adding it as a runtime dep does not move the bar.

The module is intentionally framework-free so it can be unit-tested by
pointing at a local bare repo.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse

from loguru import logger

from console.server.bot_workspace import workspace_root
from console.server.dotenv_io import parse_dotenv_file
from console.server.models.skills_git import (
    SkillsGitAuth,
    SkillsGitRepo,
    SkillsGitSyncResult,
)
from console.server.openpawlet_user_config import env_file_path

_CURSOR_SKILLS = Path(".cursor") / "skills"
_SKILLS_GIT_CACHE_DIR = Path(".cursor") / ".skills-git-cache"
_SKILL_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
# Long enough that even slow first-time clones over flaky links finish, but
# short enough that an unresponsive credential prompt eventually fails the
# whole sync job instead of pinning the asyncio loop forever.
_GIT_TIMEOUT_SECONDS = 180


class GitSyncError(RuntimeError):
    """Raised when a git operation cannot complete cleanly."""


@dataclass
class _SyncContext:
    """Per-sync mutable state passed around helper functions."""

    repo: SkillsGitRepo
    workspace: Path
    bot_id: str | None
    env: dict[str, str]
    cleanup_files: list[Path] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def sync_repo(
    repo: SkillsGitRepo,
    bot_id: str | None,
) -> SkillsGitSyncResult:
    """Clone or fast-forward ``repo`` and materialise its skills on disk.

    Always returns a :class:`SkillsGitSyncResult`; any failure is captured
    in ``status='error'`` so callers (HTTP handlers, scheduler) can render
    a useful message instead of crashing.
    """
    started = time.perf_counter()
    workspace = workspace_root(bot_id)
    env, cleanup = _prepare_git_env(repo.auth, bot_id)
    ctx = _SyncContext(
        repo=repo, workspace=workspace, bot_id=bot_id, env=env, cleanup_files=cleanup
    )
    try:
        cache_dir = _ensure_repo_cache(ctx)
        commit_sha = _resolve_head_sha(cache_dir, env)
        installed = _install_into_workspace(ctx, cache_dir)
        return SkillsGitSyncResult(
            id=repo.id,
            name=repo.name,
            status="ok",
            message=f"Synced {len(installed)} skill(s) from {repo.url}",
            commit_sha=commit_sha,
            synced_skills=installed,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    except GitSyncError as exc:
        logger.warning("[skills-git] sync failed for {}: {}", repo.url, exc)
        return SkillsGitSyncResult(
            id=repo.id,
            name=repo.name,
            status="error",
            message=str(exc),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001 - never let scheduler die
        logger.exception("[skills-git] unexpected sync failure for {}", repo.url)
        return SkillsGitSyncResult(
            id=repo.id,
            name=repo.name,
            status="error",
            message=f"Unexpected error: {exc}",
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    finally:
        for path in cleanup:
            _safe_unlink(path)


# ---------------------------------------------------------------------------
# Git invocation
# ---------------------------------------------------------------------------


def _git(args: list[str], *, cwd: Path | None, env: dict[str, str]) -> str:
    """Run ``git`` and return stdout; raises :class:`GitSyncError` on failure."""
    try:
        result = subprocess.run(  # noqa: S603 - argv list, no shell
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            env=env,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise GitSyncError(
            "The 'git' command is not on PATH; install Git to enable Skills repo sync."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise GitSyncError(
            f"git {' '.join(args)} timed out after {_GIT_TIMEOUT_SECONDS}s"
        ) from exc
    if result.returncode != 0:
        # Surface the *trailing* stderr line which usually carries the actual
        # error (auth failure, network, branch missing, ...).  Full output is
        # logged for debugging but kept off the API response to avoid leaking
        # local paths to the browser.
        logger.debug(
            "[skills-git] git {} failed (rc={}): stdout={!r} stderr={!r}",
            args,
            result.returncode,
            result.stdout,
            result.stderr,
        )
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        message = tail[-1] if tail else f"git exited with status {result.returncode}"
        raise GitSyncError(_redact_secrets(message))
    return result.stdout


def _resolve_head_sha(repo_dir: Path, env: dict[str, str]) -> str:
    """Return the short SHA of the currently checked-out commit."""
    out = _git(["rev-parse", "--short=12", "HEAD"], cwd=repo_dir, env=env)
    return out.strip()


# ---------------------------------------------------------------------------
# Auth: HTTPS token + SSH key
# ---------------------------------------------------------------------------


def _prepare_git_env(
    auth: SkillsGitAuth, bot_id: str | None
) -> tuple[dict[str, str], list[Path]]:
    """Build the ``env`` dict for ``git`` plus a list of files to clean up."""
    env = os.environ.copy()
    cleanup: list[Path] = []
    # Hard-disable any interactive prompt: we need fast, scriptable failures.
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    env.setdefault("GIT_ASKPASS", "echo")

    if auth.kind == "ssh":
        ssh_path = (auth.ssh_key_path or "").strip()
        if not ssh_path:
            raise GitSyncError("SSH auth selected but no key path configured")
        key_path = Path(ssh_path).expanduser()
        if not key_path.is_file():
            raise GitSyncError(f"SSH key not found: {key_path}")
        # ``-o IdentitiesOnly=yes`` keeps ssh from trying every key in the
        # agent (which can lock out hosts with strict failure limits).
        ssh_cmd = (
            f'ssh -i "{key_path}" '
            f"-o IdentitiesOnly=yes "
            f"-o StrictHostKeyChecking=accept-new"
        )
        env["GIT_SSH_COMMAND"] = ssh_cmd
        if auth.ssh_passphrase_env:
            secret = _read_env_secret(auth.ssh_passphrase_env, bot_id)
            if secret:
                # Rare path; most users use unencrypted deploy keys.  We still
                # support it via SSH_ASKPASS to avoid hanging the loop.
                askpass = _write_temp_askpass(secret)
                env["SSH_ASKPASS"] = str(askpass)
                env["SSH_ASKPASS_REQUIRE"] = "force"
                env["DISPLAY"] = env.get("DISPLAY", ":0")
                cleanup.append(askpass)
    return env, cleanup


def _inject_token_into_url(url: str, auth: SkillsGitAuth, bot_id: str | None) -> str:
    """Return ``url`` with username/token embedded for HTTPS token auth."""
    if auth.kind != "token":
        return url
    if not auth.token_env:
        raise GitSyncError("Token auth selected but no env var configured")
    token = _read_env_secret(auth.token_env, bot_id)
    if not token:
        raise GitSyncError(
            f"Env var '{auth.token_env}' is empty; set it via the Env editor."
        )
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise GitSyncError("Token auth only works with http(s):// URLs")
    user = quote(auth.username or "oauth2", safe="")
    token_q = quote(token, safe="")
    netloc = f"{user}:{token_q}@{parsed.hostname}"
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _read_env_secret(name: str, bot_id: str | None) -> str | None:
    """Return the secret named ``name`` from ``.env`` or process env."""
    candidate = os.environ.get(name)
    if candidate:
        return candidate
    try:
        env_file = env_file_path(bot_id)
        if env_file.is_file():
            return parse_dotenv_file(env_file).get(name)
    except OSError:
        return None
    return None


def _write_temp_askpass(secret: str) -> Path:
    """Write a temporary askpass helper that echoes ``secret`` once."""
    import stat
    import tempfile

    suffix = ".cmd" if os.name == "nt" else ".sh"
    fd, raw = tempfile.mkstemp(prefix="op-skills-askpass-", suffix=suffix)
    path = Path(raw)
    try:
        # Keep the secret out of the file; pass it via env to the helper.
        if os.name == "nt":
            body = "@echo off\r\necho %OPENPAWLET_SECRET%\r\n"
        else:
            body = '#!/bin/sh\nprintf "%s" "$OPENPAWLET_SECRET"\n'
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
        if os.name != "nt":
            path.chmod(stat.S_IRWXU)
        os.environ["OPENPAWLET_SECRET"] = secret
    except Exception:
        _safe_unlink(path)
        raise
    return path


def _safe_unlink(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Cache directory: clone once, fast-forward on later syncs
# ---------------------------------------------------------------------------


def _cache_dir_for(workspace: Path, repo: SkillsGitRepo) -> Path:
    """Stable per-repo path under ``.cursor/.skills-git-cache``."""
    return workspace / _SKILLS_GIT_CACHE_DIR / repo.id


def _ensure_repo_cache(ctx: _SyncContext) -> Path:
    """Clone (first run) or fast-forward (later) the repo cache."""
    cache = _cache_dir_for(ctx.workspace, ctx.repo)
    cache.parent.mkdir(parents=True, exist_ok=True)
    auth_url = _inject_token_into_url(ctx.repo.url, ctx.repo.auth, ctx.bot_id)
    if cache.is_dir() and (cache / ".git").exists():
        # Move existing remote URL in case auth/token changed across runs;
        # ``set-url`` is a no-op when the URL hasn't changed.
        _git(["remote", "set-url", "origin", auth_url], cwd=cache, env=ctx.env)
        ref = ctx.repo.branch or ""
        _git(
            ["fetch", "--prune", "--depth", "1", "origin", *(["+" + ref] if ref else [])],
            cwd=cache,
            env=ctx.env,
        )
        _hard_reset_to_remote(cache, ctx.env, ctx.repo.branch)
        return cache

    # First-time clone.
    if cache.exists():
        # Half-broken state from a prior failure; nuke and retry.
        _rmtree_quiet(cache)
    args = ["clone", "--depth", "1"]
    if ctx.repo.branch:
        args += ["--branch", ctx.repo.branch]
    args += [auth_url, str(cache)]
    _git(args, cwd=None, env=ctx.env)
    return cache


def _hard_reset_to_remote(cache: Path, env: dict[str, str], branch: str | None) -> None:
    """Force the local working tree to match ``origin/<branch>``."""
    if branch:
        ref = f"origin/{branch}"
    else:
        # Discover origin's HEAD ref so we don't assume ``main``.
        out = _git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd=cache, env=env).strip()
        ref = out.split("refs/remotes/", 1)[-1] if out else "origin/HEAD"
    _git(["reset", "--hard", ref], cwd=cache, env=env)
    _git(["clean", "-fdx"], cwd=cache, env=env)


# ---------------------------------------------------------------------------
# Materialise cache → .cursor/skills/<name>/
# ---------------------------------------------------------------------------


def _install_into_workspace(ctx: _SyncContext, cache: Path) -> list[str]:
    """Copy skill bundle(s) from the cache into ``.cursor/skills``."""
    target_root = ctx.workspace / _CURSOR_SKILLS
    target_root.mkdir(parents=True, exist_ok=True)

    if ctx.repo.kind == "single":
        return [_install_single(ctx, cache, target_root)]
    return _install_multi(ctx, cache, target_root)


def _install_single(ctx: _SyncContext, cache: Path, target_root: Path) -> str:
    """Single-bundle layout: clone root *is* the skill folder."""
    name = _resolve_single_target_name(ctx)
    src = cache
    if not (src / "SKILL.md").is_file():
        raise GitSyncError(
            "Repository root does not contain SKILL.md (single-bundle mode requires it)."
        )
    dest = target_root / name
    _replace_dir(src, dest, exclude={".git"})
    return name


def _install_multi(ctx: _SyncContext, cache: Path, target_root: Path) -> list[str]:
    """Multi-bundle layout: each subdirectory containing SKILL.md is a skill."""
    base = cache
    if ctx.repo.target:
        base = cache / _validate_subpath(ctx.repo.target)
        if not base.is_dir():
            raise GitSyncError(f"Subpath '{ctx.repo.target}' not found in repository.")

    installed: list[str] = []
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        if not (child / "SKILL.md").is_file():
            continue
        name = child.name
        if not _SKILL_NAME_RE.fullmatch(name):
            logger.warning("[skills-git] skipping invalid skill name: {}", name)
            continue
        dest = target_root / name
        _replace_dir(child, dest, exclude={".git"})
        installed.append(name)
    if not installed:
        raise GitSyncError(
            "No skill bundles found (each subdirectory must contain SKILL.md)."
        )
    return installed


def _resolve_single_target_name(ctx: _SyncContext) -> str:
    """Pick the destination folder name for a single-bundle repo."""
    if ctx.repo.target:
        name = ctx.repo.target.strip().strip("/").strip("\\")
    else:
        # Derive from the URL (strip trailing ``.git``).
        tail = ctx.repo.url.rstrip("/").rsplit("/", 1)[-1]
        if tail.endswith(".git"):
            tail = tail[:-4]
        name = tail or ctx.repo.name
    if not _SKILL_NAME_RE.fullmatch(name):
        raise GitSyncError(
            f"Resolved skill folder name '{name}' is not a valid identifier; "
            "set 'target' in the repo config to override."
        )
    return name


def _validate_subpath(raw: str) -> str:
    """Normalize and reject traversal in ``target`` paths."""
    parts = [p for p in re.split(r"[\\/]+", raw.strip()) if p]
    if any(p in ("", ".", "..") for p in parts):
        raise GitSyncError(f"Invalid subpath: '{raw}'")
    return "/".join(parts)


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def _replace_dir(src: Path, dest: Path, *, exclude: set[str]) -> None:
    """Atomically swap ``dest`` with the contents of ``src``."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        _rmtree_quiet(dest)
    shutil.copytree(
        src,
        dest,
        ignore=shutil.ignore_patterns(*exclude),
        dirs_exist_ok=False,
    )


def _rmtree_quiet(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except OSError as exc:
        # On Windows, read-only files inside ``.git`` block ``rmtree``; retry
        # after relaxing perms.
        logger.debug("[skills-git] rmtree retry on {}: {}", path, exc)
        try:
            for root, dirs, files in os.walk(path):
                for d in dirs:
                    os.chmod(os.path.join(root, d), 0o700)
                for f in files:
                    os.chmod(os.path.join(root, f), 0o600)
            shutil.rmtree(path)
        except OSError:
            logger.exception("[skills-git] rmtree failed for {}", path)
            raise


def _redact_secrets(message: str) -> str:
    """Strip ``user:token@`` from any URL leaked into git error output."""
    return re.sub(r"://[^/@\s]+:[^/@\s]+@", "://***@", message)


# ---------------------------------------------------------------------------
# Convenience for the scheduler
# ---------------------------------------------------------------------------


def iter_due_repos(
    repos: Iterable[SkillsGitRepo], now_epoch: float
) -> list[SkillsGitRepo]:
    """Return the subset of repos whose ``auto_update`` window has elapsed."""
    from datetime import datetime

    out: list[SkillsGitRepo] = []
    for repo in repos:
        if not repo.auto_update:
            continue
        if not repo.last_sync_at:
            out.append(repo)
            continue
        try:
            last = datetime.fromisoformat(repo.last_sync_at).timestamp()
        except ValueError:
            out.append(repo)
            continue
        if now_epoch - last >= repo.interval_minutes * 60:
            out.append(repo)
    return out

