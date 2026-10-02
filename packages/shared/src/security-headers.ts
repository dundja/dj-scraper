/**
 * Sent with every page and API response, by the server (apps/server/src/http/security-headers.ts)
 * and by the Vite dev server alike:
 * - The UI must never be framed: a framed app can be clickjacked into a state-changing click.
 * - No content sniffing: a file is only ever what its Content-Type says.
 * - No Referer: links out to YouTube or SoundCloud don't reveal the local URL.
 */
export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const
