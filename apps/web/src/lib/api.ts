import {
  ApiErrorBodySchema,
  type BulkJobsResponse,
  BulkJobsResponseSchema,
  type CancelJobsRequest,
  type ClearJobsRequest,
  type CreateDownloadsResponse,
  CreateDownloadsResponseSchema,
  type DownloadRequestSchema,
  type ErrorCode,
  type FolderPickRequest,
  type FolderPickResponse,
  FolderPickResponseSchema,
  type Health,
  HealthSchema,
  type Job,
  JobSchema,
  type ResolveEntriesRequestSchema,
  type ResolveEntriesResponse,
  ResolveEntriesResponseSchema,
  type ResolveRequestSchema,
  type ResolveResult,
  ResolveResultSchema,
  type RetryJobsRequestSchema,
  type Settings,
  SettingsSchema,
  type SettingsUpdate,
} from '@dj-scraper/shared'
import type * as z from 'zod'

/**
 * - `api`: the server answered with an error body (`status` and `code` are set).
 * - `unreachable`: no answer from our server: the request failed, or something else replied
 *   (in dev, Vite 8's proxy answers 502 text/plain while the server is down).
 * - `invalid_response`: a success whose body doesn't match the shared schema (contract drift).
 */
export type ApiErrorKind = 'api' | 'unreachable' | 'invalid_response'

type ApiErrorInit =
  | { kind: 'api'; status: number; code: ErrorCode; message: string }
  | { kind: 'unreachable'; status?: number; message: string; cause?: unknown }
  | { kind: 'invalid_response'; status: number; message: string; cause?: unknown }

