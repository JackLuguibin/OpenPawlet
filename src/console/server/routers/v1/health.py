"""Health-check and test endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status

from console.server.config import ServerSettings
from console.server.dependencies import get_settings_dep
from console.server.models import (
    DataResponse,
    EchoRequest,
    EchoResponse,
    HealthResponse,
)

router = APIRouter(tags=["Health"])


@router.get(
    "/health",
    response_model=DataResponse[HealthResponse],
    status_code=status.HTTP_200_OK,
    summary="Liveness probe",
)
async def health_check(
    settings: Annotated[ServerSettings, Depends(get_settings_dep)],
) -> DataResponse[HealthResponse]:
    """Return server health status.

    Ready for integration with orchestration systems (Kubernetes, etc.).
    """
    return DataResponse(
        data=HealthResponse(version=settings.version),
    )


@router.post(
    "/echo",
    response_model=EchoResponse,
    status_code=status.HTTP_200_OK,
    summary="Echo test",
)
async def echo(body: EchoRequest) -> EchoResponse:
    """Mirror the received payload back to the client.

    Useful for smoke-testing the API and validating request/response serialization.
    """
    return EchoResponse(
        content=body.content,
        metadata=body.metadata,
    )
