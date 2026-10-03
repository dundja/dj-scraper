import type { CollectionEntry } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { type TrackKey, trackKey } from '@/features/downloads/track-ref.ts'
import {
  bigPlaylist,
  PLAYLIST_SPECIAL_ROWS,
  playlist,
  SC_SET_FULL_ROWS,
  scSet,
} from '@/test/resolve.ts'
import {
  filterRows,
  foldText,
  rowsInView,
  selectedInOrder,
  summarize,
  type TableRow,
  tableRows,
} from './rows.ts'
import type { EnrichedRow } from './use-enrichment.ts'

const ready = (entries: readonly CollectionEntry[]): EnrichedRow[] =>
  entries.map((entry) => ({ entry, state: entry.partial ? 'pending' : 'ready' }))

const playlistRows = tableRows(ready(playlist.entries))

const titles = (rows: readonly TableRow[]) => rows.map((row) => row.entry.title)

describe('tableRows', () => {
  it('keys each row by platform and id, and marks unavailable rows unselectable', () => {
    expect(playlistRows).toHaveLength(30)
    const [first] = playlistRows
    expect(first).toMatchObject({ index: 0, key: 'youtube:djRow000000', selectable: true })
    expect(first?.state).toBe('ready')
    expect(playlistRows[PLAYLIST_SPECIAL_ROWS.privateVideo]?.selectable).toBe(false)
    expect(playlistRows[PLAYLIST_SPECIAL_ROWS.deletedVideo]?.selectable).toBe(false)
    // `unknown` availability is normal in flat listings: selectable.
    expect(playlistRows[1]?.entry.availability).toBe('unknown')
    expect(playlistRows[1]?.selectable).toBe(true)
  })

  it('gives a video listed twice the same key', () => {
    expect(playlistRows[PLAYLIST_SPECIAL_ROWS.duplicateOf5]?.key).toBe(playlistRows[5]?.key)
  })

  it('carries the enrichment state and error', () => {
    const error = { code: 'network', message: 'The connection dropped.' } as const
    const [entry] = scSet.entries.slice(SC_SET_FULL_ROWS)
    if (entry === undefined) throw new Error('fixture')
    const [row] = tableRows([{ entry, state: 'failed', error }])
    expect(row).toMatchObject({ index: 0, state: 'failed', error, selectable: true })
    expect(tableRows([{ entry, state: 'pending' }])[0]).not.toHaveProperty('error')
  })

  it('keeps the object of a row that did not change, so memoized rows skip the render', () => {
    const enriched = ready(scSet.entries)
    const before = tableRows(enriched)
    const changed = enriched.map((row, index) =>
      index === 3 ? { ...row, state: 'loading' as const } : row,
    )
    const after = tableRows(changed)
    expect(after[0]).toBe(before[0])
    expect(after[3]).not.toBe(before[3])
    expect(after[3]?.state).toBe('loading')
  })

  it('makes a new row when the same enriched row moves to another index', () => {
    const enriched = ready(scSet.entries)
    const before = tableRows(enriched)
    const after = tableRows(enriched.slice(1))
    expect(after[0]).not.toBe(before[1])
    expect(after[0]?.index).toBe(0)
  })
})

describe('foldText', () => {
  it('drops accents and case', () => {
    expect(foldText('Água Viva')).toBe('agua viva')
    expect(foldText('ÉTÉ Señor Ölund')).toBe('ete senor olund')
  })

  it('folds compatibility forms', () => {
    expect(foldText('ﬁre Ｍix')).toBe('fire mix')
  })

  it('spells out letters that have no accent to drop', () => {
    expect(foldText('Røyksopp')).toBe('royksopp')
    expect(foldText('MØ')).toBe('mo')
    expect(foldText('Straße')).toBe('strasse')
    expect(foldText('Łódź')).toBe('lodz')
    expect(foldText('Đorđe Ægir Œuvre Þór Ðið')).toBe('dorde aegir oeuvre thor did')
    expect(foldText('Kırmızı')).toBe('kirmizi')
  })
})

