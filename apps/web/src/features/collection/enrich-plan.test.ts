import {
  CollectionEntrySchema,
  EntryRefSchema,
  MAX_ENTRIES_PER_REQUEST,
  MAX_URL_LENGTH,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { SC_SET_API_URL_ROW, scSet } from '@/test/resolve.ts'
import { LOADING, type LookupStatus } from './enrich-merge.ts'
import {
  ENRICH_BATCH_SIZE,
  entryRefOf,
  indexesWithin,
  initialStatus,
  isRequestable,
  nextRetryAt,
  planBatch,
  sameIndexes,
  windowIndexes,
} from './enrich-plan.ts'

const NOW = 1_000_000
const failedUntil = (retryAt: number): LookupStatus => ({
  state: 'failed',
  error: { code: 'network', message: 'Connection reset.' },
  retryAt,
})
const range = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) }, (_, i) => (from < to ? from + i : from - i))

describe('indexesWithin', () => {
  it('keeps the indexes of the list, in their order', () => {
    expect(indexesWithin([7, 2, 99, 0], 100)).toEqual([7, 2, 99, 0])
  })

  it('drops indexes past either end, fractions and NaN', () => {
    expect(indexesWithin([-1, 3, 100, 120, 2.5, Number.NaN, 4], 100)).toEqual([3, 4])
    expect(indexesWithin([0, 1], 0)).toEqual([])
  })
})

describe('sameIndexes', () => {
  it('compares indexes in order', () => {
    expect(sameIndexes([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(sameIndexes([], [])).toBe(true)
    expect(sameIndexes([1, 2, 3], [1, 3, 2])).toBe(false)
    expect(sameIndexes([1, 2], [1, 2, 3])).toBe(false)
  })
})

describe('windowIndexes', () => {
  it('lists the visible rows, then the overscan below, then the overscan above nearest first', () => {
    expect(windowIndexes({ start: 10, end: 15 }, 100)).toEqual([
      ...range(10, 15),
      ...range(15, 20),
      ...range(9, 4),
    ])
  })

  it('stops at either end of the list', () => {
    expect(windowIndexes({ start: 0, end: 3 }, 100)).toEqual(range(0, 8))
    expect(windowIndexes({ start: 97, end: 100 }, 100)).toEqual([
      ...range(97, 100),
      ...range(96, 91),
    ])
    expect(windowIndexes({ start: 0, end: 50 }, 4)).toEqual(range(0, 4))
  })

  it('takes the overscan around an empty range', () => {
    expect(windowIndexes({ start: 5, end: 5 }, 100, 2)).toEqual([5, 6, 4, 3])
  })

  it('lists only the visible rows without overscan', () => {
    expect(windowIndexes({ start: 3, end: 6 }, 100, 0)).toEqual([3, 4, 5])
  })
})

describe('entryRefOf', () => {
  it('takes only what POST /api/resolve/entries accepts, an API URL included', () => {
    const entry = scSet.entries[SC_SET_API_URL_ROW]
    if (entry === undefined) throw new Error('no row')

    const ref = entryRefOf(entry)
    expect(ref).toEqual({ platform: 'soundcloud', id: entry.id, url: entry.url })
    expect(EntryRefSchema.parse(ref)).toEqual(ref)
  })
})

describe('initialStatus', () => {
  const entryWithUrl = (url: string) =>
    CollectionEntrySchema.parse({
      id: '1501000009',
      platform: 'soundcloud',
      url,
      availability: 'unknown',
      partial: true,
    })

  it('starts a row pending', () => {
    expect(initialStatus(entryWithUrl('https://soundcloud.com/crate-diggers/x'))).toBeUndefined()
  })

  it('fails a row for good when its URL is too long to send', () => {
    const url = `https://soundcloud.com/${'a'.repeat(MAX_URL_LENGTH)}`
    expect(initialStatus(entryWithUrl(url))).toEqual({
      state: 'failed',
      error: { code: 'invalid_url', message: "This track's link is too long to look up." },
      retryAt: Number.POSITIVE_INFINITY,
    })
  })
})

describe('isRequestable', () => {
  it('asks for a row not asked for yet, or a failed one that is due again', () => {
    expect(isRequestable(undefined, NOW)).toBe(true)
    expect(isRequestable(failedUntil(NOW), NOW)).toBe(true)
    expect(isRequestable(failedUntil(NOW - 1), NOW)).toBe(true)
  })

  it('never asks twice at once, again for a settled row, or before a retry is due', () => {
    expect(isRequestable(LOADING, NOW)).toBe(false)
    expect(isRequestable(failedUntil(NOW + 1), NOW)).toBe(false)
    expect(isRequestable(failedUntil(Number.POSITIVE_INFINITY), NOW)).toBe(false)
    const error = { code: 'private', message: 'Private.' } as const
    expect(isRequestable({ state: 'unavailable', reason: 'private', error }, NOW)).toBe(false)
    const entry = scSet.entries[0]
    if (entry === undefined) throw new Error('no row')
    expect(isRequestable({ state: 'filled', entry }, NOW)).toBe(false)
  })
})

describe('planBatch', () => {
  const lookups = Array.from({ length: 40 }, (_, index) => ({ index }))

  it('takes the first requestable lookups in order, a few per request', () => {
    const batch = planBatch(lookups, (lookup) => lookup.index % 3 !== 0)

    expect(batch.map((lookup) => lookup.index)).toEqual([1, 2, 4, 5])
    expect(batch[0]).toBe(lookups[1])
    expect(planBatch(lookups, () => true, 25)).toEqual(lookups.slice(0, 25))
  })

  it('asks for few enough rows that they fill in as the server paces them, within its cap', () => {
    // The server answers a request once all its rows are looked up, about one a second.
    expect(ENRICH_BATCH_SIZE).toBe(4)
    expect(ENRICH_BATCH_SIZE).toBeLessThanOrEqual(MAX_ENTRIES_PER_REQUEST)
  })

  it('asks once for a lookup that several rows share', () => {
    const [a, b] = lookups
    if (a === undefined || b === undefined) throw new Error('no lookups')

    expect(planBatch([a, b, a, a, b], () => true)).toEqual([a, b])
    expect(planBatch([a, a, a, b], () => true, 1)).toEqual([a])
  })

  it('plans nothing when nothing is requestable', () => {
    expect(planBatch(lookups, () => false)).toEqual([])
    expect(planBatch([], () => true)).toEqual([])
  })
})

describe('nextRetryAt', () => {
  it('finds the earliest retry still to come', () => {
    const statuses = [undefined, failedUntil(NOW + 9000), LOADING, failedUntil(NOW + 4000)]
    expect(nextRetryAt(statuses, NOW)).toBe(NOW + 4000)
  })

  it('ignores retries already due and rows that are never asked for again', () => {
    const statuses = [failedUntil(NOW), failedUntil(NOW - 5), failedUntil(Number.POSITIVE_INFINITY)]
    expect(nextRetryAt(statuses, NOW)).toBeUndefined()
    expect(nextRetryAt([], NOW)).toBeUndefined()
  })
})
