import type { CollectionEntry, ErrorInfo } from '@dj-scraper/shared'
import { type TrackKey, trackKey } from '@/features/downloads/track-ref.ts'
import { windowIndexes } from './enrich-plan.ts'
import type { SelectableRow } from './selection.ts'
import type { EnrichedRow, RowState } from './use-enrichment.ts'

// The collection table's rows: what useEnrichment gives, plus what selection and the filter need,
// computed once per change of the rows rather than per render.

export type TableRow = SelectableRow & {
  /** The full Track once enriched, else the listed row (partial: id and url only). */
  entry: CollectionEntry
  state: RowState
  /** Why loading the row's details failed (`state: 'failed'`). */
  error?: ErrorInfo
}

// useEnrichment keeps a row's object while it doesn't change, and so does tableRows: a memoized
// table row then skips the render when another row fills in.
const tableRowCache = new WeakMap<EnrichedRow, TableRow>()

export function tableRows(rows: readonly EnrichedRow[]): TableRow[] {
  return rows.map((row, index) => {
    const cached = tableRowCache.get(row)
    if (cached?.index === index) return cached
    const { entry, state, error } = row
    const tableRow: TableRow = {
      index,
      key: trackKey(entry),
      selectable: entry.availability !== 'unavailable',
      entry,
      state,
      ...(error === undefined ? {} : { error }),
    }
    tableRowCache.set(row, tableRow)
    return tableRow
  })
}

/** Letters with no decomposition to strip an accent from, as a reader would type them. */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
}
const UNDECOMPOSED_LETTERS = /[øæœßłđðþı]/g

/**
 * `text` folded for matching: decomposed, without accents and other combining marks, lower case,
 * and the letters that don't decompose spelled out. "Água Viva" → "agua viva", "Røyksopp" →
 * "royksopp", "Straße" → "strasse".
 */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(UNDECOMPOSED_LETTERS, (letter) => LETTER_FOLDS[letter] ?? letter)
}

// Rows keep their entry until it is enriched, so a fold is computed once per entry, not per keystroke.
const searchTexts = new WeakMap<CollectionEntry, string>()

/** Title, artist and uploader, folded: what the filter searches. */
function searchText(entry: CollectionEntry): string {
  let text = searchTexts.get(entry)
  if (text === undefined) {
    text = foldText([entry.title, entry.artist, entry.uploader].filter(Boolean).join(' '))
    searchTexts.set(entry, text)
  }
  return text
}

/**
 * The rows whose title, artist or uploader contain every word of `query`, ignoring case and accents
 * ("kollektiv tidal" finds "Tidal Drift" by Kollektiv Nord). A blank query returns `rows` itself.
 * Rows without details yet (partial) have nothing to match until they are enriched.
 */
export function filterRows<Row extends TableRow>(
  rows: readonly Row[],
  query: string,
): readonly Row[] {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return rows
  return rows.filter((row) => {
    const text = searchText(row.entry)
    return words.every((word) => text.includes(word))
  })
}

/** The first row of each selected track, in table order: what "Download N tracks" sends. */
export function selectedInOrder<Row extends SelectableRow>(
  rows: readonly Row[],
  selected: ReadonlySet<TrackKey>,
): Row[] {
  const seen = new Set<TrackKey>()
  return rows.filter((row) => {
    if (!selected.has(row.key) || seen.has(row.key)) return false
    seen.add(row.key)
    return true
  })
}

export type SelectionSummary = {
  /** Selected tracks; rows sharing a track count once. */
  count: number
  /** Their summed duration in seconds, of those whose duration is known. */
  durationSec: number
  /** Selected tracks without a known duration (not loaded yet, or a past live stream). */
  withoutDuration: number
}

export function summarize(
  rows: readonly TableRow[],
  selected: ReadonlySet<TrackKey>,
): SelectionSummary {
  const summary: SelectionSummary = { count: 0, durationSec: 0, withoutDuration: 0 }
  for (const row of selectedInOrder(rows, selected)) {
    summary.count++
    const duration = row.entry.durationSec
    if (duration === undefined || duration === 0) summary.withoutDuration++
    else summary.durationSec += duration
  }
  return summary
}

/**
 * The rows in view for useEnrichment, as collection indexes in the order to look them up: the shown
 * rows at positions `startIndex` to `endIndex` (both inclusive, as the virtualizer's range gives
 * them) top-down, then the next shown rows below, then those above, nearest first (the overscan).
 * With a filter on, only shown rows count: a row the filter hides is never in view, however close
 * its index, so it isn't looked up. Nothing shown: none.
 */
export function rowsInView(
  rows: readonly SelectableRow[],
  startIndex: number,
  endIndex: number,
): number[] {
  return windowIndexes({ start: startIndex, end: endIndex + 1 }, rows.length).flatMap(
    (position) => rows[position]?.index ?? [],
  )
}
