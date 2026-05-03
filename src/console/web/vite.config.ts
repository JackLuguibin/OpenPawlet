/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Default to IPv4 loopback so the dev proxy matches a typical uvicorn bind on
// Windows (Node often resolves "localhost" to ::1 first; target may be IPv4-only).
const host = process.env.VITE_API_HOST || '127.0.0.1'
const port = process.env.VITE_API_PORT || '8000'

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
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: false,
  },
  plugins: [react(), muteBenignViteWsProxyErrors()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      // Suppress the "Circular chunk: antd-heavy -> antd-core -> antd-heavy"
      // notice. antd's internal modules (e.g. table -> filterDropdown -> tree)
      // legitimately cross the leaf/non-leaf boundary, but the resulting
      // ESM cycles are harmless at runtime and the chunking still saves ~85kB
      // on routes that don't use Table/Tree/Cascader/etc.
      onwarn(warning, warn) {
        if (
          warning.code === 'CIRCULAR_DEPENDENCY' ||
          (warning.message && warning.message.startsWith('Circular chunk:'))
        ) {
          return
        }
        warn(warning)
      },
      output: {
        // Split heavy 3rd-party libs into their own long-lived chunks so the
        // main entry chunk stays small and per-route lazy chunks don't
        // accidentally inline an entire library into the wrong route bundle.
        manualChunks(rawId) {
          // Normalise Windows backslashes so the path tests below work on
          // every platform identically.
          const id = rawId.replace(/\\/g, '/')
          if (!id.includes('node_modules')) return undefined

          // chart.js (~200+kB gzip pre-split) stays isolated so only routes
          // that render charts pull it after lazy loading.
          if (
            id.includes('node_modules/chart.js') ||
            id.includes('node_modules/react-chartjs-2')
          ) {
            return 'chartjs'
          }

          // antd + @ant-design/* + rc-*: keep in ONE chunk. Splitting into
          // core / rc / heavy caused rollup chunk cycles → minified TDZ errors
          // ("Cannot access 'X' before initialization") in production.
          if (
            id.includes('node_modules/antd/') ||
            id.includes('node_modules/@ant-design/') ||
            id.includes('node_modules/@rc-component/') ||
            id.includes('node_modules/rc-')
          ) {
            return 'antd-vendor'
          }

          // CodeMirror 6 stack: MUST stay one chunk. Splitting cm-view /
          // cm-lezer / cm-codemirror produces cross-chunk cycles → TDZ in prod.
          if (
            id.includes('node_modules/@codemirror/') ||
            id.includes('node_modules/@lezer/') ||
            id.includes('node_modules/@marijn/') ||
            id.includes('node_modules/@uiw/react-codemirror') ||
            id.includes('node_modules/@uiw/codemirror-') ||
            id.includes('node_modules/crelt/') ||
            id.includes('node_modules/style-mod/') ||
            id.includes('node_modules/w3c-keyname/')
          ) {
            return 'codemirror-vendor'
          }

          // Markdown stack (used by Chat / Workspace) is ~150kB on its own.
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/remark-') ||
            id.includes('node_modules/micromark') ||
            id.includes('node_modules/mdast-') ||
            id.includes('node_modules/unist-') ||
            id.includes('node_modules/hast-') ||
            id.includes('node_modules/unified') ||
            id.includes('node_modules/vfile')
          ) {
            return 'markdown'
          }

          // i18next is loaded eagerly via main.tsx; keep it as a stable
          // long-lived vendor chunk.
          if (
            id.includes('node_modules/i18next') ||
            id.includes('node_modules/react-i18next')
          ) {
            return 'i18n'
          }

          // React core – very stable, ideal for long-term browser cache.
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/') ||
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/@remix-run/router')
          ) {
            return 'react-vendor'
          }
          return undefined
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: `http://${host}:${port}`,
        changeOrigin: true,
      },
      // Console `/ws/state` (state hub). Target must be HTTP(S): http-proxy upgrades to WS.
      '/ws': {
        target: `http://${host}:${port}`,
        ws: true,
        changeOrigin: true,
      },
      // Same-origin WS as production: FastAPI `/openpawlet-ws/*` proxies to embedded gateway (see README).
      '/openpawlet-ws': {
        target: `http://${host}:${port}`,
        ws: true,
        changeOrigin: true,
      },
      // Queue admin stream (FastAPI WS route registered by queues_router).
      // ``/queues/stream`` is the canonical path; ``/queues-ws`` is kept as a
      // dev-only alias and rewritten so it still hits the same handler if any
      // older client uses it.
      '/queues': {
        target: `http://${host}:${port}`,
        changeOrigin: true,
        ws: true,
      },
      '/queues-ws': {
        target: `http://${host}:${port}`,
        ws: true,
        changeOrigin: true,
        rewrite: () => '/queues/stream',
      },
    },
  },
})
