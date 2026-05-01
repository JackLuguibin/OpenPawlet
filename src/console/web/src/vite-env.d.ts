/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_HOST?: string;
  readonly VITE_API_PORT?: string;
  /** Override `/ws/state` WebSocket URL; unset uses same-origin `/ws/state` (Vite proxies `/ws` → FastAPI). */
  readonly VITE_CONSOLE_WS_URL?: string;
  /** 默认 `/openpawlet-ws`（Vite 开发与 `VITE_API_*` 同端口，经 FastAPI 反代至内嵌通道）；空字符串关闭；或 `ws://127.0.0.1:8765/` 直连独立网关。 */
  readonly VITE_OPENPAWLET_WS_BASE?: string;
  /** 与 `websocketRequiresToken` / 静态 `token` 配置配合，作为握手 `?token=`。 */
  readonly VITE_OPENPAWLET_WS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
