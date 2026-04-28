"""Environment variables API models.

The ``exec_visible_keys`` field mirrors the subset of variables the user
has opted in to forward to the ``exec`` tool's sandboxed subprocesses
(``tools.exec.allowedEnvKeys``).  Keeping it on the same payload as the
raw values avoids a separate round trip when the SPA renders the env
table with the per-row "allow exec" toggle.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class EnvResponse(BaseModel):
    """GET /env payload."""

    model_config = ConfigDict(extra="forbid")

    vars: dict[str, str]
    exec_visible_keys: list[str] = Field(default_factory=list)


class EnvPutBody(BaseModel):
    """PUT /env body."""

    model_config = ConfigDict(extra="forbid")

    vars: dict[str, str]
    # Subset of ``vars`` the user wants forwarded to the exec tool.
    # Unknown / extra keys are ignored server-side; ``None`` keeps the
    # current allowlist untouched (legacy clients).
    exec_visible_keys: list[str] | None = None


class EnvPutResponse(BaseModel):
    """PUT /env response (optional vars echo)."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    vars: dict[str, str] | None = None
    exec_visible_keys: list[str] = Field(default_factory=list)
