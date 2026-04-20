# OpenPawlet

OpenPawlet（PyPI 包名 `open-pawlet`）是围绕 **[nanobot](https://github.com/JackLuguibin/nanobot)** 生态构建的 **Web 控制台**：提供 HTTP API 与前端界面，用于在本地或部署环境中管理机器人、会话、通道、工具、MCP、技能、定时任务、工作区与配置等能力，并与 nanobot 网关的 WebSocket 协同工作。

[English README](README.md)

## 功能概览

- **后端**：基于 FastAPI 的 OpenPawlet 控制台服务，统一错误响应与 OpenAPI 文档（生产环境可按配置隐藏）。
- **前端**：`web` 目录下的 Vite 应用，支持开发态热更新与生产构建。
- **典型场景**：与 `nanobot gateway` 一起运行，通过控制台观察状态、调试会话、管理 Bot 相关资源。

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Python ≥ 3.11 |
| 后端 | FastAPI、Uvicorn、Pydantic v2、Loguru |
| 与 nanobot 集成 | 随本仓库提供（`src/nanobot`），与 `open-pawlet` 一并安装 |
| 前端 | Node.js + npm（见 `src/console/web`） |
| 多进程编排（可选） | Honcho + `Procfile` |

## 快速开始

### 1. 创建虚拟环境并安装

建议使用仓库内的 `.venv`：

```bash
python3.11 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip uninstall -y nanobot-ai  # 若仍安装过旧版 PyPI 包则执行，否则可省略
pip install -e ".[dev]"
```

`nanobot` 源码包含在本仓库中；执行 `pip install -e ".[dev]"` 会同时安装控制台与 nanobot。

### 2. 安装前端依赖

```bash
cd src/console/web && npm install && cd ../../..
```

### 3. 运行方式

**仅启动 API 服务**（默认监听 `0.0.0.0:8000`，可用环境变量 `NANOBOT_SERVER_*` 调整，见 `ServerSettings`）：

```bash
console server
```

**前端开发**：

```bash
console web dev
```

**一键多进程**（需已安装 `honcho`，且本机可用 `nanobot` 命令启动网关）：

```bash
honcho start
```

`Procfile` 中默认包含：`nanobot gateway`、`console server`、`console web dev`。

## 版本历史（时间线）

以下列出 PyPI 包 `open-pawlet` 的主要版本节点（与仓库根目录 `pyproject.toml` 中 `[project] version` 一致）。本控制台面向 **nanobot** 技术栈；内嵌 **nanobot** 源码位于 `src/nanobot`，随安装一并提供。**自上而下由新到旧**（越靠下越早）。发布新版本时请将对应条目补充到时间线**顶部**。

```text
2026-04-20 ──●── 0.2.2  nanobot WebSocket（会话生命周期、增量流、忙状态）；测试与文档；控制台 UI 与仪表盘
              │
2026-04-19 ──●── 0.2.1  统一版本号（pyproject、API schema、前端 package）；nanobot 与控制台版本元数据
              │
2026-04-19 ──●── 0.2.0  依赖与打包调整；README 修订；仓库内嵌 nanobot；新增 WhatsApp bridge 等
              │
2026-04-19 ──●── 0.1.0  首个版本：面向 nanobot 的 FastAPI 控制台、CLI、工作区与基础 README / Procfile
```

| 日期 | 版本 | 摘要 |
|------|------|------|
| 2026-04-20 | **0.2.2** | **nanobot：** WebSocket 会话生命周期、增量流式传输、网关在忙状态与 UI 联动；扩充 nanobot 相关测试与通道类文档。控制台：仪表盘/图表、活动筛选、工作区与 Bot 资料流程、ErrorBoundary、布局与控件优化；CI 与 Vitest 加固。 |
| 2026-04-19 | **0.2.1** | Python 包、服务端 API 版本、前端 `package.json` 等版本号对齐，便于带内嵌 **nanobot** 的安装在各处报告一致版本。 |
| 2026-04-19 | **0.2.0** | 依赖与可选集成整理、安装说明更新；**nanobot** 随本仓库打包；引入 `bridge/`（含 WhatsApp 相关）等扩展。 |
| 2026-04-19 | **0.1.0** | 面向 **nanobot** 的 OpenPawlet Web 控制台首发：FastAPI 后端、`console` CLI、工作区能力、基础文档与多进程编排入口。 |

## 许可证

MIT License — 见仓库根目录 [LICENSE](LICENSE)。
