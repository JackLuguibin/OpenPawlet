"""Usage history models (aligned with web ``types.ts``)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class UsageHistoryItem(BaseModel):
    """Daily usage row."""

    model_config = ConfigDict(extra="forbid")

    date: str
    total_tokens: int
    prompt_tokens: int
    completion_tokens: int
    by_model: dict[str, dict[str, int | None]] | None = None
    cost_usd: float | None = None
    cost_by_model: dict[str, float] | None = None
