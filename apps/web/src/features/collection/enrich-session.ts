// Progressive enrichment of one collection's partial rows (ADR-014): the rows in view are looked up
// through POST /api/resolve/entries, a few per request, and requests for rows that scrolled away
// are canceled. Kept outside React; useEnrichment binds it to the table.
import type { CollectionEntry, EntryRef, ResolveEntriesResponse } from '@dj-scraper/shared'
import { type TrackKey, trackKey } from '@/features/downloads/track-ref.ts'
import { api } from '@/lib/api.ts'
import {
  type EnrichedRow,
  failedStatus,
  LOADING,
  type LookupStatus,
  lookupStatusOf,
  NO_RESULT,
  rowFor,
} from './enrich-merge.ts'
import {
  DEFAULT_VISIBLE_RANGE,
  entryRefOf,
  indexesWithin,
  initialStatus,
  isRequestable,
  MAX_REQUESTS_IN_FLIGHT,
  nextRetryAt,
  planBatch,
  sameIndexes,
  windowIndexes,
} from './enrich-plan.ts'
import {
  ENRICH_DEBOUNCE_MS,
  isTransientRequestError,
  requestBackoffMs,
  requestErrorInfo,
} from './enrich-retry.ts'

/** The lookup of one partial track. Duplicate rows (same platform + id) share it. */
type Lookup = {
  key: TrackKey
  ref: EntryRef
  /** The rows it fills. */
  rows: { index: number; entry: CollectionEntry }[]
  /** Undefined while pending. */
  status: LookupStatus | undefined
  /** Its answers that failed in a row, for the retry's back-off (aborts and outages don't count). */
  failures: number
}

type Batch = { lookups: Lookup[]; controller: AbortController }

export type EnrichSession = {
  /** The rows as they stand: a new array after each change, unchanged rows keeping their identity. */
  getRows: () => readonly EnrichedRow[]
  subscribe: (listener: () => void) => () => void
  /**
   * Starts filling the rows in view once the debounce has passed; again after stop(). Until the
   * table reports them (`undefined`), the first screenful and its overscan count.
   */
  start: (inView: readonly number[] | undefined) => void
  /** Aborts every request and clears every timer; the rows it asked for are pending again. */
  stop: () => void
  /**
   * The rows in view: the collection indexes the table shows plus its overscan, in the order to ask
   * for them (see rowsInView). With a filter on, the rows it hides are never among them.
   */
  setRowsInView: (indexes: readonly number[]) => void
}

/**
 * Timing runs on a monotonic clock, so a wall-clock change can't stall a back-off or a retry (the
 * server's limiter does the same).
 */
const monotonicNow = () => performance.now()

const isHidden = () => document.visibilityState === 'hidden'

/**
 * A session for one entries array; it does nothing until start(). Requests of a few rows go out
 * ~150 ms after the rows in view last changed, at most 2 at a time. A request none of whose rows is
 * in view (or the overscan) any more is aborted (silently: its rows are pending again). Rows that
 * fail on their own for a passing reason are asked for again after 30 s, then 1 min, 2 min, … up
 * to 10 min, once in view, and not while the tab is hidden; a failed request (server down, 503)
 * puts its rows back and backs off.
 */
