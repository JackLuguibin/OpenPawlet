"""Regression tests for OpenPawlet API contract annotations.

These tests keep the OpenAPI surface honest:

- Stub / placeholder routes are marked ``deprecated`` so SDK generators stop
  treating them as stable.
- Bot-scoped routes carry the shared ``bot_id`` description, making the
  single-instance semantics discoverable from the schema itself.
"""

from __future__ import annotations

import pytest

from console.server.app import create_app
from console.server.config import ServerSettings
from console.server.nanobot_user_config import BOT_ID_DESCRIPTION


@pytest.fixture
def openapi_schema() -> dict:
    app = create_app(ServerSettings())
    return app.openapi()


def _operation(schema: dict, method: str, path: str) -> dict:
    paths = schema["paths"]
    full = f"/api/v1{path}"
    assert full in paths, f"{full} not found in OpenAPI schema"
    op = paths[full].get(method.lower())
    assert op is not None, f"{method} {full} not defined"
    return op


def test_chat_stub_is_deprecated(openapi_schema: dict) -> None:
    op = _operation(openapi_schema, "post", "/chat")
    assert op.get("deprecated") is True


def test_control_stop_is_deprecated(openapi_schema: dict) -> None:
    op = _operation(openapi_schema, "post", "/control/stop")
    assert op.get("deprecated") is True


def test_control_restart_is_deprecated(openapi_schema: dict) -> None:
    op = _operation(openapi_schema, "post", "/control/restart")
    assert op.get("deprecated") is True


def test_control_bot_id_uses_shared_description(openapi_schema: dict) -> None:
    op = _operation(openapi_schema, "post", "/control/stop")
    params = op.get("parameters", [])
    bot_id = next((p for p in params if p.get("name") == "bot_id"), None)
    assert bot_id is not None
    assert bot_id.get("description") == BOT_ID_DESCRIPTION


def test_health_route_is_not_deprecated(openapi_schema: dict) -> None:
    """Sanity check: real routes are *not* flagged as deprecated."""
    op = _operation(openapi_schema, "get", "/health")
    assert op.get("deprecated") is not True
