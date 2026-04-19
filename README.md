# OpenPawlet

**Languages:** [中文说明](README.zh.md)

## What it is

OpenPawlet (PyPI package name `open-pawlet`) is a **web console** for the **[nanobot](https://github.com/JackLuguibin/nanobot)** ecosystem. It exposes an HTTP API and a browser UI that works alongside the `nanobot gateway` over WebSocket so you can manage bot-related resources locally or in deployment.

**Stack:** FastAPI backend (consistent error envelope and OpenAPI; docs can be disabled in production via settings) and a Vite frontend under `src/console/web` (HMR in development, production build supported).

## Feature areas

The console roughly covers the areas below (see the UI and OpenAPI for the exact surface):

| Area | Capabilities |
|------|--------------|
| **Bots & agents** | Inspect and manage bots and agents |
| **Chat & channels** | Sessions, chat, channels; debug with gateway WebSocket and realtime events |
| **Config & env** | Console and bot configuration, environment variables, bot file access (e.g. `bot_files`) |
| **Tools & extensions** | Tools, MCP servers, skills, memory |
| **Automation** | Cron jobs |
| **Ops & observability** | Status, health, health audit, usage, alerts, activity; control endpoints where applicable |
| **Workspace** | Workspace browsing and management |

**Typical use:** run next to `nanobot gateway` to inspect status, debug sessions, and manage these resources from the console.

## Architecture notes

- **Backend:** FastAPI-based OpenPawlet service with a consistent error envelope and OpenAPI documentation.
- **Frontend:** Vite app under `src/console/web`, with HMR in development and a production build path.

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Python ≥ 3.11 |
| Backend | FastAPI, Uvicorn, Pydantic v2, Loguru |
| nanobot integration | `nanobot-ai` from PyPI (see `pyproject.toml`; optional Git override for fork builds), `websockets` |
| Frontend | Node.js + npm (see `src/console/web`) |
| Multi-process (optional) | Honcho + `Procfile` |

## Quick start

### 1. Virtual environment and install

A project-local `.venv` is recommended:

```bash
python3.11 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -e ".[dev]"
```

`nanobot-ai` is installed from PyPI. To use the [JackLuguibin/nanobot](https://github.com/JackLuguibin/nanobot) fork (e.g. `feat/enhance_ws_event_main`) instead, run:  
`pip install --upgrade "nanobot-ai @ git+https://github.com/JackLuguibin/nanobot@feat/enhance_ws_event_main"`

### 2. Frontend dependencies

```bash
cd src/console/web && npm install && cd ../../..
```

### 3. Run

**API only** (defaults to `0.0.0.0:8000`; tune with `NANOBOT_SERVER_*` env vars, see `ServerSettings`):

```bash
console server
```

**Frontend dev** (waits for the console API and nanobot WebSocket unless `SKIP_GATEWAY_WAIT=1` or `web dev --no-wait`):

```bash
console web dev
```

**All-in-one** (requires `honcho` and a working `nanobot` CLI for the gateway):

```bash
honcho start
```

The default `Procfile` runs: `nanobot gateway`, `console server`, and `console web dev`.

## License

MIT — see [LICENSE](LICENSE) in the repository root.
