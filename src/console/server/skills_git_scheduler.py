"""Background scheduler that polls configured Skills git repos.

Lives entirely in the console process (not the embedded nanobot runtime)
so it stays available even when the runtime is in degraded mode.  We use
a single lightweight ``asyncio`` loop that wakes every minute, checks
which repos are due, and fans them out through the same engine the HTTP
``/sync`` route uses.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from loguru import logger

from console.server.routers.v1 import skills_git as skills_git_router
from console.server.skills_git_sync import iter_due_repos, sync_repo

# How often the loop wakes up to re-evaluate due repos.  One minute keeps
# CPU usage trivial while still honouring per-repo intervals down to the
# 5-minute floor enforced by the model.
_TICK_SECONDS = 60


class SkillsGitScheduler:
    """Owns the background asyncio task and exposes start/stop hooks."""

    def __init__(self, bot_id_provider):
        # Lazily resolve the active bot id on each tick: it can change when
        # ``swap_runtime`` swaps in a different bot config.
        self._bot_id_provider = bot_id_provider
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        """Start the loop if it isn't already running."""
        if self._task is not None and not self._task.done():
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="skills-git-scheduler")
        logger.info("[skills-git] scheduler started (tick={}s)", _TICK_SECONDS)

    async def stop(self) -> None:
        """Signal the loop to exit and await teardown."""
        self._stop.set()
        task = self._task
        if task is None:
            return
        try:
            await asyncio.wait_for(task, timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
        finally:
            self._task = None
            logger.info("[skills-git] scheduler stopped")

    async def _run(self) -> None:
        """Main loop: wake, scan, dispatch due syncs, sleep."""
        while not self._stop.is_set():
            try:
                await self._tick_once()
            except Exception:  # noqa: BLE001 - keep the loop alive
                logger.exception("[skills-git] scheduler tick failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_TICK_SECONDS)
            except asyncio.TimeoutError:
                continue

    async def _tick_once(self) -> None:
        """Sync any repos whose interval has elapsed."""
        bot_id = self._bot_id_provider()
        repos = skills_git_router._load_repos(bot_id)
        if not repos:
            return
        due = iter_due_repos(repos, time.time())
        if not due:
            return
        logger.info("[skills-git] auto-sync due for {} repo(s)", len(due))
        # Sequential within a tick keeps the load predictable and avoids
        # holding multiple cache directories in copy-tree at the same time.
        for repo in due:
            try:
                result = await asyncio.to_thread(sync_repo, repo, bot_id)
            except Exception:  # noqa: BLE001 - one repo cannot kill the others
                logger.exception("[skills-git] auto-sync raised for {}", repo.url)
                continue
            try:
                skills_git_router._persist_sync_result(bot_id, repo.id, result)
            except Exception:  # noqa: BLE001 - persistence error is non-fatal
                logger.exception(
                    "[skills-git] failed to persist sync result for {}", repo.url
                )


def attach_to_app(app: Any) -> SkillsGitScheduler:
    """Create and stash a scheduler on ``app.state.skills_git_scheduler``."""

    def provider() -> str | None:
        return getattr(app.state, "active_bot_id", None)

    sched = SkillsGitScheduler(provider)
    app.state.skills_git_scheduler = sched
    return sched
