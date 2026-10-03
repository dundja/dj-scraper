// Test helpers for the collection view: a viewport for the virtualizer in jsdom, and a stand-in for
// useEnrichment that tests drive row by row. Tests only; runtime code never imports this.
import type { CollectionEntry, Track } from '@dj-scraper/shared'
import { act, fireEvent, screen } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { onTestFinished, vi } from 'vitest'
import { ROW_HEIGHT } from './table-layout.ts'
import type { EnrichedRow } from './use-enrichment.ts'

/**
 * jsdom lays nothing out, so the virtualizer would see a 0 px tall list and render no row. Until
 * the test ends, every element is `rows` rows tall (and 800 px wide) with content as tall as its
 * first child's inline height (the list's sizer), `scrollTo` (which jsdom lacks) scrolls the
 * element and fires `scroll` like a browser, and `scrollIntoView` (which it lacks too) is the
 * returned spy, doing nothing.
 */
export function stubTableViewport(rows: number) {
  const height = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockReturnValue(rows * ROW_HEIGHT)
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  const clientHeight = vi
    .spyOn(Element.prototype, 'clientHeight', 'get')
    .mockReturnValue(rows * ROW_HEIGHT)
  const scrollHeight = vi
    .spyOn(Element.prototype, 'scrollHeight', 'get')
    .mockImplementation(function scrollHeight(this: Element) {
      const sizer = this.firstElementChild
      return sizer instanceof HTMLElement ? Number.parseFloat(sizer.style.height) || 0 : 0
    })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: function scrollTo(this: HTMLElement, options?: ScrollToOptions) {
      // Like a browser, no scroll event when the position stays.
      const top = options?.top
      if (top === undefined || top === this.scrollTop) return
      this.scrollTop = top
      this.dispatchEvent(new Event('scroll'))
    },
  })
  const scrollIntoView = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>()
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  })
  onTestFinished(() => {
    for (const spy of [height, width, clientHeight, scrollHeight]) spy.mockRestore()
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })
  return { scrollIntoView }
}

/** The track table's scrolling list (the rowgroup after the header's). */
export function trackList(): HTMLElement {
  const list = screen
    .getByRole('table', { name: 'Tracks' })
    .querySelector('[data-slot="track-list"]')
  if (!(list instanceof HTMLElement)) throw new Error('No track list')
  return list
}

/**
 * Scrolls the track list so that row `position` (of the shown rows) is at the top, and lets the
 * scroll end (the virtualizer notices that 150 ms after the last scroll event).
 */
export async function scrollToRow(position: number) {
  const list = trackList()
  list.scrollTop = position * ROW_HEIGHT
  fireEvent.scroll(list)
  await scrollEnd()
}

/** Waits, inside act(), until the virtualizer counts the last scroll as over. */
export function scrollEnd() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)))
}

const store = {
  rows: undefined as readonly EnrichedRow[] | undefined,
  listeners: new Set<() => void>(),
}

function subscribe(listener: () => void) {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

/** What the fake's `setRowsInView` was called with. */
export const setRowsInView = vi.fn<(indexes: readonly number[]) => void>()

const initialRowsOf = new WeakMap<readonly CollectionEntry[], readonly EnrichedRow[]>()

/**
 * The rows enrichment starts from: partial rows pending, the others ready. The same row objects
 * for the same entries, so `rowsWith` keeps the rows it doesn't change, as useEnrichment does.
 */
export function initialRows(entries: readonly CollectionEntry[]): EnrichedRow[] {
  let rows = initialRowsOf.get(entries)
  if (rows === undefined) {
    rows = entries.map((entry) => ({ entry, state: entry.partial ? 'pending' : 'ready' }))
    initialRowsOf.set(entries, rows)
  }
  return rows.slice()
}

/** A row enrichment filled in with its full Track. */
export function readyRow(track: Track): EnrichedRow {
  return { entry: { ...track, partial: false }, state: 'ready' }
}

/** `initialRows(entries)` with the rows at some indexes replaced, e.g. `{ 2: readyRow(track) }`. */
export function rowsWith(
  entries: readonly CollectionEntry[],
  changes: Readonly<Record<number, EnrichedRow>>,
): EnrichedRow[] {
  return initialRows(entries).map((row, index) => changes[index] ?? row)
}

/**
 * Stands in for useEnrichment (`vi.mocked(useEnrichment).mockImplementation(useFakeEnrichment)`):
 * its rows are `initialRows(entries)` until the test calls `enrich`.
 */
export function useFakeEnrichment(entries: readonly CollectionEntry[]) {
  const initial = useMemo(() => initialRows(entries), [entries])
  const rows = useSyncExternalStore(subscribe, () => store.rows ?? initial)
  return { rows, setRowsInView }
}

/** Replaces the fake's rows, as enrichment filling rows in would. */
export function enrich(rows: readonly EnrichedRow[]) {
  act(() => {
    store.rows = rows
    for (const listener of store.listeners) listener()
  })
}

/** Starts the fake over; call it before each test. */
export function resetFakeEnrichment() {
  store.rows = undefined
  setRowsInView.mockClear()
}
