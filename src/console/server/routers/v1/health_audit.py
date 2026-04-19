"""Extended health audit (stub)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import DataResponse, HealthAuditResponse

router = APIRouter(tags=["HealthAudit"])


@router.get("/health/audit", response_model=DataResponse[HealthAuditResponse])
async def health_audit(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[HealthAuditResponse]:
    """Structured health audit (stub)."""
    _ = bot_id
    return DataResponse(data=HealthAuditResponse(issues=[]))
