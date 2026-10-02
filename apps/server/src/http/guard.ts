import { allowedByFetchMetadata, loopbackHosts } from '@dj-scraper/shared'
import type { MiddlewareHandler } from 'hono'
import { errorResponse } from './errors.ts'

export type GuardOptions = {
  /** The port we listen on. Host must be exactly localhost:<port> or 127.0.0.1:<port>. */
  port: number
  /**
   * With --dev only: the Vite dev server's port. Vite's proxy forwards the browser's Host and
   * Origin unchanged, so localhost:<devPort> and 127.0.0.1:<devPort> are accepted as Host and
   * as origin too. Vite's own host check is looser than ours (it lets `file:*`, `*-extension:*`
   * and any IP through), so the exact check must stay here. Never set in production.
   */
  devPort?: number | undefined
}

/** Methods that never change state. Every other method must send JSON. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Refuses requests other websites can make (docs/architecture.md, Security model). Mount it first,
 * so it also covers 404s and static files. Rejections carry no CORS headers.
 * - Host must be ours, which defeats DNS rebinding. The URL host is checked too: for an
 *   absolute-form request target, node-server builds the URL from the target, not from Host.
 * - Origin, when present, must be ours, on every method. Safari sends a cross-site no-cors POST
 *   with a typed Blob body as application/json without a preflight; only this check stops it.
 * - Sec-Fetch-Site, when present, must be same-origin or none, except for a top-level navigation
 *   GET (a link to the app). This blocks cross-site <img>, <iframe> and sendBeacon.
 * - Unsafe methods need Content-Type application/json, which a cross-origin page can only send
 *   after a CORS preflight that we never approve.
 */
export const guard = ({ port, devPort }: GuardOptions): MiddlewareHandler => {
  const hosts = new Set([
    ...loopbackHosts(port),
    ...(devPort === undefined ? [] : loopbackHosts(devPort)),
  ])
  const origins = new Set([...hosts].map((host) => `http://${host}`))

  return async (c, next) => {
    // Duplicate Host headers reach Hono joined as "a, b", so they never match.
    const host = c.req.header('host')?.toLowerCase()
    if (host === undefined || !hosts.has(host) || !hosts.has(new URL(c.req.url).host)) {
      return errorResponse(c, 'forbidden', 'Host not allowed')
    }
    const origin = c.req.header('origin')
    if (origin !== undefined && !origins.has(origin)) {
      return errorResponse(c, 'forbidden', 'Origin not allowed')
    }
    const fetchMetadata = {
      method: c.req.method,
      site: c.req.header('sec-fetch-site'),
      mode: c.req.header('sec-fetch-mode'),
      dest: c.req.header('sec-fetch-dest'),
    }
    if (!allowedByFetchMetadata(fetchMetadata)) {
      return errorResponse(c, 'forbidden', 'Cross-site request not allowed')
    }
    if (!SAFE_METHODS.has(c.req.method) && !isJson(c.req.header('content-type'))) {
      return errorResponse(c, 'invalid_request', 'Content-Type must be application/json', 415)
    }
    await next()
  }
}

/** True for application/json with optional parameters; false for lists, +json and json-seq. */
export const isJson = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false
  const semicolon = contentType.indexOf(';')
  const essence = semicolon === -1 ? contentType : contentType.slice(0, semicolon)
  return essence.trim().toLowerCase() === 'application/json'
}
