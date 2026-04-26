"""Concurrency tests for ``console.server.state_store.json_state``.

The state store guarantees that concurrent coroutines observe a strict
load -> mutate -> save cycle even when multiple awaiters race the same
file path; if the asyncio lock or filelock were missing two writers
would clobber each other.  These tests pin the contract.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from console.server.state_store import json_state  # noqa: E402


@pytest.mark.asyncio
async def test_json_state_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "state.json"
    async with json_state(target, default={}) as data:
        data["count"] = 1
    async with json_state(target, default={}) as data:
        assert data["count"] == 1


@pytest.mark.asyncio
async def test_concurrent_increments_do_not_lose_updates(tmp_path: Path) -> None:
    target = tmp_path / "counter.json"

    async def bump() -> None:
        async with json_state(target, default={"n": 0}) as data:
            data["n"] = int(data.get("n", 0)) + 1

    await asyncio.gather(*(bump() for _ in range(50)))
    final = json.loads(target.read_text(encoding="utf-8"))
    assert final["n"] == 50


@pytest.mark.asyncio
async def test_exception_does_not_persist_partial_state(tmp_path: Path) -> None:
    target = tmp_path / "state.json"
    async with json_state(target, default={"v": "initial"}) as data:
        data["v"] = "committed"

    with pytest.raises(RuntimeError):
        async with json_state(target, default={}) as data:
            data["v"] = "would-be-rolled-back"
            raise RuntimeError("boom")

    final = json.loads(target.read_text(encoding="utf-8"))
    assert final["v"] == "committed"
