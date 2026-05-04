"""Tests for exec tool internal URL blocking."""

from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

from openpawlet.agent.tools.errors import AgentToolAbort
from openpawlet.agent.tools.shell import ExecTool


def _fake_resolve_private(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 0))]


def _fake_resolve_localhost(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]


def _fake_resolve_public(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]


@pytest.mark.asyncio
async def test_exec_blocks_curl_metadata():
    tool = ExecTool()
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_private):
        with pytest.raises(AgentToolAbort, match="internal|private|safety"):
            await tool.execute(
                command=(
                    'curl -s -H "Metadata-Flavor: Google" '
                    "http://169.254.169.254/computeMetadata/v1/"
                )
            )


@pytest.mark.asyncio
async def test_exec_blocks_wget_localhost():
    tool = ExecTool()
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_localhost):
        with pytest.raises(AgentToolAbort):
            await tool.execute(command="wget http://localhost:8080/secret -O /tmp/out")


@pytest.mark.asyncio
async def test_exec_allows_normal_commands():
    tool = ExecTool(timeout=5)
    result = await tool.execute(command="echo hello")
    assert "hello" in result
    assert "Error" not in result.split("\n")[0]


@pytest.mark.asyncio
async def test_exec_allows_curl_to_public_url():
    """Commands with public URLs should not be blocked by the internal URL check."""
    tool = ExecTool()
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_public):
        tool._guard_command("curl https://example.com/api", "/tmp")


@pytest.mark.asyncio
async def test_exec_blocks_chained_internal_url():
    """Internal URLs buried in chained commands should still be caught."""
    tool = ExecTool()
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_private):
        with pytest.raises(AgentToolAbort):
            await tool.execute(
                command="echo start && curl http://169.254.169.254/latest/meta-data/ && echo done"
            )


# --- #2989: block writes to OpenPawlet internal state files -----------------


@pytest.mark.parametrize(
    "command",
    [
        "cat foo >> history.jsonl",
        "echo '{}' > history.jsonl",
        "echo '{}' > memory/history.jsonl",
        "echo '{}' > ./workspace/memory/history.jsonl",
        "tee -a history.jsonl < foo",
        "tee history.jsonl",
        "cp /tmp/fake.jsonl history.jsonl",
        "mv backup.jsonl memory/history.jsonl",
        "dd if=/dev/zero of=memory/history.jsonl",
        "sed -i 's/old/new/' history.jsonl",
        "echo x > .dream_cursor",
        "cp /tmp/x memory/.dream_cursor",
    ],
)
def test_exec_blocks_writes_to_history_jsonl(command):
    """Direct writes to history.jsonl / .dream_cursor must be blocked (#2989)."""
    tool = ExecTool()
    with pytest.raises(AgentToolAbort, match="dangerous pattern"):
        tool._guard_command(command, "/tmp")


@pytest.mark.parametrize(
    "command",
    [
        "cat history.jsonl",
        "wc -l history.jsonl",
        "tail -n 5 history.jsonl",
        "grep foo history.jsonl",
        "cp history.jsonl /tmp/history.backup",
        "ls memory/",
        "echo history.jsonl",
    ],
)
def test_exec_allows_reads_of_history_jsonl(command):
    """Read-only access to history.jsonl must still be allowed."""
    tool = ExecTool()
    tool._guard_command(command, "/tmp")


def test_exec_allow_patterns_override_builtin_deny():
    """Configured allow_patterns must bypass default deny_patterns (e.g. CI rm -rf)."""
    blocked = ExecTool()
    with pytest.raises(AgentToolAbort, match="dangerous pattern"):
        blocked._guard_command("rm -rf ./build/tmp", "/tmp")

    exempt = ExecTool(allow_patterns=[r"rm\s+-rf\s+\./build/"])
    exempt._guard_command("rm -rf ./build/tmp", "/tmp")


def test_exec_allow_patterns_does_not_bypass_internal_url_check():
    """Explicit allow must not skip SSRF / internal URL guard."""
    tool = ExecTool(allow_patterns=[r"curl.*169\.254"])
    with patch("openpawlet.security.network.socket.getaddrinfo", _fake_resolve_private):
        with pytest.raises(AgentToolAbort, match="internal|private|safety"):
            tool._guard_command(
                'curl -s http://169.254.169.254/latest/meta-data/',
                "/tmp",
            )


# --- #2826: working_dir must not escape the configured workspace ---------


@pytest.mark.asyncio
async def test_exec_blocks_working_dir_outside_workspace(tmp_path):
    """An LLM-supplied working_dir outside the workspace must be rejected."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    tool = ExecTool(working_dir=str(workspace), restrict_to_workspace=True)
    with pytest.raises(AgentToolAbort, match="outside the configured workspace"):
        await tool.execute(command="rm calendar.ics", working_dir="/etc")


@pytest.mark.asyncio
async def test_exec_blocks_absolute_rm_via_hijacked_working_dir(tmp_path):
    """Regression for #2826: `rm /abs/path` via working_dir hijack."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    victim_dir = tmp_path / "outside"
    victim_dir.mkdir()
    victim = victim_dir / "file.ics"
    victim.write_text("data")

    tool = ExecTool(working_dir=str(workspace), restrict_to_workspace=True)
    with pytest.raises(AgentToolAbort, match="outside the configured workspace"):
        await tool.execute(
            command=f"rm {victim}",
            working_dir=str(victim_dir),
        )
    assert victim.exists(), "victim file must not have been deleted"


@pytest.mark.asyncio
async def test_exec_allows_working_dir_within_workspace(tmp_path):
    """A working_dir that is a subdirectory of the workspace is fine."""
    workspace = tmp_path / "workspace"
    subdir = workspace / "project"
    subdir.mkdir(parents=True)
    tool = ExecTool(working_dir=str(workspace), restrict_to_workspace=True, timeout=5)
    result = await tool.execute(command="echo ok", working_dir=str(subdir))
    assert "ok" in result
    assert "outside the configured workspace" not in result


@pytest.mark.asyncio
async def test_exec_allows_working_dir_equal_to_workspace(tmp_path):
    """Passing working_dir equal to the workspace root must be allowed."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    tool = ExecTool(working_dir=str(workspace), restrict_to_workspace=True, timeout=5)
    result = await tool.execute(command="echo ok", working_dir=str(workspace))
    assert "ok" in result
    assert "outside the configured workspace" not in result


@pytest.mark.asyncio
async def test_exec_ignores_workspace_check_when_not_restricted(tmp_path):
    """Without restrict_to_workspace, the LLM may still choose any working_dir."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    tool = ExecTool(working_dir=str(workspace), restrict_to_workspace=False, timeout=5)
    result = await tool.execute(command="echo ok", working_dir=str(other))
    assert "ok" in result
    assert "outside the configured workspace" not in result
