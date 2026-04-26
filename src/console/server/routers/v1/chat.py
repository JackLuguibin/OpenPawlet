"""Chat completion (stub).

This endpoint is intentionally a **stub**. Real chat flows go through the
nanobot gateway over WebSocket (see ``/nanobot-ws/*`` on the console and the
frontend `NanobotWebsocketClient`); the HTTP route is only kept so generated
clients continue to compile. It is marked ``deprecated`` in the OpenAPI
schema so SDK users are steered toward the WebSocket channel.
"""

from __future__ import annotations

from fastapi import APIRouter, status

from console.server.models import ChatRequest, ChatResponse, DataResponse

router = APIRouter(tags=["Chat"])


@router.post(
    "/chat",
    response_model=DataResponse[ChatResponse],
    status_code=status.HTTP_200_OK,
    deprecated=True,
    summary="Chat completion (stub; prefer the WebSocket channel)",
)
async def chat(body: ChatRequest) -> DataResponse[ChatResponse]:
    """Return an empty chat response.

    **Not implemented on the HTTP path.** The real chat pipeline is driven by
    the nanobot gateway WebSocket; this route exists only for schema
    compatibility and always returns an empty ``message``.
    """
    sk = body.session_key or "stub-session"
    return DataResponse(data=ChatResponse(session_key=sk, message="", done=True))
