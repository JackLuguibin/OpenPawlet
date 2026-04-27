"""Domain-level services shared between routers and other server components.

Modules in this package should not depend on FastAPI routers.  They wrap
``bot_workspace`` IO and validation so multiple call sites (HTTP routers,
WebSocket hub helpers, CLI utilities, etc.) can reuse the same logic without
forming router-to-router dependencies.
"""
