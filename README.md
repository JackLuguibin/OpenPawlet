# OpenPawlet

**Languages:** [中文说明](README.zh.md)

## What it is

OpenPawlet (PyPI package name `open-pawlet`) is a **web console** for the **[nanobot](https://github.com/JackLuguibin/nanobot)** ecosystem. It exposes an HTTP API and a browser UI that works alongside the `nanobot gateway` over WebSocket so you can manage bot-related resources locally or in deployment.

**Stack:** FastAPI backend (consistent error envelope and OpenAPI; Swagger/ReDoc/`openapi.json` are served by default at `/docs`, `/redoc`, `/openapi.json` — set each `*_url` to empty to hide) and a Vite frontend under `src/console/web` (HMR in development, production build supported).

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
| **Session transcripts** (nanobot) | Optional append-only JSONL logs under workspace `transcripts/` when `agents.defaults.persistSessionTranscript` is true; `transcriptIncludeFullToolResults` controls full tool payloads in the log |

**Typical use:** run next to `nanobot gateway` to inspect status, debug sessions, and manage these resources from the console.

## Screenshots

The **Nanobot** web UI (branded “Nanobot · AI Assistant” in the console) provides a sidebar for Chat, Control, Agent, and Management areas, plus a top bar for workspace selection, language, theme, and gateway status.

### Dashboard overview

The overview page surfaces key metrics (status, uptime, active sessions, messages, tokens, cost), the **current model**, and charts such as daily token usage and usage by model—useful for at-a-glance monitoring in local or deployed setups.

![Nanobot dashboard overview](docs/screenshots/dashboard-overview.png)

### Chat

The chat view supports **multiple sessions** (list with message counts and last activity), streaming-style replies with optional **thinking** / progress indicators, and an input area with token budget hints. Navigation to channels, MCP, memory, workspace, agents, skills, and related tools stays one click away in the sidebar.

![Nanobot chat](docs/screenshots/chat.png)

### Channels

**Channels** lists integrations for your bot (for example WebSocket, Weixin, DingTalk, Discord, Email, Feishu, Matrix, MoChat, Microsoft Teams, QQ, Slack, Telegram, WeCom, and WhatsApp). You can enable or edit each channel from the grid; the UI notes that changes are saved to `config.json` and that you should **restart the bot** for them to take effect.

![Nanobot channels management](docs/screenshots/channels.png)

## Architecture notes

- **Backend:** FastAPI-based OpenPawlet service with a consistent error envelope and OpenAPI documentation.
- **Frontend:** Vite app under `src/console/web`, with HMR in development and a production build path.

## Tech stack

| Layer | Technology |
|-------|------------|
| Runtime | Python ≥ 3.11 |
| Backend | FastAPI, Uvicorn, Pydantic v2, Loguru |
| nanobot integration | Bundled in this repo (`src/nanobot`); installed as part of `open-pawlet` |
| Frontend | Node.js + npm (see `src/console/web`) |
| Multi-process (optional) | Honcho + `Procfile` |

## Quick start

### 1. Virtual environment and install

A project-local `.venv` is recommended:

```bash
python3.11 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip uninstall -y nanobot-ai  # if you still had the old PyPI package; otherwise skip
pip install -e ".[dev]"
```

The `nanobot` Python package ships inside this repository; `pip install -e ".[dev]"` installs the console and nanobot together.

### 2. Frontend dependencies

```bash
cd src/console/web && npm install && cd ../../..
```

### 3. Run

> `console` and `open-pawlet` are the **same command** (both entry points map
> to `console.cli:main`). Use whichever name you prefer; the examples below use
> the shorter `console` alias.

#### Single-command production (recommended for local use)

API + SPA on one port, nanobot gateway spawned automatically:

```bash
npm --prefix src/console/web run build
console start   # open http://localhost:8000
```

`console start` runs the FastAPI server, mounts the prebuilt SPA from
`src/console/web/dist` (so the UI and `/api/v1/*` share a single origin and
port), **and spawns `nanobot gateway` as a child process** so the console can
immediately talk to nanobot over WebSocket. On first launch it also runs
`nanobot onboard` if `~/.nanobot/config.json` is missing. Pressing Ctrl+C
stops both processes together.

Flags:

- `--no-gateway` — the gateway is managed externally (honcho, systemd,
  docker-compose, …); this command only serves API + SPA.
- `--strict-gateway` — fail fast (exit non-zero) if the gateway subprocess
  cannot be started. By default the console logs a warning and keeps running
  in degraded mode (WebSocket features will be unavailable until a gateway
  comes up).

Re-run `npm run build` (or `console web build`) after frontend changes.

#### Separated dev processes (hot reload)

Run the backend and the Vite dev server in two terminals:

```bash
console server        # FastAPI on http://localhost:8000
console web dev       # Vite on   http://localhost:3000  (open this for the UI)
```

Open the **Vite URL** (`http://localhost:3000`); Vite proxies `/api/*` to
`:8000` and `/nanobot-ws/*` to the gateway on `:8765`. You may still want
`nanobot gateway` running separately for WebSocket-based features.

#### All-in-one via Honcho (three processes)

```bash
honcho start
```

The default `Procfile` runs three processes: `gateway` (bootstraps
`~/.nanobot/config.json` via `scripts/ensure-nanobot-onboard.sh` then runs
`nanobot gateway`), `server` (`console server`), and `web` (`console web
dev`). Same URLs as the separated-dev setup above.

#### Configuration

Settings are resolved with the following **priority (highest first)**:

1. Environment variables prefixed with `NANOBOT_SERVER_` (e.g.
   `NANOBOT_SERVER_PORT=9000`)
2. Optional `.env` file in the working directory
3. `~/.nanobot/nanobot_web.json` under the top-level `server` key
4. Built-in defaults (see `console.server.config.schema.ServerSettings`)

The JSON file is **opt-in**: it is no longer written automatically on first
boot. Create a starter file with `console init-config` when you want to
persist non-default values to disk.

## Version history (timeline)


Major releases for the `open-pawlet` PyPI package (matches `[project] version` in the root `pyproject.toml`). The console is built for the **nanobot** stack; embedded **nanobot** lives under `src/nanobot` and ships with each install. **Newest at the top; older entries below.** Add new rows at the **top** when you cut a release.

```text
2026-04-20 ──●── 0.2.2  nanobot WebSocket (session lifecycle, delta stream, busy state); tests/docs; UI & dashboard
              │
2026-04-19 ──●── 0.2.1  Aligned versions (pyproject, API schema, web); nanobot + console version metadata
              │
2026-04-19 ──●── 0.2.0  Deps & packaging; README; bundled nanobot; WhatsApp bridge under bridge/
              │
2026-04-19 ──●── 0.1.0  First release: FastAPI console for nanobot, CLI, workspace, README / Procfile
```

| Date | Version | Summary |
|------|---------|---------|
| 2026-04-20 | **0.2.2** | **nanobot:** WebSocket session lifecycle, delta streaming, and busy-state handling in gateway and UI; broader nanobot test coverage and channel docs. Console: dashboard/charts, activity filters, workspace and bot-profile flows, ErrorBoundary, layout and control tweaks; CI and Vitest hardening. |
| 2026-04-19 | **0.2.1** | Single source of truth for version strings (Python package, server API version, frontend `package.json`) so **nanobot**-embedded installs report consistent versions end-to-end. |
| 2026-04-19 | **0.2.0** | Dependency and optional extras cleanup, install docs; **nanobot** bundled in-repo; `bridge/` (including WhatsApp-related pieces). |
| 2026-04-19 | **0.1.0** | Initial OpenPawlet web console for **nanobot**: FastAPI backend, `console` CLI, workspace features, docs, and Honcho/Procfile entry points. |

## License

MIT — see [LICENSE](LICENSE) in the repository root.
