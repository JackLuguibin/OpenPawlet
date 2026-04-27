/// <reference types="vitest/config" />
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
    // Slightly raise the warning ceiling: the largest legitimate chunk
    // (echarts) is ~600 kB after manualChunks, which is acceptable for a
    // route that is already code-split.
    chunkSizeWarningLimit: 800,
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
        // accidentally inline an entire library (e.g. echarts being pulled
        // into the first route that imports it).
        manualChunks(rawId) {
          // Normalise Windows backslashes so the path tests below work on
          // every platform identically.
          const id = rawId.replace(/\\/g, '/')
          if (!id.includes('node_modules')) return undefined

          // echarts is ~1MB raw; keep it isolated so only Dashboard /
          // Observability routes pay the cost when first opened.
          if (
            id.includes('node_modules/echarts') ||
            id.includes('node_modules/zrender') ||
            id.includes('node_modules/echarts-for-react')
          ) {
            return 'echarts'
          }

          // CodeMirror + language packs + theme are large; co-locate so the
          // browser caches a single editor chunk for Workspace + Chat.
          if (
            id.includes('node_modules/@codemirror') ||
            id.includes('node_modules/@uiw/react-codemirror') ||
            id.includes('node_modules/@uiw/codemirror-extensions-basic-setup') ||
            id.includes('node_modules/@uiw/codemirror-theme-vscode') ||
            id.includes('node_modules/@lezer')
          ) {
            return 'codemirror'
          }

          // antd is huge (1MB+ tree-shaken). Pull leaf components that no
          // other antd module depends on into a separate `antd-heavy`
          // chunk, so non-Workspace/Runtime/Queues/Agents routes don't pay
          // the cost. Components imported by `antd-core` (date-picker,
          // calendar, time-picker, color-picker, steps – referenced by
          // locale strings or shared tokens) MUST stay in `antd-core` to
          // avoid Rollup circular-chunk warnings.
          if (
            id.includes('node_modules/antd/') ||
            id.includes('node_modules/@ant-design/') ||
            id.includes('node_modules/@rc-component/') ||
            id.includes('node_modules/rc-')
          ) {
            // Verified leaves via dependency analysis of antd@6.3.1 — none
            // of these are imported by sibling antd modules (other than the
            // top-level barrel `antd/es/index.js`, which we co-locate below),
            // so isolating them does not create runtime cycles. Tree-shaking
            // ensures unused leaf imports from the barrel drop out entirely.
            const leafSegments = [
              'antd/es/cascader/',
              'antd/es/transfer/',
              'antd/es/splitter/',
              'antd/es/upload/',
              'antd/es/table/',
              'antd/es/tree/',
              'antd/es/tree-select/',
              'antd/es/anchor/',
              'antd/es/carousel/',
              'antd/es/result/',
              'antd/es/mentions/',
              'antd/es/auto-complete/',
              // Heavy @rc-component/* packages that exclusively back the
              // leaves above (antd v6 moved rc-* into @rc-component/*).
              '@rc-component/table/',
              '@rc-component/tree/',
              '@rc-component/tree-select/',
              '@rc-component/cascader/',
              '@rc-component/mentions/',
              '@rc-component/upload/',
            ]
            if (leafSegments.some((seg) => id.includes(seg))) {
              return 'antd-heavy'
            }
            // The top-level barrel re-exports the leaves above, which would
            // otherwise create a circular chunk reference (core <-> heavy).
            // Co-locating the barrel with the leaves means consumers that
            // don't tree-shake the barrel still get a clean dependency edge:
            // antd-heavy -> antd-core (one direction only).
            if (
              id.endsWith('node_modules/antd/es/index.js') ||
              id.endsWith('node_modules/antd/lib/index.js')
            ) {
              return 'antd-heavy'
            }
            return 'antd-core'
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
        target: `ws://${host}:${port}`,
        ws: true,
        changeOrigin: true,
        rewrite: () => '/queues/stream',
      },
    },
  },
})
