// Which partial rows to ask for next: the ones in view, a few per request.
import {
  type CollectionEntry,
  type EntryRef,
  type ErrorInfo,
  MAX_URL_LENGTH,
} from '@dj-scraper/shared'
import { failedStatus, type LookupStatus } from './enrich-merge.ts'

/** Row indexes from `start` (inclusive) to `end` (exclusive). */
export type VisibleRange = { start: number; end: number }

/** Rows past each end of the visible range that are filled too, and kept while their request runs. */
export const ENRICH_OVERSCAN = 5

/** Until the table reports its range, the first screenful counts as visible. */
export const DEFAULT_VISIBLE_RANGE: VisibleRange = { start: 0, end: 15 }

/** One request at a time would do (the server paces SoundCloud); a second keeps a scroll moving. */
export const MAX_REQUESTS_IN_FLIGHT = 2

/**
 * Rows per request. The server answers a request once all its rows are looked up, at its pace
 * (SoundCloud: one a second, then one every 5 s), so a few rows per request fill the screen in as
 * they load instead of all at once; the second request in flight keeps the server busy meanwhile.
 * MAX_ENTRIES_PER_REQUEST (25) is only the server's cap.
 */
export const ENRICH_BATCH_SIZE = 4

/** The whole indexes of a list of `length` rows among `indexes`, in their order. */
export function indexesWithin(indexes: readonly number[], length: number): number[] {
  return indexes.filter((index) => Number.isInteger(index) && index >= 0 && index < length)
}

/** Whether two lists of indexes are the same, in the same order. */
export function sameIndexes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((index, i) => index === b[i])
}

/**
 * The rows to fill, in the order to ask for them: the visible rows top-down, then the overscan
 * below them (where a scroll usually goes), then the overscan above, nearest first.
 */
export function windowIndexes(
  range: VisibleRange,
  length: number,
  overscan = ENRICH_OVERSCAN,
): number[] {
  const start = Math.max(0, range.start)
  const end = Math.min(length, range.end)
  const indexes: number[] = []
  for (let index = start; index < end; index++) indexes.push(index)
  for (let index = end; index < Math.min(length, end + overscan); index++) indexes.push(index)
  for (let index = start - 1; index >= Math.max(0, start - overscan); index--) indexes.push(index)
  return indexes
}

/** A partial row as `POST /api/resolve/entries` takes it. */
export function entryRefOf(entry: CollectionEntry): EntryRef {
  return { platform: entry.platform, id: entry.id, url: entry.url }
}

const URL_TOO_LONG: ErrorInfo = {
  code: 'invalid_url',
  message: "This track's link is too long to look up.",
}

/**
 * How a partial row's lookup starts: pending, unless the request schema would refuse its URL
 * (a request with it would fail as a whole), so it fails for good at once.
 */
export function initialStatus(entry: CollectionEntry): LookupStatus | undefined {
  return entry.url.length > MAX_URL_LENGTH ? failedStatus(URL_TOO_LONG, 0) : undefined
}

/** Whether a lookup can be asked for at `now`: never asked yet, or failed and due again. */
export function isRequestable(status: LookupStatus | undefined, now: number): boolean {
  return status === undefined || (status.state === 'failed' && status.retryAt <= now)
}

/**
 * The next request: the first `max` distinct lookups among `candidates` (in priority order, one
 * per row in view) that `requestable` accepts. Duplicate rows share one lookup, asked for once.
 */
export function planBatch<T>(
  candidates: Iterable<T>,
  requestable: (lookup: T) => boolean,
  max = ENRICH_BATCH_SIZE,
): T[] {
  const batch = new Set<T>()
  for (const lookup of candidates) {
    if (batch.size >= max) break
    if (!batch.has(lookup) && requestable(lookup)) batch.add(lookup)
  }
  return [...batch]
}

/** The earliest time after `now` at which one of these failed lookups may be asked for again. */
export function nextRetryAt(
  statuses: Iterable<LookupStatus | undefined>,
  now: number,
): number | undefined {
  let next: number | undefined
  for (const status of statuses) {
    if (status?.state !== 'failed') continue
    const at = status.retryAt
    if (at > now && Number.isFinite(at) && (next === undefined || at < next)) next = at
  }
  return next
}
