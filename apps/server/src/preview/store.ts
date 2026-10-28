import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import type { Platform, PreviewReady, PreviewRequest } from '@dj-scraper/shared'
import { PREVIEWS_DIR } from '../data-dir.ts'
import { type EngineEnv, spawnFailure } from '../engine/binaries.ts'
import { run, SpawnError } from '../engine/run.ts'
import { previewArgs } from '../engine/ytdlp-args.ts'
import { mapDownloadExit } from '../engine/ytdlp-errors.ts'
import { parsePreviewLine } from '../engine/ytdlp-progress.ts'
import { ApiError } from '../http/errors.ts'
import type { Budget, TokenBucket } from '../pacing/token-bucket.ts'
import { checkUrl } from '../resolve/input.ts'
import { createLimiter, type Limiter } from '../resolve/limiter.ts'
import { findYtdlp, type Logger, since } from '../resolve/ytdlp-call.ts'
import { errnoCode, failureName } from '../util/errno.ts'
import {
  type CachedFile,
  PREVIEW_CACHE_MAX_BYTES,
  PREVIEW_CACHE_MAX_FILES,
  PREVIEW_EXTENSIONS,
  PREVIEW_MAX_BYTES,
  parseCachedName,
  planEviction,
  previewId,
  previewMime,
} from './plan.ts'

/**
 * The preview cache (ADR-029): an upload's audio stream, fetched as it is by yt-dlp into
 * `<dataDir>/previews/<id>.<ext>`, for the app's own `<audio>` element. Never the user's folder,
 * never converted.
 * - One fetch per id at a time: requests for it share the fetch, which stops when none is waiting.
 * - At most 2 fetches at once; a SoundCloud fetch takes a token of the shared SoundCloud bucket,
 *   like a remix search does. (YouTube has no bucket outside the download gates, which a preview
 *   doesn't go through: only the cap applies.)
 * - A fetch writes into `previews/<uuid>/` (named in yt-dlp's argv, so the startup sweep finds it)
 *   and renames the file into place, so a half-written file is never served.
 * - At most 20 files and 400 MB are kept, the least recently used going first.
 */

export const PREVIEW_CONCURRENCY = 2
/** A preview that takes longer than this is given up on (a 200 MB cap at a slow link). */
export const PREVIEW_TIMEOUT_MS = 180_000
/** One `PREVIEW {…}` line; the rest of the output is only kept for its tail. */
const PREVIEW_MAX_OUTPUT_BYTES = 1024 * 1024

export const PREVIEWS_UNAVAILABLE = 'Only YouTube and SoundCloud uploads can be played here.'
export const PREVIEWS_SHUTTING_DOWN = 'DJ Scraper is shutting down'

export type PreviewStoreDeps = {
  engine: EngineEnv
  /** The data dir's real path; the cache is its `previews/`. */
  dataDirReal: string
  run?: typeof run
  /** Finds the yt-dlp binary per fetch, or throws `ApiError('engine_missing')`. */
  locate?: (engine: EngineEnv) => Promise<string>
  /** `process.execPath`, for `--js-runtimes`. */
  jsRuntime?: string
  /** `FFMPEG_PATH`, only when it is set. */
  ffmpegLocation?: string
  /** The SoundCloud bucket shared with lookups, remix searches and downloads. */
  soundcloudBudget?: Budget | TokenBucket
  concurrency?: number
  limits?: { maxFiles: number; maxBytes: number }
  timeoutMs?: number
  log?: Logger
}

/** A cached file opened for serving: read it, then `close` the handle (a stream does, at its end). */
export type OpenedPreview = { handle: FileHandle; size: number; mime: string }

export type PreviewStore = {
  /**
   * The request's audio, ready to serve: cached, or fetched now (shared with any request already
   * fetching it). Throws `ApiError`: `invalid_url`/`unsupported_url` (not a YouTube or SoundCloud
   * track), `invalid_request` (the id isn't the URL's), `canceled` when `signal` aborts, and
   * whatever the fetch failed with (`preview_only`, `unavailable`, `rate_limited`, `network`…).
   */
  prepare: (request: PreviewRequest, signal?: AbortSignal) => Promise<PreviewReady>
  /** Opens a cached file by id without following a symlink; undefined when there is none. */
  open: (id: string) => Promise<OpenedPreview | undefined>
  /** Stops every fetch and empties the cache. Later `prepare` calls are refused. */
  close: () => Promise<void>
}

type Flight = { promise: Promise<PreviewReady>; waiters: number; controller: AbortController }

