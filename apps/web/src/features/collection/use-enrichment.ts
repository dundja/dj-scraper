import type { CollectionEntry } from '@dj-scraper/shared'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { EnrichedRow } from './enrich-merge.ts'
import { createEnrichSession, type EnrichSession } from './enrich-session.ts'

export type { EnrichedRow, RowState } from './enrich-merge.ts'

/**
 * Progressive fill-in of partial rows (SoundCloud set entries come with only id + url): the rows in
 * view are looked up through `POST /api/resolve/entries` as the table scrolls (see
 * createEnrichSession for the pacing, cancellation and retries).
 *
 * - `rows`: same length and order as `entries`; a partial entry is replaced by its full Track
 *   (`partial: false`) once enriched, or marked unavailable when the lookup says so. A row that
 *   didn't change keeps its identity, so a memoized table row skips the render.
 * - `setRowsInView`: the collection indexes the table shows plus its overscan, in the order to ask
 *   for them (rowsInView in rows.ts), from an effect (not while rendering). Stable. Until it is
 *   called, the first screenful counts.
 *
 * A new `entries` array (another collection) starts over; unmounting aborts every request.
 */
export function useEnrichment(entries: readonly CollectionEntry[]): {
  rows: readonly EnrichedRow[]
  setRowsInView: (indexes: readonly number[]) => void
} {
  const session = useMemo(() => createEnrichSession(entries), [entries])
  const rows = useSyncExternalStore(session.subscribe, session.getRows)
  // The table can report its rows before the session starts (the virtualizer measures in a layout
  // effect), and the last ones carry over to the next collection.
  const inView = useRef<readonly number[] | undefined>(undefined)
  const started = useRef<EnrichSession | undefined>(undefined)

  useEffect(() => {
    started.current = session
    session.start(inView.current)
    return () => {
      started.current = undefined
      session.stop()
    }
  }, [session])

  const setRowsInView = useCallback((indexes: readonly number[]) => {
    inView.current = indexes
    started.current?.setRowsInView(indexes)
  }, [])

  return { rows, setRowsInView }
}
