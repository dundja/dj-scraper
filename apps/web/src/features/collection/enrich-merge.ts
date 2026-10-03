// What a lookup says about a partial row, and the row the table shows for it.
import {
  type CollectionEntry,
  type EntryResult,
  type ErrorInfo,
  type UnavailableReason,
  UnavailableReasonSchema,
} from '@dj-scraper/shared'
import { rowRetryAt } from './enrich-retry.ts'

/**
 * - `ready`: nothing (more) to load: a complete row, a filled one, or one found unavailable.
 * - `pending`: partial, not asked for yet (or its request was canceled).
 * - `loading`: partial, in a request.
 * - `failed`: partial, its lookup failed; it stays downloadable and may be asked for again.
 */
export type RowState = 'ready' | 'pending' | 'loading' | 'failed'

/**
 * A collection row as the table shows it. `error` says why the lookup failed (`failed`), or why the
 * track can't be downloaded when the lookup found it unavailable.
 */
export type EnrichedRow = { entry: CollectionEntry; state: RowState; error?: ErrorInfo }

/**
 * How the lookup of one partial track stands (none yet: pending).
 * - `filled`: the full track, merged into each of its rows.
 * - `unavailable`: the lookup says the track can't be downloaded (removed, private, …).
 * - `failed`: no usable answer; ask again from `retryAt` (Infinity: the answer won't change).
 */
export type LookupStatus =
  | { state: 'loading' }
  | { state: 'filled'; entry: CollectionEntry }
  | { state: 'unavailable'; reason: UnavailableReason; error: ErrorInfo }
  | { state: 'failed'; error: ErrorInfo; retryAt: number }

export const LOADING: LookupStatus = { state: 'loading' }

/** A requested row the response left out: contract drift, so try again later like `unknown`. */
export const NO_RESULT: ErrorInfo = {
  code: 'unknown',
  message: 'The server sent no details for this track.',
}

/** A lookup that failed with `error` at `now`, its `failures`-th failure in a row (see rowRetryAt). */
export function failedStatus(error: ErrorInfo, now: number, failures = 1): LookupStatus {
  return { state: 'failed', error, retryAt: rowRetryAt(error.code, now, failures) }
}

/**
 * The status a result gives its row, which the result names by the request's platform + id;
 * `failures` counts this one if it fails (see rowRetryAt).
 * - `ok`: the full track replaces the row (`partial: false`, the page URL instead of an API URL),
 *   keeping the row's platform + id: selection and job badges are keyed by them.
 * - An unavailable-type error (removed, private, geo-blocked, age-restricted, login, Go+ preview)
 *   marks the row unavailable; any other error fails it (see `rowRetryAt`).
 */
export function lookupStatusOf(result: EntryResult, now: number, failures = 1): LookupStatus {
  if (result.status === 'ok') {
    const { platform, id } = result
    return { state: 'filled', entry: { ...result.track, platform, id, partial: false } }
  }
  const reason = UnavailableReasonSchema.safeParse(result.error.code)
  if (reason.success) return { state: 'unavailable', reason: reason.data, error: result.error }
  return failedStatus(result.error, now, failures)
}

/** The row for a partial `entry` whose lookup stands at `status`. */
export function rowFor(entry: CollectionEntry, status: LookupStatus | undefined): EnrichedRow {
  if (status === undefined) return { entry, state: 'pending' }
  switch (status.state) {
    case 'loading':
      return { entry, state: 'loading' }
    case 'filled':
      return { entry: status.entry, state: 'ready' }
    case 'unavailable':
      return {
        entry: { ...entry, availability: 'unavailable', unavailableReason: status.reason },
        state: 'ready',
        error: status.error,
      }
    case 'failed':
      return { entry, state: 'failed', error: status.error }
  }
}
