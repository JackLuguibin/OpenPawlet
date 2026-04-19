# OpenPawlet

OpenPawlet (PyPI package name `open-pawlet`) is a **web console** for the **[nanobot](https://github.com/JackLuguibin/nanobot)** ecosystem. It exposes an HTTP API and a browser UI to manage bots, sessions, channels, tools, MCP servers, skills, cron jobs, workspace files, and configuration—working alongside the nanobot gateway over WebSocket.

[中文版](README.zh.md) · [Repository hub](README.md)

## Features

- **Backend**: FastAPI-based OpenPawlet console with a consistent error envelope and OpenAPI docs (can be disabled in production via settings).
- **Frontend**: Vite app under `web`, with HMR in development and a production build path.
- **Typical use**: Run next to `nanobot gateway` to inspect status, debug sessions, and manage bot-related resources from the console.

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Python ≥ 3.11 |
| Backend | FastAPI, Uvicorn, Pydantic v2, Loguru |
| nanobot integration | `nanobot-ai` (Git dependency; see `pyproject.toml`), `websockets` |
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

`nanobot-ai` is installed from Git; pin or bump the upstream revision by editing the URL in `pyproject.toml`, then reinstall.

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
