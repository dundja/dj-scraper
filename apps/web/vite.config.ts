import { fileURLToPath } from 'node:url'
import { PortSchema, SERVER_PORT, WEB_DEV_PORT } from '@dj-scraper/shared'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import * as z from 'zod'
import { devGuard } from './dev-guard.ts'

/** `pnpm dev` passes one env to both apps, so the PORT the server listens on is the proxy target. */
const serverPort = (() => {
  const port = process.env.PORT
  if (port === undefined || port === '') return SERVER_PORT
  const parsed = PortSchema.safeParse(port)
  if (!parsed.success) throw new Error(`Invalid PORT "${port}": ${z.prettifyError(parsed.error)}`)
  return parsed.data
})()

export default defineConfig({
  plugins: [
    devGuard(WEB_DEV_PORT),
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
    // The server's guard refuses iframe loads, but in dev Vite serves the page itself.
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        // Keep the browser's Host (localhost:5173) so the server's exact Host check sees it. Vite's
        // own check is looser (it lets file:*, *-extension:* and any IP through), and changeOrigin
        // would hide the browser's Host behind 127.0.0.1:<port>.
        changeOrigin: false,
      },
    },
  },
  build: {
    // A local app: one ~570 kB bundle (mostly react-dom, zod, Base UI) loads from localhost.
    chunkSizeWarningLimit: 1024,
  },
})