describe('filterRows', () => {
  it('returns the rows themselves for a blank query', () => {
    expect(filterRows(playlistRows, '')).toBe(playlistRows)
    expect(filterRows(playlistRows, '   ')).toBe(playlistRows)
  })

  it('matches titles ignoring case and accents, in table order', () => {
    expect(titles(filterRows(playlistRows, 'AGUA'))).toEqual(['Água Viva'])
    expect(titles(filterRows(playlistRows, 'copper'))).toEqual(['Copper Lines', 'Copper Lines'])
  })

  it('matches the artist and the uploader too', () => {
    expect(titles(filterRows(playlistRows, 'kollektiv'))).toEqual([
      'Tidal Drift',
      'Undertow',
      'Breakwater',
    ])
    // Row 7 has no artist: only its uploader names who made it.
    expect(titles(filterRows(playlistRows, 'lofi garden'))).toEqual(['Sunset Session Mix 2026'])
  })

  it('needs every word, each anywhere in title, artist or uploader', () => {
    expect(titles(filterRows(playlistRows, 'tidal kollektiv'))).toEqual(['Tidal Drift'])
    expect(titles(filterRows(playlistRows, 'tidal mara'))).toEqual([])
  })

  it('finds nothing in partial rows until they are enriched', () => {
    const rows = tableRows(ready(scSet.entries))
    expect(titles(filterRows(rows, 'blue'))).toEqual(['Blue Hour'])
    expect(filterRows(rows, 'harbour')).toEqual([])
  })

  it('finds an artist by its letters without accents', () => {
    const [first] = playlist.entries
    if (first === undefined) throw new Error('fixture')
    const rows = tableRows(ready([{ ...first, title: 'Running to the Sea', artist: 'Røyksopp' }]))
    expect(titles(filterRows(rows, 'royksopp'))).toEqual(['Running to the Sea'])
    expect(titles(filterRows(rows, 'RØYKSOPP'))).toEqual(['Running to the Sea'])
  })

  it('searches 5,000 rows', () => {
    const rows = tableRows(ready(bigPlaylist(5000).entries))
    expect(titles(filterRows(rows, 'track 4999'))).toEqual(['Track 4999'])
  })
})

describe('selectedInOrder', () => {
  it('returns the first row of each selected track in table order, not in selection order', () => {
    const fifth = playlistRows[5]
    const first = playlistRows[0]
    if (fifth === undefined || first === undefined) throw new Error('fixture')
    const selected = new Set<TrackKey>([fifth.key, first.key])
    expect(selectedInOrder(playlistRows, selected).map((row) => row.index)).toEqual([0, 5])
  })

  it('returns nothing for an empty selection', () => {
    expect(selectedInOrder(playlistRows, new Set())).toEqual([])
  })
})

describe('summarize', () => {
  const selectable = new Set(playlistRows.filter((row) => row.selectable).map((row) => row.key))

  it('counts tracks, not rows, and sums the known durations', () => {
    // 28 selectable rows, one of them a repeat; row 14 has no duration.
    expect(summarize(playlistRows, selectable)).toEqual({
      count: 27,
      durationSec: 13102,
      withoutDuration: 1,
    })
  })

  it('counts a duration of 0 as unknown', () => {
    const [first] = playlist.entries
    if (first === undefined) throw new Error('fixture')
    const rows = tableRows(ready([{ ...first, durationSec: 0 }]))
    expect(summarize(rows, new Set(rows.map((row) => row.key)))).toEqual({
      count: 1,
      durationSec: 0,
      withoutDuration: 1,
    })
  })

  it('counts partial rows as without a duration', () => {
    const rows = tableRows(ready(scSet.entries))
    const keys = new Set(rows.map((row) => row.key))
    expect(summarize(rows, keys)).toMatchObject({ count: 8, withoutDuration: 6 })
  })

  it('is all zeros for an empty selection', () => {
    expect(summarize(playlistRows, new Set())).toEqual({
      count: 0,
      durationSec: 0,
      withoutDuration: 0,
    })
  })
})

describe('rowsInView', () => {
  const span = (from: number, to: number) =>
    Array.from({ length: Math.abs(to - from) }, (_, i) => (from < to ? from + i : from - i))

  it('lists the shown rows top-down, then 5 below, then 5 above nearest first', () => {
    expect(rowsInView(playlistRows, 10, 14)).toEqual([
      ...span(10, 15),
      ...span(15, 20),
      ...span(9, 4),
    ])
  })

  it('stops at either end of the shown rows', () => {
    expect(rowsInView(playlistRows, 0, 9)).toEqual(span(0, 15))
    expect(rowsInView(playlistRows.slice(0, 4), 0, 9)).toEqual(span(0, 4))
  })

  it('lists only the rows a filter shows, as collection indexes, never the hidden ones between', () => {
    const shown = filterRows(playlistRows, 'kollektiv')
    expect(shown.map((row) => row.index)).toEqual([0, 8, 25])
    expect(rowsInView(shown, 0, 2)).toEqual([0, 8, 25])

    // The overscan is the shown rows next to the visible ones.
    const evenRows = playlistRows.filter((row) => row.index % 2 === 0)
    expect(rowsInView(evenRows, 5, 6)).toEqual([10, 12, 14, 16, 18, 20, 22, 8, 6, 4, 2, 0])
  })

  it('is empty when nothing is shown', () => {
    expect(rowsInView([], 0, -1)).toEqual([])
    expect(rowsInView([], 0, 9)).toEqual([])
  })
})

// The key format the selection and the downloads panel share.
it('uses trackKey for the row key', () => {
  expect(playlistRows[0]?.key).toBe(trackKey({ platform: 'youtube', id: 'djRow000000' }))
})
