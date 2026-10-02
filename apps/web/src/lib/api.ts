import { ApiErrorBodySchema, type ErrorCode, type Health, HealthSchema } from '@dj-scraper/shared'
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
 * Calls our API at a same-origin `/api` path and validates the success body with `schema`.
 * Every non-GET sends Content-Type: application/json, even without a body: the server refuses
 * other mutations (415), which keeps cross-site pages from driving it.
 */
async function request<S extends z.ZodType>(
  path: `/${string}`,
  schema: S,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<z.output<S>> {
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

  const json = parseJson(text)
  if (!response.ok) {
    const failure = ApiErrorBodySchema.safeParse(json)
    if (!failure.success) {
      throw new ApiError({ kind: 'unreachable', status: response.status, message: UNREACHABLE })
    }
    const { code, message } = failure.data.error
    throw new ApiError({ kind: 'api', status: response.status, code, message })
  }
  const result = schema.safeParse(json)
  if (!result.success) {
    throw new ApiError({
      kind: 'invalid_response',
      status: response.status,
      message: `Unexpected response from ${method} /api${path}.`,
      cause: result.error,
    })
  }
  return result.data
}

/** The parsed body, or undefined when it isn't JSON (the schemas then reject it). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const api = {
  /** The engine check; the server caches it for up to 10 minutes. */
  health: (signal?: AbortSignal): Promise<Health> => request('/health', HealthSchema, { signal }),
  /** Probes the engine again now, e.g. after installing yt-dlp. */
  recheckHealth: (signal?: AbortSignal): Promise<Health> =>
    request('/health/recheck', HealthSchema, { method: 'POST', signal }),
}
