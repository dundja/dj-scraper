// When to ask again: the timing and failure rules of progressive enrichment (ADR-014).
import type { ErrorCode, ErrorInfo } from '@dj-scraper/shared'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-text.ts'

/** How long a scroll must rest before the rows in view are requested, so rows flying by aren't. */
export const ENRICH_DEBOUNCE_MS = 150

/**
 * A row that failed for a passing reason is asked for again this long after (when in view), the
 * wait doubling with each failure in a row up to ROW_RETRY_MAX_MS: a row that keeps failing the
 * same way (yt-dlp can't read it) mustn't spend SoundCloud's budget, which downloads share, every
 * 30 s for as long as it is in view.
 */
export const ROW_RETRY_MS = 30_000
export const ROW_RETRY_MAX_MS = 10 * 60_000

/** After a whole request failed for a passing reason: 2 s, doubling up to 30 s. */
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 30_000

/**
 * Row errors that may answer differently later: a rate limit lifts (the server pauses the platform
 * and answers at once meanwhile, spending no budget), network trouble passes, and `unknown` is
 * mostly yt-dlp tripping. A `canceled` row says nothing about the track (no response carries one
 * today). Every other code (removed, list URLs, bot checks) would come back the same.
 */
const RETRYABLE_ROW_CODES: ReadonlySet<ErrorCode> = new Set([
  'rate_limited',
  'network',
  'unknown',
  'canceled',
])

/**
 * When a row that failed with `code` at `now`, its `failures`-th failure in a row (1 or more), may
 * be asked for again: 30 s, 1 min, 2 min, … up to 10 min later. Infinity: never.
 */
export function rowRetryAt(code: ErrorCode, now: number, failures = 1): number {
  if (!RETRYABLE_ROW_CODES.has(code)) return Number.POSITIVE_INFINITY
  return now + Math.min(ROW_RETRY_MAX_MS, ROW_RETRY_MS * 2 ** Math.max(0, failures - 1))
}

/** The wait before the next request once `failures` (1 or more) requests in a row failed. */
export function requestBackoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * Whether a whole request failed for a passing reason, so its rows go back to pending and the next
 * request waits out a back-off: no answer from our server (down or restarting), a 5xx (503
 * `engine_missing`, or shutting down) or a 429. Anything else (a 4xx, an answer off the contract)
 * would fail the same way again, so its rows fail with it.
 */
export function isTransientRequestError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.kind === 'unreachable') return true
  const status = error.status ?? 0
  return error.kind === 'api' && (status >= 500 || status === 429)
}

/** A failed request as each of its rows shows it. */
export function requestErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof ApiError && error.code !== undefined) {
    return { code: error.code, message: error.message }
  }
  return { code: 'unknown', message: describeError(error)?.message ?? 'Something went wrong.' }
}
