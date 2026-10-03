import {
  type BulkJobsResponse,
  CancelJobsRequestSchema,
  ClearJobsRequestSchema,
  type CreateDownloadsResponse,
  type DownloadRequest,
  DownloadRequestSchema,
  type DownloadsSnapshot,
  type ErrorInfo,
  type Job,
  RetryJobsRequestSchema,
  type Track,
  type TrackRef,
  TrackRefSchema,
  type UnavailableReason,
} from '@dj-scraper/shared'
import { type Context, Hono } from 'hono'
import * as z from 'zod'
import { PREVIEW_ONLY } from '../engine/ytdlp-errors.ts'
import { type FolderOps, resolveTargetFolder } from '../fs/folders.ts'
import { revealInFinder } from '../fs/reveal.ts'
import { ApiError } from '../http/errors.ts'
import { jsonBodyLimitOf, readJson } from '../http/json.ts'
import { LIST_URL } from '../jobs/attempt.ts'
import type { EnqueueItem, Queue } from '../jobs/queue.ts'
import { type EngineBins, StepError, type TargetFolder } from '../jobs/types.ts'
import type { Enricher } from '../resolve/enricher.ts'
import { checkUrl } from '../resolve/input.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import type { SettingsStore } from '../settings/store.ts'

/** A whole set's refs (5,000 at most) with their display fields; design §2. */
export const DOWNLOAD_BODY_LIMIT_BYTES = 8 * 1024 * 1024
/** A bulk action names at most 5,000 job ids: about 200 KB. */
export const BULK_BODY_LIMIT_BYTES = 512 * 1024

export const SHUTTING_DOWN = 'DJ Scraper is shutting down'

export type DownloadsDeps = {
  queue: Queue
  settings: Pick<SettingsStore, 'rememberFolder'>
  enricher: Pick<Enricher, 'peek'>
  /** Finds yt-dlp, ffmpeg and ffprobe; throws StepError('engine_missing'). */
  locateEngine: () => Promise<EngineBins>
  /** The app data dir's real path: no download goes inside it. */
  dataDirReal: string
  /** `defaultDownloadFolder(homeDir)`: the only folder POST /downloads creates when it is missing. */
  defaultFolder: string
  /** Shows a finished file in Finder. Default `revealInFinder`. */
  reveal?: (file: string) => Promise<void>
  /** The folder checks' filesystem calls (tests script errors). */
  folderOps?: Partial<FolderOps>
  log?: Logger
}

/**
 * Why a ref marked unavailable fails at once (D4, D16): the wording of engine/ytdlp-errors.ts,
 * which the same failures get from a download.
 */
const UNAVAILABLE: Record<UnavailableReason, string> = {
  unavailable: 'Unavailable: removed or never existed.',
  private: 'Private: only its owner can see it.',
  geo_blocked: 'Not available in your country.',
  age_restricted: 'Age-restricted: needs browser cookies.',
  login_required: 'Needs a login.',
  preview_only: PREVIEW_ONLY.message,
}

const IdSchema = z.uuid()

/**
 * `/downloads…` (design §2, D16). The queue does the work and announces every change on the bus
 * (GET /api/events); these answer with what changed for the caller's immediate feedback.
 */
