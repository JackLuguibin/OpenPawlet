"""HTTP surface for ``skillsGit`` repositories.

Exposes CRUD over the ``skillsGit.repos`` array stored at the top of
``config.json`` plus a manual-sync endpoint that reuses the same engine
as the background scheduler.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Query
from pydantic import ValidationError

from console.server.bot_workspace import workspace_root
from console.server.http_errors import bad_request, not_found
from console.server.models import (
    DataResponse,
    OkWithName,
    SkillsGitRepo,
    SkillsGitRepoUpsertBody,
    SkillsGitSyncResult,
)
from console.server.openpawlet_user_config import (
    load_raw_config,
    resolve_config_path,
    save_full_config,
)
from console.server.skills_git_sync import GitSyncError, sync_repo

router = APIRouter(tags=["SkillsGit"])

_CONFIG_KEY = "skillsGit"


# ---------------------------------------------------------------------------
# Persistence helpers (operate directly on raw config dict, like skills.py)
# ---------------------------------------------------------------------------


def _load_repos(bot_id: str | None) -> list[SkillsGitRepo]:
    """Return the configured repos, normalising legacy / partial entries."""
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    block = raw.get(_CONFIG_KEY)
    if not isinstance(block, dict):
        return []
    repos_raw = block.get("repos")
    if not isinstance(repos_raw, list):
        return []
    out: list[SkillsGitRepo] = []
    for item in repos_raw:
        if not isinstance(item, dict):
            continue
        try:
            out.append(SkillsGitRepo.model_validate(item))
        except ValidationError as exc:
            # Skip malformed rows but keep the server up; the user can fix
            # them via the UI by re-saving.
            from loguru import logger

            logger.warning("[skills-git] dropping invalid repo entry: {}", exc)
            continue
    return out


def _save_repos(bot_id: str | None, repos: list[SkillsGitRepo]) -> None:
    """Persist ``repos`` back to ``config.json`` under ``skillsGit.repos``."""
    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    block = raw.get(_CONFIG_KEY) if isinstance(raw.get(_CONFIG_KEY), dict) else {}
    block["repos"] = [r.model_dump(mode="json") for r in repos]
    merged: dict[str, Any] = {**raw, _CONFIG_KEY: block}
    save_full_config(path, merged)


def _find_repo(repos: list[SkillsGitRepo], repo_id: str) -> SkillsGitRepo:
    for r in repos:
        if r.id == repo_id:
            return r
    not_found("Skills git repo")


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="seconds")


def _validate_url(url: str) -> str:
    """Lightweight URL validation; the engine itself rejects unsupported schemes."""
    candidate = url.strip()
    if not candidate:
        bad_request("Repository URL is required")
    cand_lower = candidate.lower()
    if not (
        cand_lower.startswith(("https://", "http://", "ssh://"))
        or candidate.startswith("git@")
    ):
        bad_request(
            "URL must start with https://, http://, ssh:// or git@host:path/repo",
        )
    return candidate


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get("/skills/git", response_model=DataResponse[list[SkillsGitRepo]])
async def list_git_repos(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[SkillsGitRepo]]:
    """List configured skills-git repos."""
    return DataResponse(data=_load_repos(bot_id))


@router.post("/skills/git", response_model=DataResponse[SkillsGitRepo])
async def create_git_repo(
    body: SkillsGitRepoUpsertBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[SkillsGitRepo]:
    """Add a new git source for skills."""
    url = _validate_url(body.url)
    repos = _load_repos(bot_id)
    new_repo = SkillsGitRepo(
        id=uuid.uuid4().hex[:16],
        name=body.name.strip() or url,
        url=url,
        branch=(body.branch or None),
        kind=body.kind,
        target=(body.target or None),
        auth=body.auth,
        auto_update=body.auto_update,
        interval_minutes=body.interval_minutes,
    )
    repos.append(new_repo)
    _save_repos(bot_id, repos)
    return DataResponse(data=new_repo)


@router.put("/skills/git/{repo_id}", response_model=DataResponse[SkillsGitRepo])
async def update_git_repo(
    repo_id: str,
    body: SkillsGitRepoUpsertBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[SkillsGitRepo]:
    """Replace settings for an existing repo (telemetry fields are preserved)."""
    url = _validate_url(body.url)
    repos = _load_repos(bot_id)
    target = _find_repo(repos, repo_id)
    updated = target.model_copy(
        update={
            "name": body.name.strip() or url,
            "url": url,
            "branch": (body.branch or None),
            "kind": body.kind,
            "target": (body.target or None),
            "auth": body.auth,
            "auto_update": body.auto_update,
            "interval_minutes": body.interval_minutes,
        }
    )
    repos = [updated if r.id == repo_id else r for r in repos]
    _save_repos(bot_id, repos)
    return DataResponse(data=updated)


@router.delete("/skills/git/{repo_id}", response_model=DataResponse[OkWithName])
async def delete_git_repo(
    repo_id: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithName]:
    """Remove a configured repo (does NOT delete already-synced skill files)."""
    repos = _load_repos(bot_id)
    target = _find_repo(repos, repo_id)
    _save_repos(bot_id, [r for r in repos if r.id != repo_id])
    return DataResponse(data=OkWithName(name=target.name))


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def _persist_sync_result(
    bot_id: str | None, repo_id: str, result: SkillsGitSyncResult
) -> None:
    """Write the new ``last_sync_*`` fields back to config.json."""
    repos = _load_repos(bot_id)
    updated: list[SkillsGitRepo] = []
    for r in repos:
        if r.id != repo_id:
            updated.append(r)
            continue
        updated.append(
            r.model_copy(
                update={
                    "last_sync_at": _now_iso(),
                    "last_sync_status": result.status,
                    "last_sync_message": result.message,
                    "last_commit_sha": result.commit_sha or r.last_commit_sha,
                }
            )
        )
    _save_repos(bot_id, updated)


async def _run_sync(
    repo: SkillsGitRepo, bot_id: str | None
) -> SkillsGitSyncResult:
    """Execute the (blocking) sync engine on a worker thread."""
    try:
        return await asyncio.to_thread(sync_repo, repo, bot_id)
    except GitSyncError as exc:
        # ``sync_repo`` already wraps GitSyncError into a result, but defend
        # against future regressions.
        return SkillsGitSyncResult(
            id=repo.id,
            name=repo.name,
            status="error",
            message=str(exc),
        )


@router.post(
    "/skills/git/{repo_id}/sync",
    response_model=DataResponse[SkillsGitSyncResult],
)
async def sync_git_repo(
    repo_id: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[SkillsGitSyncResult]:
    """Pull updates for one repo and refresh ``.cursor/skills/<name>/`` on disk."""
    repos = _load_repos(bot_id)
    repo = _find_repo(repos, repo_id)
    # Sanity: workspace must resolve before we even try git.
    _ = workspace_root(bot_id)
    result = await _run_sync(repo, bot_id)
    _persist_sync_result(bot_id, repo_id, result)
    if result.status == "error":
        # Return 200 with the error in the body so the UI can show it inline,
        # matching how /skills handles per-row failures.
        pass
    return DataResponse(data=result)


@router.post(
    "/skills/git/sync-all",
    response_model=DataResponse[list[SkillsGitSyncResult]],
)
async def sync_all_git_repos(
    background_tasks: BackgroundTasks,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[SkillsGitSyncResult]]:
    """Sync every configured repo in parallel (capped to keep CPU/IO sane)."""
    _ = background_tasks  # reserved for future async-only mode
    repos = _load_repos(bot_id)
    if not repos:
        return DataResponse(data=[])
    sem = asyncio.Semaphore(3)

    async def one(r: SkillsGitRepo) -> SkillsGitSyncResult:
        async with sem:
            res = await _run_sync(r, bot_id)
            _persist_sync_result(bot_id, r.id, res)
            return res

    results = await asyncio.gather(*(one(r) for r in repos))
    return DataResponse(data=list(results))
