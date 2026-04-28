/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_HOST?: string;
  readonly VITE_API_PORT?: string;
  /** 控制台实时推送完整 ws URL；未设置则不连接。例：`ws://localhost:3000/ws`（Vite 开发 + 代理） */
  readonly VITE_CONSOLE_WS_URL?: string;
  /** 默认 `/openpawlet-ws`（Vite 代理到 OpenPawlet 内置 websocket 通道）；空字符串关闭；或 `ws://127.0.0.1:8765/` 直连（`client_id` 固定为 `openpawlet-web`）。 */
  readonly VITE_OPENPAWLET_WS_BASE?: string;
  /** 与 `websocketRequiresToken` / 静态 `token` 配置配合，作为握手 `?token=`。 */
  readonly VITE_OPENPAWLET_WS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