export const downloadRoutes = (deps: DownloadsDeps) => {
  const { queue, settings, enricher, log = console } = deps
  const reveal = deps.reveal ?? revealInFinder

  /** Mutations during shutdown: the queue starts nothing any more. */
  const open = (): void => {
    if (queue.closing) throw new ApiError('unknown', SHUTTING_DOWN, { status: 503 })
  }

  /** `:id`; anything but a UUID is no job of ours. */
  const jobId = (c: Context): string => {
    const id = c.req.param('id') ?? ''
    if (!IdSchema.safeParse(id).success) throw notFound()
    return id
  }

  return (
    new Hono()
      .post('/downloads', jsonBodyLimitOf(DOWNLOAD_BODY_LIMIT_BYTES), async (c) => {
        open()
        const request = await readJson(c, DownloadRequestSchema)
        // The cheap checks first (D16): with no engine or no folder, no job is created.
        await stepToApi(deps.locateEngine())
        const folder = await stepToApi(
          resolveTargetFolder(
            request.folder,
            request.options.subfolder,
            { dataDirReal: deps.dataDirReal, create: request.folder === deps.defaultFolder },
            deps.folderOps,
          ),
        )
        open()
        const response = queue.add(batchOf(request, folder), request.items.map(enqueueItem))
        await settings.rememberFolder(request.folder)
        return c.json(response satisfies CreateDownloadsResponse)
      })
      .get('/downloads', (c) => c.json(queue.snapshot() satisfies DownloadsSnapshot))
      // The bulk routes before `/:id/…`: Hono matches in order, and a bulk name is never a UUID.
      .post('/downloads/cancel', jsonBodyLimitOf(BULK_BODY_LIMIT_BYTES), async (c) => {
        open()
        const { target } = await readJson(c, CancelJobsRequestSchema)
        return c.json({ count: queue.cancelMany(target) } satisfies BulkJobsResponse)
      })
      .post('/downloads/retry', jsonBodyLimitOf(BULK_BODY_LIMIT_BYTES), async (c) => {
        open()
        const { target, statuses } = await readJson(c, RetryJobsRequestSchema)
        return c.json({ count: queue.retryMany(target, statuses) } satisfies BulkJobsResponse)
      })
      .post('/downloads/clear', jsonBodyLimitOf(BULK_BODY_LIMIT_BYTES), async (c) => {
        open()
        const { target } = await readJson(c, ClearJobsRequestSchema)
        return c.json({ count: queue.clear(target) } satisfies BulkJobsResponse)
      })
      .post('/downloads/:id/cancel', (c) => {
        const id = jobId(c)
        open()
        const job = queue.cancel(id)
        if (job === undefined) throw notFound()
        return c.json(job satisfies Job)
      })
      .post('/downloads/:id/retry', (c) => {
        const id = jobId(c)
        open()
        const job = queue.retry(id)
        if (job === undefined) throw notFound()
        if (job === 'not_retryable') {
          const status = queue.get(id)?.status
          throw new ApiError(
            'invalid_request',
            status === 'failed' || status === 'canceled'
              ? "This link can't be downloaded, so retrying won't help."
              : 'Only failed or canceled downloads can be retried.',
            { status: 409 },
          )
        }
        return c.json(job satisfies Job)
      })
      .post('/downloads/:id/reveal', async (c) => {
        const id = jobId(c)
        if (queue.get(id) === undefined) throw notFound()
        // The path comes from the job, never from the request.
        const file = queue.outputPathOf(id)
        if (file === undefined) throw new ApiError('not_found', 'This download has no file.')
        try {
          await reveal(file)
        } catch (error) {
          if (!(error instanceof StepError)) throw error
          log.info(`[downloads] ${id.slice(0, 8)}: reveal failed (${error.code})`)
          throw new ApiError(error.code, error.message)
        }
        return c.body(null, 204)
      })
  )

  /**
   * One item → what the queue makes of it: a job to run, or one that fails at once (D16) for a
   * refused URL, a list URL or a ref marked unavailable. Missing display fields come from the
   * enricher's cache.
   */
  function enqueueItem(ref: TrackRef): EnqueueItem {
    const checked = checkUrl(ref.url)
    if (!checked.ok) return { ref, input: undefined, refusal: checked.error }
    const { input } = checked
    const filled = withDisplayFields(ref, enricher.peek(input.platform, ref.id))
    if (input.guess === 'collection') return { ref: filled, input, refusal: LIST_URL }
    const unavailable = unavailableError(ref)
    if (unavailable !== undefined) return { ref: filled, input, refusal: unavailable }
    return { ref: filled, input }
  }
}

function batchOf(request: DownloadRequest, folder: TargetFolder) {
  return {
    folder,
    options: request.options,
    ...(request.label === undefined ? {} : { label: request.label }),
  }
}

/** A ref the client marked unavailable (a reason alone counts too); else undefined. */
function unavailableError(ref: TrackRef): ErrorInfo | undefined {
  if (ref.availability !== 'unavailable' && ref.unavailableReason === undefined) return undefined
  const code = ref.unavailableReason ?? 'unavailable'
  return { code, message: UNAVAILABLE[code] }
}

const DISPLAY_FIELDS = ['title', 'artist', 'uploader', 'durationSec', 'thumbnailUrl'] as const

/** The ref with the display fields it lacks taken from a cached lookup, where the contract allows. */
function withDisplayFields(ref: TrackRef, track: Track | undefined): TrackRef {
  if (track === undefined) return ref
  const filled: TrackRef = { ...ref }
  for (const key of DISPLAY_FIELDS) {
    if (ref[key] !== undefined || track[key] === undefined) continue
    const parsed = TrackRefSchema.shape[key].safeParse(track[key])
    if (parsed.success && parsed.data !== undefined) setField(filled, key, parsed.data)
  }
  return filled
}

function setField<K extends keyof TrackRef>(ref: TrackRef, key: K, value: TrackRef[K]): void {
  ref[key] = value
}

/** Awaits a step whose StepError is the answer (no engine, a folder that can't be used). */
async function stepToApi<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof StepError) throw new ApiError(error.code, error.message)
    throw error
  }
}

const notFound = () => new ApiError('not_found', 'No such download.')
