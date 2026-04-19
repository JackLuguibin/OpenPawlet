import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const host = process.env.VITE_API_HOST || 'localhost'
const port = process.env.VITE_API_PORT || '8000'
const nanobotWsHost = process.env.VITE_NANOBOT_WS_HOST || 'localhost'
const nanobotWsPort = process.env.VITE_NANOBOT_WS_PORT || '8765'

/**
 * Vite logs many proxied WebSocket errors at error level. Suppress only common,
 * non-actionable cases (client teardown; upstream not ready yet during dev).
 */
function muteBenignViteWsProxyErrors(): Plugin {
  const patched = Symbol('muteBenignViteWsProxyErrors')
  return {
    name: 'mute-benign-vite-ws-proxy-errors',
    apply: 'serve',
    configureServer(server) {
      const logger = server.config.logger
      if ((logger as unknown as Record<symbol, boolean>)[patched]) {
        return
      }
      ;(logger as unknown as Record<symbol, boolean>)[patched] = true
      const origError = logger.error.bind(logger)
      logger.error = (msg, options) => {
        const text = typeof msg === 'string' ? msg : String(msg)
        if (
          text.includes('ws proxy socket error') &&
          /\b(ECONNRESET|EPIPE|ECANCELED)\b/.test(text)
        ) {
          return
        }
        if (
          text.includes('ws proxy error') &&
          /\b(ECONNREFUSED|ETIMEDOUT|ENETUNREACH)\b/.test(text)
        ) {
          return
        }
        return origError(msg, options)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), muteBenignViteWsProxyErrors()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: `http://${host}:${port}`,
        changeOrigin: true,
      },
      // 控制台 FastAPI 若实现 /ws，开发时可用 VITE_CONSOLE_WS_URL=ws://localhost:3000/ws
      '/ws': {
        target: `ws://${host}:${port}`,
        ws: true,
        changeOrigin: true,
      },
      // nanobot built-in `nanobot.channels.websocket`; strips prefix so `/?client_id=...` hits WS path
      '/nanobot-ws': {
        target: `ws://${nanobotWsHost}:${nanobotWsPort}`,
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/nanobot-ws/, '') || '/',
      },
    },
  },
})
