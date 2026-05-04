"""Persistence tests for :class:`openpawlet.cron.service.CronService`.

Covers corrupt / partially written ``jobs.json`` no longer being replaced by an
empty job list on start, and atomic writes for the store file.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from openpawlet.cron.service import CronService
from openpawlet.cron.types import CronSchedule


def _seeded_store(tmp_path: Path) -> tuple[CronService, Path]:
    """One persisted job on disk via action log merge, mirroring production-style state."""
    store_path = tmp_path / "cron" / "jobs.json"
    service = CronService(store_path)
    service.add_job(
        name="Daily Loving Message",
        schedule=CronSchedule(kind="cron", expr="0 10 * * *", tz="Asia/Kuwait"),
        message="hello",
    )
    service._running = True
    try:
        service._load_store()
    finally:
        service._running = False
    assert store_path.exists()
    return service, store_path


def test_save_store_is_atomic(tmp_path: Path) -> None:
    service, store_path = _seeded_store(tmp_path)

    service._save_store()
    data = json.loads(store_path.read_text(encoding="utf-8"))
    assert len(data["jobs"]) == 1

    tmp_files = list(store_path.parent.glob("*.tmp"))
    assert tmp_files == [], f"unexpected temp files left behind: {tmp_files}"


def test_save_store_failure_does_not_corrupt_existing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, store_path = _seeded_store(tmp_path)
    original = store_path.read_bytes()

    real_open = open

    def boom(path, *args, **kwargs):  # type: ignore[no-untyped-def]
        if str(path).endswith(".tmp"):
            raise OSError("simulated disk full")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr("builtins.open", boom)

    with pytest.raises(OSError, match="simulated disk full"):
        service._save_store()

    assert store_path.read_bytes() == original


def test_load_jobs_preserves_corrupt_store_and_returns_none(
    tmp_path: Path,
) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text("{not valid json", encoding="utf-8")

    service = CronService(store_path)
    assert service._load_jobs() is None

    assert not store_path.exists()
    backups = list(store_path.parent.glob("jobs.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "{not valid json"


def test_start_refuses_to_overwrite_corrupt_store(tmp_path: Path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"
    store_path.parent.mkdir(parents=True)
    store_path.write_text("{still not json", encoding="utf-8")

    service = CronService(store_path)

    with pytest.raises(RuntimeError, match="corrupt"):
        asyncio.run(service.start())

    assert service._running is False

    backups = list(store_path.parent.glob("jobs.json.corrupt-*"))
    assert len(backups) == 1


def test_load_store_falls_back_to_in_memory_on_corruption_after_start(
    tmp_path: Path,
) -> None:
    service, store_path = _seeded_store(tmp_path)
    service._load_store()
    snapshot = service._store
    assert snapshot is not None and len(snapshot.jobs) == 1

    store_path.write_text("\x00garbage\x00", encoding="utf-8")

    result = service._load_store()
    assert result is snapshot
    assert len(result.jobs) == 1
    assert result.jobs[0].name == "Daily Loving Message"


def test_full_round_trip_survives_repeated_save_load(tmp_path: Path) -> None:
    store_path = tmp_path / "cron" / "jobs.json"

    s1 = CronService(store_path)
    s1.add_job(
        name="Daily Loving Message",
        schedule=CronSchedule(kind="cron", expr="0 10 * * *", tz="Asia/Kuwait"),
        message="hello",
    )

    s2 = CronService(store_path)
    s2._load_store()
    assert s2._store is not None
    assert [j.name for j in s2._store.jobs] == ["Daily Loving Message"]
