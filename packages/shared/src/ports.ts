import * as z from 'zod'

/** The local server's default port (PORT overrides it). */
export const SERVER_PORT = 4747

/** Vite's dev server. The server trusts this port only when started with --dev. */
export const WEB_DEV_PORT = 5173

/**
 * The PORT environment variable: digits only, 1024–65535. Browsers drop default ports (80) from
 * Host, which the guard would reject. The server and the Vite proxy both read PORT with this.
 */
export const PortSchema = z
  .string()
  .regex(/^\d{1,5}$/, 'must be a number')
  .transform(Number)
  .pipe(z.int().min(1024).max(65535))

/** The Host values a loopback server on `port` accepts: exact, lowercase, no [::1]. */
export const loopbackHosts = (port: number): string[] => [`localhost:${port}`, `127.0.0.1:${port}`]
