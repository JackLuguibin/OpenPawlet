# OpenPawlet

OpenPawlet（PyPI 包名 `open-pawlet`）是围绕 **[OpenPawlet](https://github.com/JackLuguibin/OpenPawlet)** 生态构建的 **Web 控制台**：提供 HTTP API 与前端界面，用于在本地或部署环境中管理机器人、会话、通道、工具、MCP、技能、定时任务、工作区与配置等能力，并与 OpenPawlet 内置 WebSocket 通道协同工作。

[English README](README.md)

## 功能概览

- **后端**：基于 FastAPI 的 OpenPawlet 控制台服务，统一错误响应与 OpenAPI 文档；默认在 `/docs`、`/redoc`、`/openapi.json` 暴露，将对应配置项置空即可隐藏。
- **前端**：`src/console/web` 目录下的 Vite 应用，支持开发态热更新与生产构建。
- **典型场景**：执行 `open-pawlet start` 即可；内嵌的 OpenPawlet 运行时随同一个 FastAPI 进程启动，无需再额外维护 gateway 进程，可以直接在控制台观察状态、调试会话、管理 Bot 相关资源。

## 界面预览

控制台前端以 **OpenPawlet · AI Assistant** 为品牌展示：左侧为 **Chat / Control / Agent / Management** 分组导航，顶部可切换工作区、语言、明暗主题，并显示与网关的连接状态。

### 仪表盘总览

**Overview** 页面集中展示运行状态、在线会话数、当日消息与 Token、成本等卡片指标，以及**当前模型**与「按日 Token」「按模型占比」等图表，便于快速掌握助手与用量情况。

![OpenPawlet 仪表盘总览](docs/screenshots/dashboard-overview.png)

### 对话

**Chat** 支持多会话列表（消息数、最近活动时间），消息区可展示流式回复与 **Thinking** 等过程提示，底部输入框旁可显示 Token 占用比例。侧栏可直达通道、MCP、记忆、工作区、Agent、技能等能力。

![OpenPawlet 对话界面](docs/screenshots/chat.png)

### 通道管理

**Channels** 以卡片网格管理各类接入（如 WebSocket、微信、钉钉、Discord、邮件、飞书、Matrix、MoChat、Microsoft Teams、QQ、Slack、Telegram、企业微信、WhatsApp 等）。界面会提示：配置会写入 `config.json`，修改后需**重启 Bot** 才会生效。

![OpenPawlet 通道管理](docs/screenshots/channels.png)

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Python ≥ 3.11 |
| 后端 | FastAPI、Uvicorn、Pydantic v2、Loguru |
| 与 OpenPawlet 智能体框架集成 | 随本仓库提供（`src/openpawlet`），与 `open-pawlet` 一并安装 |
| 前端 | Node.js + npm（见 `src/console/web`） |
| 单进程入口 | `open-pawlet start`（统一 FastAPI 服务） |

## 快速开始

### 1. 创建虚拟环境并安装

建议使用仓库内的 `.venv`：

```bash
python3.11 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -e ".[dev]"
```

`openpawlet` 源码包含在本仓库中；执行 `pip install -e ".[dev]"` 会同时安装控制台与智能体框架。

### 2. 安装前端依赖

```bash
cd src/console/web && npm install && cd ../../..
```

### 3. 运行方式

> **`open-pawlet`** 为唯一命令行入口（`openpawlet.cli.commands:app`），例如
> `open-pawlet start`、`open-pawlet agent`、`open-pawlet onboard`。
>
> 自 0.3.x 起，**所有服务收紧到单一 FastAPI 进程**：REST API、SPA、OpenAI 兼容
> `/v1/*`、队列管理 `/queues/*`、WebSocket `/openpawlet-ws/*` 与内嵌的 OpenPawlet 运行时
> （AgentLoop、Channels、Cron、Heartbeat）共享同一事件循环、对外只暴露**一个 HTTP 端口**。
> 旧的独立 `gateway` / `serve` / `open-pawlet-queue-manager` /
> `Procfile` / `honcho` 入口已全部移除。

#### 单命令生产模式（推荐本机使用）

```bash
npm --prefix src/console/web run build
open-pawlet start   # 打开 http://localhost:8000
```

`open-pawlet start` 会启动 FastAPI，并从 `src/console/web/dist` 挂载已构建的 SPA，
使前端页面与 `/api/v1/*` 共用同一端口；**同时在同一事件循环里启动 OpenPawlet 运行时**
（不再 fork 任何子进程，亦不再依赖 ZeroMQ broker），所有 WebSocket / 通道 / 定时任务
都在 lifespan 中托管。首次运行若缺少 `~/.openpawlet/config.json` 请先执行 `open-pawlet onboard`。
按 Ctrl+C 优雅停止整个进程。

可选参数：

- `--no-spa`：不挂载前端 SPA，仅暴露 API 与 WebSocket 路由（适合纯 API 部署）。

前端有更新时先执行 `npm run build`（或 `open-pawlet web build`）再启动即可。

#### 前后端分离开发模式（热更新）

在两个终端分别运行：

```bash
open-pawlet start         # 单进程：FastAPI + 内嵌 OpenPawlet，监听 http://localhost:8000
open-pawlet web dev       # Vite 前端开发服，监听 http://localhost:3000  （请打开该地址访问 UI）
```

请在浏览器中访问 **Vite 地址** `http://localhost:3000`；Vite 会把 `/api/*`、`/v1/*`、
`/queues/*` 与 `/openpawlet-ws/*` 全部代理到 `:8000`。无需再单独启动任何 gateway 或
queue-manager 进程。

#### 跨平台说明

- 单进程方案在 **Windows 与 Linux** 均可直接运行；CLI 在启动时会自动切换到
  `WindowsSelectorEventLoopPolicy` 以保证一致行为。
- 信号处理统一封装在 `console.server.signals`，Linux 走
  `loop.add_signal_handler`，Windows 退化到 `signal.signal`。
- 测试套件 `pytest -q` 在 Win/Linux 都可跑通（仅 Win 平台 `sleep` 命令缺失会跳过 1
  个与本仓库无关的 ExecTool 用例）。

#### 配置优先级

控制台的设置按以下**优先级自高向低**解析：

1. 前缀为 `OPENPAWLET_SERVER_` 的环境变量（例如 `OPENPAWLET_SERVER_PORT=9000`）
2. 当前工作目录下可选的 `.env` 文件
3. `~/.openpawlet/openpawlet_web.json` 顶层 `server` 段
4. 内置默认值（见 `console.server.config.schema.ServerSettings`）

JSON 文件已改为**可选**：首次启动不会再自动写入默认值。如需把自定义值持久化到磁盘，
可执行 `open-pawlet init-config` 生成一份起始文件。

## 版本历史（时间线）

以下列出 PyPI 包 `open-pawlet` 的主要版本节点（与仓库根目录 `pyproject.toml` 中 `[project] version` 一致）。本控制台与内嵌 **OpenPawlet** 智能体框架配套；源码位于 `src/openpawlet`，随安装一并提供。**自上而下由新到旧**（越靠下越早）。发布新版本时请将对应条目补充到时间线**顶部**。

```text
2026-04-26 ──●── 0.3.0  单 FastAPI 服务收紧：合并 console + OpenPawlet OpenAI API + queue admin + gateway 到单进程；移除 ZMQ broker / Procfile / honcho；in-process MessageBus；Win/Linux 兼容统一；新增 unified app 全链路测试
              │
2026-04-20 ──●── 0.2.2  OpenPawlet WebSocket（会话生命周期、增量流、忙状态）；测试与文档；控制台 UI 与仪表盘
              │
2026-04-19 ──●── 0.2.1  统一版本号（pyproject、API schema、前端 package）；OpenPawlet 与控制台版本元数据
              │
2026-04-19 ──●── 0.2.0  依赖与打包调整；README 修订；仓库内嵌 OpenPawlet 框架；新增 WhatsApp bridge 等
              │
2026-04-19 ──●── 0.1.0  首个版本：面向 OpenPawlet 智能体的 FastAPI 控制台、CLI、工作区与基础 README / Procfile
```

| 日期 | 版本 | 摘要 |
|------|------|------|
| 2026-04-26 | **0.3.0** | **架构收紧：** 全部服务（REST / SPA / OpenAI 兼容 `/v1/*` / queues admin / WebSocket / OpenPawlet 运行时）合并到单一 FastAPI 进程；移除旧版独立 `gateway` / `serve`、`open-pawlet-queue-manager`、`Procfile` 与 ZeroMQ broker；in-process MessageBus 取代 ZMQ；统一 Win/Linux 事件循环与信号处理；新增 `EmbeddedOpenPawlet` 运行时与 unified app 全链路测试。 |
| 2026-04-20 | **0.2.2** | **OpenPawlet：** WebSocket 会话生命周期、增量流式传输、网关在忙状态与 UI 联动；扩充框架相关测试与通道类文档。控制台：仪表盘/图表、活动筛选、工作区与 Bot 资料流程、ErrorBoundary、布局与控件优化；CI 与 Vitest 加固。 |
| 2026-04-19 | **0.2.1** | Python 包、服务端 API 版本、前端 `package.json` 等版本号对齐，便于 **OpenPawlet** 安装在各处报告一致版本。 |
| 2026-04-19 | **0.2.0** | 依赖与可选集成整理、安装说明更新；**OpenPawlet** 框架随本仓库打包；引入 `bridge/`（含 WhatsApp 相关）等扩展。 |
| 2026-04-19 | **0.1.0** | **OpenPawlet Web 控制台**首发：FastAPI 后端、`console` CLI、工作区能力、基础文档与多进程编排入口。 |

## 许可证

MIT License — 见仓库根目录 [LICENSE](LICENSE)。
