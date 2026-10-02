import { statSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context, Handler } from 'hono'
import { getMimeType } from 'hono/utils/mime'
import { errorResponse } from '../http/errors.ts'

/**
 * Serves the built UI (Vite's `apps/web/dist`) in production. Mount it after the guard and the
 * /api routes, for GET (Hono runs GET handlers for HEAD too). Not used with --dev: Vite serves the
 * UI then.
 *
 * - A path that names a file inside the dist dir gets that file.
 * - Otherwise a path outside /api whose last segment has no dot (`/`, `/downloads`, `/settings/x`)
 *   gets index.html, so the client router can render it (the SPA fallback).
 * - Everything else is 404 not_found JSON: a missing `/assets/x.js` or `/favicon.ico`, any /api
 *   path, and paths we refuse to look up.
 *
 * Hand-written rather than @hono/node-server's serveStatic, which serves dotfiles and follows
 * symlinks out of its root.
 */

/** Vite puts a content hash in every name under /assets, so a changed file gets a new URL. */
const IMMUTABLE = 'public, max-age=31536000, immutable'
/** index.html and the unhashed files from apps/web/public: revalidate every time. */
const NO_CACHE = 'no-cache'

/**
 * A path segment that may name a file: letters, digits, `_`, `-` and `.`, not starting with a dot.
 * That covers Vite's output (`index-DuTPbFGu.js`, `favicon.svg`) and rules out dotfiles, `.` and
 * `..`, empty segments (`//`), and anything still percent-encoded or decoded into `\`, NUL or a
 * space, so none of those ever reach the file system.
 */
const FILE_SEGMENT = /^[\w-][\w.-]*$/
const MAX_PATH_LENGTH = 1024

/** Errors that mean "no such file" for a path built from a request. */
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'])

export const NO_UI_MESSAGE = 'The UI is not built. Run `pnpm build` (pnpm start does).'

const isApiPath = (requestPath: string) => requestPath === '/api' || requestPath.startsWith('/api/')

/** True when `dir` holds an index.html to serve. Synchronous: for the boot check only. */
export const hasBuiltUi = (dir: string): boolean => {
  try {
    return statSync(path.join(dir, 'index.html')).isFile()
  } catch {
    // Missing, not a directory, or unreadable: there is no UI to serve either way.
    return false
  }
}

export const serveWeb =
  (root: string): Handler =>
  async (c) => {
    const requestPath = c.req.path
    if (isApiPath(requestPath)) return c.notFound()

    const file = await findFile(root, requestPath)
    if (file !== undefined) {
      return send(c, file, requestPath.startsWith('/assets/') ? IMMUTABLE : NO_CACHE)
    }
    if ((requestPath.split('/').at(-1) ?? '').includes('.')) return c.notFound()

    const index = await findFile(root, '/index.html')
    if (index === undefined) return errorResponse(c, 'not_found', NO_UI_MESSAGE)
    return send(c, index, NO_CACHE)
  }

type FoundFile = { path: string; size: number }

/** The regular file `requestPath` names inside `root`, after resolving symlinks; or undefined. */
async function findFile(root: string, requestPath: string): Promise<FoundFile | undefined> {
  if (requestPath.length > MAX_PATH_LENGTH || !requestPath.startsWith('/')) return undefined
  const segments = requestPath.slice(1).split('/')
  if (!segments.every((segment) => FILE_SEGMENT.test(segment))) return undefined
  try {
    // Resolved per request: the dist dir may be built (or rebuilt) while the server runs.
    const realRoot = await realpath(root)
    const real = await realpath(path.join(realRoot, ...segments))
    // A symlink may point anywhere; only files that really are inside the dist dir are served.
    const relative = path.relative(realRoot, real)
    if (relative === '' || relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) {
      return undefined
    }
    const stats = await stat(real)
    // Not a directory listing, a FIFO or a socket.
    return stats.isFile() ? { path: real, size: stats.size } : undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function send(c: Context, file: FoundFile, cacheControl: string) {
  // Read before setting any header: a file deleted meanwhile (`pnpm build` empties the dist dir)
  // becomes a plain 404, without this file's Cache-Control.
  const body = c.req.method === 'HEAD' ? null : await readIfPresent(file.path)
  if (body === undefined) return c.notFound()
  c.header('Content-Type', getMimeType(file.path) ?? 'application/octet-stream')
  c.header('Cache-Control', cacheControl)
  c.header('Content-Length', String(body?.byteLength ?? file.size))
  return body === null ? c.body(null) : c.body(body)
}

/** The whole file (the bundle is about 600 kB, for one local browser), or undefined if it's gone. */
async function readIfPresent(file: string) {
  try {
    return await readFile(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return typeof error.code === 'string' && MISSING.has(error.code)
}
