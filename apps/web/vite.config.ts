import { fileURLToPath } from 'node:url'
import { PortSchema, SECURITY_HEADERS, SERVER_PORT, WEB_DEV_PORT } from '@dj-scraper/shared'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import * as z from 'zod'
import { devExit } from './dev-exit.ts'
import { devGuard } from './dev-guard.ts'

/** `pnpm dev` passes one env to both apps, so the PORT the server listens on is the proxy target. */
const serverPort = (() => {
  const port = process.env.PORT
  if (port === undefined || port === '') return SERVER_PORT
  const parsed = PortSchema.safeParse(port)
  if (!parsed.success) throw new Error(`Invalid PORT "${port}": ${z.prettifyError(parsed.error)}`)
  return parsed.data
})()

/**
 * Vite's proxy (http-proxy-3) pipes the server's response into the browser's but never ends it when
 * the server dies mid-response, so an open event stream would hang without an error and never
 * reconnect. Destroying the browser's response lets the EventSource see the drop (D12).
 */
const endCutResponses: ProxyOptions['configure'] = (proxy) => {
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    proxyRes.on('close', () => {
      if (!proxyRes.complete) res.destroy()
    })
  })
}

export default defineConfig({
  plugins: [
    devGuard(WEB_DEV_PORT),
    // Ctrl-C exits 0, so pnpm dev doesn't end with ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL.
    devExit(),
    // Before react(), so its route code splitting sees the original route files.
    // addExtensions: the generated src/routeTree.gen.ts imports routes as .tsx, like our own code.
    tanstackRouter({ target: 'react', autoCodeSplitting: true, addExtensions: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The local server can spawn processes and write files, so the dev server must not widen who can
  // reach it (docs/architecture.md, Security model). Never set allowedHosts, host or https here.
  server: {
    port: WEB_DEV_PORT,
    // The server trusts exactly this port with --dev; on another port the app would be refused.
    strictPort: true,
    // Otherwise Vite answers CORS requests from any localhost origin, including other local apps.
    cors: false,
    // The server's own headers (anti-framing, nosniff, no-referrer): in dev Vite serves the page,
    // so the guard's iframe refusal doesn't cover it.
    headers: { ...SECURITY_HEADERS },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        // Keep the browser's Host (localhost:5173) so the server's exact Host check sees it. Vite's
        // own check is looser (it lets file:*, *-extension:* and any IP through), and changeOrigin
        // would hide the browser's Host behind 127.0.0.1:<port>.
        changeOrigin: false,
        configure: endCutResponses,
      },
    },
  },
  build: {
    // A local app: one ~570 kB bundle (mostly react-dom, zod, Base UI) loads from localhost.
    chunkSizeWarningLimit: 1024,
  },
})