export function createPreviewStore({
  engine,
  dataDirReal,
  run: runFn = run,
  locate = findYtdlp,
  jsRuntime = process.execPath,
  ffmpegLocation,
  soundcloudBudget,
  concurrency = PREVIEW_CONCURRENCY,
  limits = { maxFiles: PREVIEW_CACHE_MAX_FILES, maxBytes: PREVIEW_CACHE_MAX_BYTES },
  timeoutMs = PREVIEW_TIMEOUT_MS,
  log = console,
}: PreviewStoreDeps): PreviewStore {
  const dir = path.join(dataDirReal, PREVIEWS_DIR)
  const fetches: Limiter = createLimiter({ concurrency })
  // A call that only waits for its token: it holds no slot once it has one.
  const soundcloudGate: Limiter | undefined =
    soundcloudBudget === undefined
      ? undefined
      : createLimiter({ concurrency, budget: soundcloudBudget })
  const flights = new Map<string, Flight>()
  let closed = false

  /** The cached file of `id`, as `<id>.<ext>`; undefined when there is none. */
  async function findCached(id: string): Promise<{ name: string; size: number } | undefined> {
    for (const extension of PREVIEW_EXTENSIONS) {
      const name = `${id}.${extension}`
      try {
        const stats = await lstat(path.join(dir, name))
        if (stats.isFile() && stats.size > 0) return { name, size: stats.size }
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  const touch = (name: string) => {
    const now = new Date()
    return utimes(path.join(dir, name), now, now).catch(() => {})
  }

  const readyOf = (id: string, name: string, size: number): PreviewReady => {
    const extension = name.slice(id.length + 1)
    return {
      id,
      src: `/api/previews/${id}`,
      mime: previewMime(extension) ?? 'application/octet-stream',
      sizeBytes: size,
    }
  }

  async function evict(keep: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    const files: CachedFile[] = []
    for (const name of names) {
      if (parseCachedName(name) === undefined) continue
      try {
        const stats = await lstat(path.join(dir, name))
        if (stats.isFile()) files.push({ name, size: stats.size, mtimeMs: stats.mtimeMs })
      } catch {
        // Gone meanwhile.
      }
    }
    for (const name of planEviction(files, limits, keep)) {
      await rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  }

  /** The fetch itself, once a slot (and a SoundCloud token) is ours. */
  async function fetchOne(
    id: string,
    platform: Platform,
    url: string,
    signal: AbortSignal,
  ): Promise<PreviewReady> {
    const startedAt = performance.now()
    const bin = await locate(engine)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tempDir = path.join(await realpath(dir), randomUUID())
    await mkdir(tempDir, { mode: 0o700 })
    try {
      const argv = previewArgs({
        url,
        platform,
        tempDir,
        jsRuntime,
        ...(ffmpegLocation === undefined ? {} : { ffmpegLocation }),
      })
      let printed: string | undefined
      let result: Awaited<ReturnType<typeof run>>
      try {
        result = await runFn(bin, argv, {
          timeoutMs,
          signal,
          maxOutputBytes: PREVIEW_MAX_OUTPUT_BYTES,
          onStdoutLine: (line) => {
            printed ??= parsePreviewLine(line)
          },
        })
      } catch (error) {
        if (error instanceof SpawnError) {
          throw new ApiError('engine_missing', spawnFailure('yt-dlp', error.code), { cause: error })
        }
        if (signal.aborted) throw canceled()
        throw error
      }
      if (result.aborted) throw canceled()
      if (result.timedOut) {
        throw new ApiError('network', "The audio didn't arrive in time.")
      }
      if (result.exitCode !== 0) {
        const info = mapDownloadExit({
          exitCode: result.exitCode,
          stderr: result.stderr,
          breakFilter: platform === 'soundcloud',
          jobDir: tempDir,
        })
        log.warn(`[previews] ${platform}: failed (${info.code})`)
        throw new ApiError(info.code, info.message)
      }
      if (printed === undefined) {
        // Exit 0 and no file: a stream over --max-filesize, or one the site doesn't serve whole.
        log.warn(`[previews] ${platform}: nothing was downloaded`)
        throw new ApiError(
          'unknown',
          'Nothing was downloaded: the stream may be too large to play here.',
        )
      }
      const file = await checkedFile(tempDir, printed)
      const extension = path.extname(file.path).slice(1).toLowerCase()
      if (previewMime(extension) === undefined) {
        log.warn(`[previews] ${platform}: a stream this player can't play`)
        throw new ApiError('unknown', "This upload's audio format can't be played in the app.")
      }
      if (file.size > PREVIEW_MAX_BYTES) {
        throw new ApiError('unknown', 'The audio is too large to play here.')
      }
      // A rename inside one directory: atomic, and it replaces a stale file of the same id.
      const name = `${id}.${extension}`
      await rename(file.path, path.join(dir, name))
      for (const other of PREVIEW_EXTENSIONS) {
        if (other !== extension) await rm(path.join(dir, `${id}.${other}`), { force: true })
      }
      await touch(name)
      await evict(name)
      log.info(
        `[previews] ${id.slice(0, 8)} ${platform} ${extension} ${(file.size / 1e6).toFixed(1)} MB in ${since(startedAt)}`,
      )
      return readyOf(id, name, file.size)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** The printed path must be a regular file (not a link) inside the fetch's own temp dir. */
  async function checkedFile(
    tempDir: string,
    printed: string,
  ): Promise<{ path: string; size: number }> {
    const unreadable = () =>
      new ApiError('unknown', 'yt-dlp returned a file DJ Scraper could not read.')
    try {
      const real = await realpath(printed)
      const relative = path.relative(tempDir, real)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
        throw unreadable()
      const stats = await lstat(real)
      if (!stats.isFile() || stats.size === 0) throw unreadable()
      return { path: real, size: stats.size }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw unreadable()
    }
  }

  function start(id: string, platform: Platform, url: string): Flight {
    const controller = new AbortController()
    const { signal } = controller
    const promise = fetches
      .run(async () => {
        if (soundcloudGate !== undefined && platform === 'soundcloud') {
          await soundcloudGate.run(() => Promise.resolve(), signal)
        }
        signal.throwIfAborted()
        return fetchOne(id, platform, url, signal)
      }, signal)
      .catch((error: unknown): never => {
        // The limiters reject a wait that was aborted with the signal's reason.
        if (signal.aborted && !(error instanceof ApiError)) throw canceled()
        throw error
      })
      .finally(() => {
        if (flights.get(id) === created) flights.delete(id)
      })
    // Waiters handle the rejection; a flight nobody waits for any more must not crash the server.
    promise.catch(() => {})
    const created: Flight = { promise, waiters: 0, controller }
    flights.set(id, created)
    return created
  }

  return {
    async prepare(request, signal) {
      if (closed) throw new ApiError('canceled', PREVIEWS_SHUTTING_DOWN, { status: 503 })
      const checked = checkUrl(request.url)
      if (!checked.ok) throw new ApiError(checked.error.code, checked.error.message)
      const { input } = checked
      if (
        input.platform !== request.platform ||
        (input.platform !== 'youtube' && input.platform !== 'soundcloud')
      ) {
        throw new ApiError('unsupported_url', PREVIEWS_UNAVAILABLE)
      }
      if (input.guess !== 'track' && input.guess !== 'ambiguous') {
        throw new ApiError('unsupported_url', 'That link is not a single track.')
      }
      // The id names the cache entry: it must be the upload the URL names.
      if (input.platform === 'youtube' && input.videoId !== request.id) {
        throw new ApiError('invalid_request', "The track id doesn't match its link.")
      }
      // SoundCloud's id isn't in its URL, so its URL (classified, canonical) names the entry.
      const id = previewId(input.platform, input.platform === 'youtube' ? request.id : input.url)
      const cached = await findCached(id)
      if (cached !== undefined) {
        await touch(cached.name)
        return readyOf(id, cached.name, cached.size)
      }
      if (signal?.aborted) throw canceled()

      let flight = flights.get(id)
      // A stopped fetch may still be exiting: a new request gets a fetch of its own.
      if (flight === undefined || flight.controller.signal.aborted) {
        if (closed) throw new ApiError('canceled', PREVIEWS_SHUTTING_DOWN, { status: 503 })
        flight = start(id, input.platform, input.url)
      }
      const current = flight
      current.waiters++
      return new Promise<PreviewReady>((resolve, reject) => {
        let settled = false
        const leave = () => {
          if (settled) return false
          settled = true
          signal?.removeEventListener('abort', onAbort)
          current.waiters--
          return true
        }
        const onAbort = () => {
          if (!leave()) return
          if (current.waiters === 0) current.controller.abort()
          reject(canceled())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        current.promise.then(
          (ready) => {
            if (leave()) resolve(ready)
          },
          (error: unknown) => {
            if (leave()) reject(error)
          },
        )
      })
    },

    async open(id) {
      const cached = await findCached(id)
      if (cached === undefined) return undefined
      const extension = cached.name.slice(id.length + 1)
      const mime = previewMime(extension)
      if (mime === undefined) return undefined
      let handle: FileHandle | undefined
      try {
        // O_NOFOLLOW: a symlink planted as the file fails (ELOOP) instead of being followed.
        handle = await open(path.join(dir, cached.name), constants.O_RDONLY | constants.O_NOFOLLOW)
        const stats = await handle.stat()
        if (!stats.isFile() || stats.size === 0) {
          await handle.close()
          return undefined
        }
        await handle.utimes(new Date(), new Date()).catch(() => {})
        return { handle, size: stats.size, mime }
      } catch (error) {
        await handle?.close().catch(() => {})
        const code = errnoCode(error)
        if (code === 'ENOENT' || code === 'ELOOP') return undefined
        log.warn(`[previews] can't open a cached file (${failureName(error)})`)
        return undefined
      }
    },

    async close() {
      closed = true
      const pending = [...flights.values()]
      for (const flight of pending) flight.controller.abort()
      await Promise.allSettled(pending.map((flight) => flight.promise))
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names)
        await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
    },
  }
}

const canceled = () => new ApiError('canceled', 'The request was canceled.')
