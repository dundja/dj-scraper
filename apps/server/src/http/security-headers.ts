import { SECURITY_HEADERS } from '@dj-scraper/shared'
import type { MiddlewareHandler } from 'hono'

export { SECURITY_HEADERS }

/**
 * Adds SECURITY_HEADERS (anti-framing, nosniff, no-referrer) to every response the app produces:
 * pages, assets, API answers and errors alike. Register it before the guard, so the guard's 403s
 * carry them too. Never adds CORS. Requests that Node's HTTP parser or @hono/node-server reject
 * before the app runs (malformed request line, unparseable Host or URL, oversized headers) get an
 * empty 400 or 431 without them: there is nothing to frame or sniff.
 */
export const securityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next()
  // c.header copies a finalized response first, so this works for every kind of response.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
}