/** Every failure of an API call except an abort, which propagates as the AbortSignal's reason. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly kind: ApiErrorKind
  /** The HTTP status, when a response arrived. */
  readonly status: number | undefined
  /** The server's error code; set exactly when `kind` is 'api'. */
  readonly code: ErrorCode | undefined

  constructor(init: ApiErrorInit) {
    super(init.message, 'cause' in init ? { cause: init.cause } : undefined)
    this.kind = init.kind
    this.status = init.status
    this.code = init.kind === 'api' ? init.code : undefined
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

type RequestOptions = {
  method?: Method
  /** Serialized as JSON. */
  body?: unknown
  signal?: AbortSignal | undefined
}

const UNREACHABLE = "Can't reach the DJ Scraper server."

/**
 * Calls our API at a same-origin `/api` path and returns a success's status and body text; a
 * failure throws an ApiError. Every non-GET sends Content-Type: application/json, even without a
 * body: the server refuses other mutations (415), which keeps cross-site pages from driving it.
 */
async function send(
  path: `/${string}`,
  { method = 'GET', body, signal }: RequestOptions,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') headers['Content-Type'] = 'application/json'
  const init: RequestInit = { method, headers, signal: signal ?? null }
  if (body !== undefined) init.body = JSON.stringify(body)

  let response: Response
  let text: string
  try {
    response = await fetch(`/api${path}`, init)
    text = await response.text()
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError({ kind: 'unreachable', message: UNREACHABLE, cause: error })
  }

  if (!response.ok) {
    const failure = ApiErrorBodySchema.safeParse(parseJson(text))
    if (!failure.success) {
      throw new ApiError({ kind: 'unreachable', status: response.status, message: UNREACHABLE })
    }
    const { code, message } = failure.data.error
    throw new ApiError({ kind: 'api', status: response.status, code, message })
  }
  return { status: response.status, text }
}

/** `send`, then validates the success body with `schema`. */
async function request<S extends z.ZodType>(
  path: `/${string}`,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const { status, text } = await send(path, options)
  const result = schema.safeParse(parseJson(text))
  if (!result.success) {
    throw new ApiError({
      kind: 'invalid_response',
      status,
      message: unexpected(options, path),
      cause: result.error,
    })
  }
  return result.data
}

/** `send` for a route that answers 204 No Content; any other success is contract drift. */
async function requestNoContent(path: `/${string}`, options: RequestOptions): Promise<void> {
  const { status } = await send(path, options)
  if (status !== 204) {
    throw new ApiError({ kind: 'invalid_response', status, message: unexpected(options, path) })
  }
}

const unexpected = ({ method = 'GET' }: RequestOptions, path: string) =>
  `Unexpected response from ${method} /api${path}.`

/** The parsed body, or undefined when it isn't JSON (the schemas then reject it). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `/downloads/<id>/<action>`, with the id kept to one path segment. */
const jobPath = (id: string, action: 'cancel' | 'retry' | 'reveal') =>
  `/downloads/${encodeURIComponent(id)}/${action}` as const

/**
 * The typed API. Jobs are not listed here: the event stream (`lib/events.ts`) is the only writer of
 * the downloads cache, and the job answers below are for immediate feedback only.
 */
export const api = {
  /** The engine check; the server caches it for up to 10 minutes. */
  health: (signal?: AbortSignal): Promise<Health> => request('/health', HealthSchema, { signal }),
  /** Probes the engine again now, e.g. after installing yt-dlp. */
  recheckHealth: (signal?: AbortSignal): Promise<Health> =>
    request('/health/recheck', HealthSchema, { method: 'POST', signal }),
  /**
   * What a pasted URL is: a track, a collection, or `ambiguous` for `watch?v=…&list=…` in `auto`
   * mode. Leave `mode` out for `auto`: the body omits it and the server defaults it.
   */
  resolve: (
    body: z.input<typeof ResolveRequestSchema>,
    signal?: AbortSignal,
  ): Promise<ResolveResult> =>
    request('/resolve', ResolveResultSchema, { method: 'POST', body, signal }),
  /** Full Tracks for the partial collection rows in view; each row succeeds or fails on its own. */
  resolveEntries: (
    body: z.input<typeof ResolveEntriesRequestSchema>,
    signal?: AbortSignal,
  ): Promise<ResolveEntriesResponse> =>
    request('/resolve/entries', ResolveEntriesResponseSchema, { method: 'POST', body, signal }),

  /**
   * Queues one job per distinct track; `jobIds` maps each item to its job. The server also adds
   * the folder to `recentFolders`, so the caller invalidates the `['settings']` query on success.
   */
  createDownloads: (
    body: z.input<typeof DownloadRequestSchema>,
    signal?: AbortSignal,
  ): Promise<CreateDownloadsResponse> =>
    request('/downloads', CreateDownloadsResponseSchema, { method: 'POST', body, signal }),
  /** A queued job ends canceled; a running one comes back with `cancelRequested` until it stops. */
  cancelDownload: (id: string, signal?: AbortSignal): Promise<Job> =>
    request(jobPath(id, 'cancel'), JobSchema, { method: 'POST', signal }),
  /** Queues a failed or canceled job again (409 `invalid_request` for any other status). */
  retryDownload: (id: string, signal?: AbortSignal): Promise<Job> =>
    request(jobPath(id, 'retry'), JobSchema, { method: 'POST', signal }),
  /** Shows the job's file in Finder; 404 `not_found` when there is none (any more). */
  revealDownload: (id: string, signal?: AbortSignal): Promise<void> =>
    requestNoContent(jobPath(id, 'reveal'), { method: 'POST', signal }),
  /** Cancels the queued and running jobs in scope; the changes arrive as events. */
  cancelDownloads: (body: CancelJobsRequest, signal?: AbortSignal): Promise<BulkJobsResponse> =>
    request('/downloads/cancel', BulkJobsResponseSchema, { method: 'POST', body, signal }),
  /** Retries the jobs in scope with these statuses (default failed), skipping hopeless failures. */
  retryDownloads: (
    body: z.input<typeof RetryJobsRequestSchema>,
    signal?: AbortSignal,
  ): Promise<BulkJobsResponse> =>
    request('/downloads/retry', BulkJobsResponseSchema, { method: 'POST', body, signal }),
  /** Removes the finished jobs in scope from the list. */
  clearDownloads: (body: ClearJobsRequest, signal?: AbortSignal): Promise<BulkJobsResponse> =>
    request('/downloads/clear', BulkJobsResponseSchema, { method: 'POST', body, signal }),

  getSettings: (signal?: AbortSignal): Promise<Settings> =>
    request('/settings', SettingsSchema, { signal }),
  /** Changes only the fields given and returns the settings as saved. */
  updateSettings: (body: SettingsUpdate, signal?: AbortSignal): Promise<Settings> =>
    request('/settings', SettingsSchema, { method: 'PUT', body, signal }),
  /**
   * Opens the macOS folder picker on the server's Mac and waits for the user (up to 5 minutes).
   * Aborting closes the dialog. 409 `invalid_request` while another pick is open.
   */
  pickFolder: (body: FolderPickRequest = {}, signal?: AbortSignal): Promise<FolderPickResponse> =>
    request('/folders/pick', FolderPickResponseSchema, { method: 'POST', body, signal }),
}
