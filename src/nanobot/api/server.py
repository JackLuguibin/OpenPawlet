"""Compatibility shim - this module moved to ``console.server.openai_api``.

The OpenAI-compatible API is now hosted by the unified console FastAPI
process.  This shim re-exports the relocated symbols (including private
helpers) so any external caller importing ``nanobot.api.server``
continues to work while we migrate; it will be removed in a future
release.
"""

from console.server.openai_api import (
    API_CHAT_ID,
    API_SESSION_KEY,
    MAX_FILE_SIZE,
    _DATA_URL_RE,
    _FileSizeExceededError,
    _SSE_DONE,
    _chat_completion_response,
    _error_json,
    _parse_json_content,
    _parse_multipart,
    _response_text,
    _save_base64_data_url,
    _sse_chunk,
    create_app,
    handle_chat_completions,
    handle_health,
    handle_models,
    install_openai_routes,
)

__all__ = [
    "API_CHAT_ID",
    "API_SESSION_KEY",
    "MAX_FILE_SIZE",
    "_DATA_URL_RE",
    "_FileSizeExceededError",
    "_SSE_DONE",
    "_chat_completion_response",
    "_error_json",
    "_parse_json_content",
    "_parse_multipart",
    "_response_text",
    "_save_base64_data_url",
    "_sse_chunk",
    "create_app",
    "handle_chat_completions",
    "handle_health",
    "handle_models",
    "install_openai_routes",
]