export function createEnrichSession(entries: readonly CollectionEntry[]): EnrichSession {
  const lookups = new Map<TrackKey, Lookup>()
  const lookupAt = entries.map((entry, index): Lookup | undefined => {
    if (!entry.partial) return undefined
    const key = trackKey(entry)
    let lookup = lookups.get(key)
    if (lookup === undefined) {
      lookup = { key, ref: entryRefOf(entry), rows: [], status: initialStatus(entry), failures: 0 }
      lookups.set(key, lookup)
    }
    lookup.rows.push({ index, entry })
    return lookup
  })
  let rows: readonly EnrichedRow[] = entries.map((entry, index) => {
    const lookup = lookupAt[index]
    return lookup === undefined ? { entry, state: 'ready' } : rowFor(entry, lookup.status)
  })

  const listeners = new Set<() => void>()
  const batches = new Set<Batch>()
  let active = false
  let inView: readonly number[] = []
  /** Requests failed in a row, for the back-off; and no request goes out before `blockedUntil`. */
  let requestFailures = 0
  let blockedUntil = 0
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let wakeTimer: ReturnType<typeof setTimeout> | undefined

  /** Rebuilds the rows of these lookups (every other row keeps its identity) and tells subscribers. */
  const refresh = (changed: readonly Lookup[]) => {
    if (changed.length === 0) return
    const next = rows.slice()
    for (const lookup of changed) {
      for (const { index, entry } of lookup.rows) next[index] = rowFor(entry, lookup.status)
    }
    rows = next
    for (const listener of listeners) listener()
  }

  /** The lookups of the rows in view plus overscan, in the order to ask for them (with repeats). */
  const lookupsInView = (): Lookup[] => inView.flatMap((index) => lookupAt[index] ?? [])

  const plan = () => {
    if (!active) return
    const now = monotonicNow()
    if (now < blockedUntil) {
      wakeAt(blockedUntil, now)
      return
    }
    const candidates = lookupsInView()
    const sent: Lookup[] = []
    while (batches.size < MAX_REQUESTS_IN_FLIGHT) {
      const batch = planBatch(candidates, (lookup) => isRequestable(lookup.status, now))
      if (batch.length === 0) break
      send(batch)
      sent.push(...batch)
    }
    refresh(sent)
    const statuses = candidates.map((lookup) => lookup.status)
    wakeAt(nextRetryAt(statuses, now), now)
  }

  /**
   * Plans again at `at` (for a retry or the end of a back-off), replacing any earlier wake-up. A
   * hidden tab sets none: showing it plans again (onVisibilityChange).
   */
  const wakeAt = (at: number | undefined, now: number) => {
    clearTimeout(wakeTimer)
    wakeTimer = at === undefined || isHidden() ? undefined : setTimeout(wake, at - now)
  }
  const onVisibilityChange = () => {
    if (!isHidden()) planUnlessScrolling()
  }
  const wake = () => {
    wakeTimer = undefined
    planUnlessScrolling()
  }
  /** While a scroll goes on, its debounce plans for wherever it stops. */
  const planUnlessScrolling = () => {
    if (debounceTimer === undefined) plan()
  }
  const debounced = () => {
    debounceTimer = undefined
    plan()
  }
  const debounce = () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(debounced, ENRICH_DEBOUNCE_MS)
  }

  const send = (batchLookups: Lookup[]) => {
    const batch: Batch = { lookups: batchLookups, controller: new AbortController() }
    batches.add(batch)
    for (const lookup of batchLookups) lookup.status = LOADING
    const body = { entries: batchLookups.map((lookup) => lookup.ref) }
    api.resolveEntries(body, batch.controller.signal).then(
      (response) => settle(batch, response),
      (error: unknown) => fail(batch, error),
    )
  }

  const settle = (batch: Batch, { results }: ResolveEntriesResponse) => {
    // An aborted batch's rows are pending again, maybe already in another request.
    if (!batches.delete(batch)) return
    requestFailures = 0
    blockedUntil = 0
    const now = monotonicNow()
    const byKey = new Map(results.map((result) => [trackKey(result), result]))
    for (const lookup of batch.lookups) {
      const result = byKey.get(lookup.key)
      const failures = lookup.failures + 1
      lookup.status =
        result === undefined
          ? failedStatus(NO_RESULT, now, failures)
          : lookupStatusOf(result, now, failures)
      lookup.failures = lookup.status.state === 'failed' ? failures : 0
    }
    refresh(batch.lookups)
    planUnlessScrolling()
  }

  const fail = (batch: Batch, error: unknown) => {
    // Our own abort: silent, its rows are already pending again.
    if (!batches.delete(batch)) return
    const now = monotonicNow()
    if (isTransientRequestError(error)) {
      // A request that fails during a back-off belongs to the same outage: no longer wait.
      if (now >= blockedUntil) {
        requestFailures++
        blockedUntil = now + requestBackoffMs(requestFailures)
      }
      for (const lookup of batch.lookups) lookup.status = undefined
    } else {
      const info = requestErrorInfo(error)
      for (const lookup of batch.lookups) {
        lookup.failures++
        lookup.status = failedStatus(info, now, lookup.failures)
      }
    }
    refresh(batch.lookups)
    planUnlessScrolling()
  }

  /** Aborts `batch`; returns its lookups, pending again. */
  const abort = (batch: Batch): Lookup[] => {
    batches.delete(batch)
    batch.controller.abort()
    for (const lookup of batch.lookups) lookup.status = undefined
    return batch.lookups
  }

  /** Aborts the requests none of whose rows are in view (or the overscan) any more. */
  const abortOutOfView = () => {
    if (batches.size === 0) return
    const inView = new Set(lookupsInView())
    const released: Lookup[] = []
    for (const batch of batches) {
      if (!batch.lookups.some((lookup) => inView.has(lookup))) released.push(...abort(batch))
    }
    refresh(released)
  }

  return {
    getRows: () => rows,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start(rowsInView) {
      if (active) return
      active = true
      inView = indexesWithin(
        rowsInView ?? windowIndexes(DEFAULT_VISIBLE_RANGE, entries.length),
        entries.length,
      )
      if (lookups.size === 0) return
      document.addEventListener('visibilitychange', onVisibilityChange)
      debounce()
    },
    stop() {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearTimeout(debounceTimer)
      clearTimeout(wakeTimer)
      debounceTimer = undefined
      wakeTimer = undefined
      refresh([...batches].flatMap(abort))
    },
    setRowsInView(indexes) {
      const next = indexesWithin(indexes, entries.length)
      if (sameIndexes(next, inView)) return
      inView = next
      if (!active || lookups.size === 0) return
      abortOutOfView()
      debounce()
    },
  }
}
