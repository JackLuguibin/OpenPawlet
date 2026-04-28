"""Integration tests for the console ``/cron`` API.

The router talks to a real ``nanobot.cron.service.CronService`` (either the
embedded runtime's instance or a transient one bound to the workspace
``cron/jobs.json``). These tests construct a transient service, write a job
with the web client's metadata-encoded ``message`` block, then drive the
HTTP endpoints to verify end-to-end behaviour: list / status / history.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.config import ServerSettings
from console.server.cron_helpers import decode_cron_message
from nanobot.cron.service import CronService
from nanobot.cron.types import CronSchedule

META_PROMPT = (
    '<!--cron-meta:{"agentId":"agent-42","skills":["search"],'
    '"mcpServers":["fs"],"tools":["web_search"],'
    '"startAtMs":1700000000000,"endAtMs":1800000000000}-->\n'
    "Daily summary please."
)


def _make_client(tmp_path: Path) -> TestClient:
    """Build a TestClient pointed at a workspace under ``tmp_path``.

    Idempotent: safe to invoke alongside ``_seed_job`` which may create the
    workspace earlier.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    config_path = tmp_path / "config.json"
    if not config_path.exists():
        config_path.write_text(
            json.dumps(
                {
                    "agents": {"defaults": {"workspace": str(workspace)}},
                }
            ),
            encoding="utf-8",
        )

    from nanobot.config.loader import set_config_path

    set_config_path(config_path)

    settings = ServerSettings()
    app = create_app(settings)
    # Skip the embedded runtime so the helpers fall back to disk-bound services.
    app.state.embedded = None
    client = TestClient(app)
    return client


def _seed_workspace(tmp_path: Path) -> Path:
    """Ensure the workspace + config files exist (used by seeders)."""
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    config_path = tmp_path / "config.json"
    if not config_path.exists():
        config_path.write_text(
            json.dumps(
                {
                    "agents": {"defaults": {"workspace": str(workspace)}},
                }
            ),
            encoding="utf-8",
        )
    return workspace


def _seed_job(tmp_path: Path) -> str:
    """Seed a job with metadata + one execution into ``cron/jobs.json``."""
    workspace = _seed_workspace(tmp_path)
    store = workspace / "cron" / "jobs.json"
    svc = CronService(store)
    job = svc.add_job(
        name="Daily Summary",
        schedule=CronSchedule(kind="every", every_ms=60_000),
        message=META_PROMPT,
    )

    async def _runner() -> None:
        await svc.run_job(job.id, force=True)

    asyncio.run(_runner())
    return job.id


def test_decode_cron_message_extracts_metadata() -> None:
    meta = decode_cron_message(META_PROMPT)
    assert meta.agent_id == "agent-42"
    assert meta.skills == ("search",)
    assert meta.mcp_servers == ("fs",)
    assert meta.tools == ("web_search",)
    assert meta.start_at_ms == 1700000000000
    assert meta.end_at_ms == 1800000000000
    assert meta.prompt == "Daily summary please."


def test_decode_cron_message_handles_plain_text() -> None:
    meta = decode_cron_message("just a prompt")
    assert meta.agent_id is None
    assert meta.skills == ()
    assert meta.prompt == "just a prompt"


def test_list_cron_jobs_returns_seeded_job(tmp_path: Path) -> None:
    job_id = _seed_job(tmp_path)
    client = _make_client(tmp_path)
    resp = client.get("/api/v1/cron")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    rows = body["data"]
    assert any(r["id"] == job_id for r in rows)
    job_row = next(r for r in rows if r["id"] == job_id)
    assert job_row["name"] == "Daily Summary"
    assert job_row["schedule"]["kind"] == "every"
    # Metadata block should still be in payload.message verbatim.
    assert job_row["payload"]["message"].startswith("<!--cron-meta:")


def test_cron_history_includes_decoded_metadata(tmp_path: Path) -> None:
    job_id = _seed_job(tmp_path)
    client = _make_client(tmp_path)
    resp = client.get(f"/api/v1/cron/history?job_id={job_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    history_map = body["data"]
    assert job_id in history_map
    runs = history_map[job_id]
    assert len(runs) >= 1
    last = runs[-1]
    assert last["job_id"] == job_id
    assert last["job_name"] == "Daily Summary"
    assert last["agent_id"] == "agent-42"
    assert last["skills"] == ["search"]
    assert last["tools"] == ["web_search"]
    assert last["mcp_servers"] == ["fs"]
    assert last["prompt"] == "Daily summary please."
    assert last["status"] == "ok"


def test_cron_history_unknown_job_returns_404(tmp_path: Path) -> None:
    _make_client(tmp_path)  # ensures workspace exists
    client = _make_client(tmp_path)
    resp = client.get("/api/v1/cron/history?job_id=does-not-exist")
    assert resp.status_code == 404


def test_cron_status_reports_disk_jobs(tmp_path: Path) -> None:
    _seed_job(tmp_path)
    client = _make_client(tmp_path)
    resp = client.get("/api/v1/cron/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    status = body["data"]
    # Embedded runtime is disabled in this fixture, so ``enabled`` is False
    # but the job count must reflect what's persisted on disk.
    assert status["jobs"] >= 1


def test_add_cron_job_round_trips(tmp_path: Path) -> None:
    """POST /cron returns the job; subsequent GET /cron must contain it.

    The fallback service path is not running so the new job lands in
    ``cron/action.jsonl`` first. A subsequent ``list_jobs`` call (whether
    in-process or via the API) must merge the action queue and surface it
    back to the caller; that's what the SPA relies on.
    """
    _make_client(tmp_path)  # initialise workspace
    client = _make_client(tmp_path)

    payload = {
        "name": "Hourly Sync",
        "schedule": {"kind": "every", "every_ms": 3600000},
        "message": "Run sync",
    }
    resp = client.post("/api/v1/cron", json=payload)
    assert resp.status_code == 200, resp.text
    job = resp.json()["data"]
    assert job["name"] == "Hourly Sync"
    assert job["schedule"]["every_ms"] == 3600000

    listed = client.get("/api/v1/cron").json()["data"]
    assert any(j["id"] == job["id"] and j["name"] == "Hourly Sync" for j in listed)

    # The action queue file is the durable record before run/start kicks in.
    action_path = tmp_path / "workspace" / "cron" / "action.jsonl"
    assert action_path.exists()
    contents = action_path.read_text(encoding="utf-8")
    assert "Hourly Sync" in contents


@pytest.mark.parametrize(
    "schedule",
    [
        {"kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai"},
        {"kind": "every", "every_ms": 60_000},
    ],
)
def test_add_cron_job_supports_schedule_kinds(tmp_path: Path, schedule: dict) -> None:
    _make_client(tmp_path)
    client = _make_client(tmp_path)
    resp = client.post(
        "/api/v1/cron",
        json={"name": "S", "schedule": schedule, "message": "x"},
    )
    assert resp.status_code == 200, resp.text


def test_remove_cron_job_returns_404_for_missing(tmp_path: Path) -> None:
    _make_client(tmp_path)
    client = _make_client(tmp_path)
    resp = client.delete("/api/v1/cron/missing-id")
    assert resp.status_code == 404
