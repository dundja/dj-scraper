import type { IncomingMessage, ServerResponse } from 'node:http'
import { allowedByFetchMetadata, loopbackHosts } from '@dj-scraper/shared'
import type { Plugin } from 'vite'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(', ') : value
}

/**
 * Vite's launch-editor endpoint. Connect matches routes case-insensitively, so compare lowercase;
 * a URL we can't parse gets the strict rule too.
 */
const opensEditor = (url: string | undefined): boolean => {
  const pathname = URL.parse(url ?? '/', 'http://localhost')?.pathname
  return pathname === undefined || pathname.toLowerCase().startsWith('/__open-in-editor')
}

/**
 * The server guard's rules for every request the Vite dev server answers (docs/architecture.md,
 * Security model), so the dev server is no easier to drive than the server itself:
 * - Host must be exactly localhost:<port> or 127.0.0.1:<port>. Vite's own host check lets
 *   `file:*`, `*-extension:*`, any IP and a missing Host through, so a DNS-rebinding page could
 *   otherwise read the repo through /@fs and call /__open-in-editor same-origin.
 * - The Fetch Metadata rule (allowedByFetchMetadata): no cross-site or other-port framing,
 *   module loads or fetches. A link to the app (a top-level navigation) still works.
 * - /__open-in-editor opens files in the developer's editor, so even a link may not reach it:
 *   only the page itself (Vite's error overlay fetches it same-origin) or a non-browser client.
 * Proxied /api requests are checked again by the server's guard.
 */
export function devGuardMiddleware(port: number): Middleware {
  const hosts = new Set(loopbackHosts(port))

  return (req, res, next) => {
    const refuse = (message: string) => {
      res.statusCode = 403
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(message)
    }
    const host = header(req, 'host')?.toLowerCase()
    if (host === undefined || !hosts.has(host)) return refuse('Host not allowed')

    const request = {
      method: req.method ?? 'GET',
      site: header(req, 'sec-fetch-site'),
      mode: header(req, 'sec-fetch-mode'),
      dest: header(req, 'sec-fetch-dest'),
    }
    const allowed = opensEditor(req.url)
      ? request.site === undefined || request.site === 'same-origin'
      : allowedByFetchMetadata(request)
    if (!allowed) return refuse('Cross-site request not allowed')
    next()
  }
}

/** Dev server only; `pnpm start` serves the built app through the server's own guard. */
export const devGuard = (port: number): Plugin => ({
  name: 'dj-scraper:dev-guard',
  apply: 'serve',
  configureServer(server) {
    // Added directly, not from a returned (post) hook: only Vite's request and Host checks run
    // before it; its proxy, /__open-in-editor and file serving run after.
    server.middlewares.use(devGuardMiddleware(port))
  },
})
