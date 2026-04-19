"""Chat completion (stub)."""

from __future__ import annotations

from fastapi import APIRouter, status

from console.server.models import ChatRequest, ChatResponse, DataResponse

router = APIRouter(tags=["Chat"])


@router.post(
    "/chat",
    response_model=DataResponse[ChatResponse],
    status_code=status.HTTP_200_OK,
)
async def chat(body: ChatRequest) -> DataResponse[ChatResponse]:
    """Send chat message (stub)."""
    sk = body.session_key or "stub-session"
    return DataResponse(
        data=ChatResponse(session_key=sk, message="", done=True)
    )
