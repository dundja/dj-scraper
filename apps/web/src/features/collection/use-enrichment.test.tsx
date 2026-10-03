import {
  type CollectionEntry,
  CollectionEntrySchema,
  type EntryRef,
  type EntryResult,
  ResolveEntriesRequestSchema,
  type Track,
  TrackSchema,
} from '@dj-scraper/shared'
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ApiCall, fakeApi, json, jsonBody, networkError } from '@/test/fake-api.ts'
import {
  bigPlaylist,
  entryError,
  entryOk,
  SC_SET_API_URL_ROW,
  SC_SET_FULL_ROWS,
  SC_SET_PREVIEW_ROW,
  scSet,
  scSetTracks,
} from '@/test/resolve.ts'
import { windowIndexes } from './enrich-plan.ts'
import { type EnrichedRow, useEnrichment } from './use-enrichment.ts'

const ROUTE = 'POST /api/resolve/entries'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  vi.useFakeTimers()
  server = fakeApi()
})

afterEach(() => {
  // Unmounting stops the session: no debounce, retry or back-off timer outlives the table.
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  expect(server.unhandled).toEqual([])
})

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const calls = () => server.callsTo(ROUTE)
/** The ids a request asked for, in order. */
const idsIn = (call: ApiCall | undefined) =>
  ResolveEntriesRequestSchema.parse(jsonBody(call)).entries.map((entry) => entry.id)
/** Every id asked for so far, request after request. */
const askedIds = () => calls().flatMap(idsIn)
/** How many times the row with this id was asked for. */
const timesAsked = (id: string | undefined) => askedIds().filter((asked) => asked === id).length
const statesOf = (rows: readonly EnrichedRow[], indexes: number[]) =>
  indexes.map((index) => rows[index]?.state)
const span = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) }, (_, i) => (from < to ? from + i : from - i))

/**
 * A long SoundCloud set as the flat listing gives it: `n` bare rows (id + url), and the full
 * tracks enrichment returns for them.
 */
function bareSet(n: number): { entries: CollectionEntry[]; tracks: Track[] } {
  const tracks = Array.from({ length: n }, (_, index) =>
    TrackSchema.parse({
      id: String(1_700_000_000 + index),
      platform: 'soundcloud',
      url: `https://soundcloud.com/crate-diggers/track-${index}`,
      title: `Track ${index}`,
      artist: 'Kollektiv Nord',
      durationSec: 300 + index,
      availability: 'available',
      source: { codec: 'mp3', bitrateKbps: 128 },
    }),
  )
  const entries = tracks.map(({ id, platform, url }) =>
    CollectionEntrySchema.parse({ id, platform, url, availability: 'unknown', partial: true }),
  )
  return { entries, tracks }
}
const big = bareSet(100)
/** The ids of `big`'s rows at these indexes. */
const bigIds = (indexes: number[]) => indexes.map((index) => big.tracks[index]?.id)

const fullTracks = new Map([...scSetTracks, ...big.tracks].map((full) => [full.id, full]))

/** The server's answer to a request: each row from `fullTracks`, unless `answer` says otherwise. */
function resultsFor(call: ApiCall, answer?: (ref: EntryRef) => EntryResult | undefined) {
  const { entries } = ResolveEntriesRequestSchema.parse(jsonBody(call))
  return {
    results: entries.map((ref) => {
      const custom = answer?.(ref)
      if (custom !== undefined) return custom
      const full = fullTracks.get(ref.id)
      if (full === undefined) throw new Error(`No track for ${ref.id}`)
      return entryOk(full)
    }),
  }
}

/** The server answers every request at once. */
function answerRows(answer?: (ref: EntryRef) => EntryResult | undefined) {
  server.on(ROUTE, (call) => json(resultsFor(call, answer)))
}

/** Requests stay in flight until the test answers them, in any order. */
function holdRequests() {
  const answers: PromiseWithResolvers<Response>[] = []
  server.on(ROUTE, () => {
    const answer = Promise.withResolvers<Response>()
    answers.push(answer)
    return answer.promise
  })
  return {
    /** Answers request `index` (by arrival) like the server would. */
    async answer(index: number, answer?: (ref: EntryRef) => EntryResult | undefined) {
      const call = calls()[index]
      if (call === undefined) throw new Error(`No request ${index}`)
      await act(async () => {
        answers[index]?.resolve(json(resultsFor(call, answer)))
        await vi.advanceTimersByTimeAsync(0)
      })
    },
    /** Request `index` (by arrival) gets no answer: the server is down. All in one tick. */
    async fail(...indexes: number[]) {
      await act(async () => {
        for (const index of indexes) answers[index]?.reject(new TypeError('Failed to fetch'))
        await vi.advanceTimersByTimeAsync(0)
      })
    },
  }
}

function renderEnrichment(entries: readonly CollectionEntry[], { strict = false } = {}) {
  let renders = 0
  const hook = renderHook(
    (props: { entries: readonly CollectionEntry[] }) => {
      renders++
      return useEnrichment(props.entries)
    },
    { initialProps: { entries }, ...(strict ? { wrapper: StrictMode } : {}) },
  )
  return {
    ...hook,
    rows: () => hook.result.current.rows,
    renders: () => renders,
    /**
     * The table shows rows `start` (inclusive) to `end` (exclusive) without a filter: it reports
     * them with 5 rows of overscan, as rowsInView does.
     */
    scroll: (start: number, end: number) =>
      act(() =>
        hook.result.current.setRowsInView(windowIndexes({ start, end }, Number.POSITIVE_INFINITY)),
      ),
    /** The table reports these rows in view, e.g. the few a filter shows. */
    show: (indexes: readonly number[]) => act(() => hook.result.current.setRowsInView(indexes)),
  }
}

const refAt = (index: number) => {
  const { platform, id, url } = scSet.entries[index] ?? {}
  return { platform, id, url }
}

const PARTIAL_ROWS = span(SC_SET_FULL_ROWS, scSet.entries.length)

describe('useEnrichment', () => {
  it('shows complete rows as they are and partial rows as pending', () => {
    const { rows } = renderEnrichment(scSet.entries)

    expect(rows()).toHaveLength(scSet.entries.length)
    expect(rows().map((row) => row.entry)).toEqual(scSet.entries)
    expect(rows()[0]?.entry).toBe(scSet.entries[0])
    expect(rows().map((row) => row.state)).toEqual([
      'ready',
      'ready',
      ...PARTIAL_ROWS.map(() => 'pending'),
    ])
  })

  it('asks for the partial rows in view once the table has rested 150 ms', async () => {
    holdRequests()
    const { rows } = renderEnrichment(scSet.entries)

    await advance(149)
    expect(calls()).toHaveLength(0)
    await advance(1)

    // A few rows per request, two requests at a time.
    expect(calls()).toHaveLength(2)
    expect(jsonBody(calls()[0])).toEqual({ entries: PARTIAL_ROWS.slice(0, 4).map(refAt) })
    expect(jsonBody(calls()[1])).toEqual({ entries: PARTIAL_ROWS.slice(4).map(refAt) })
    // The bare row listed with an API URL is asked for by that URL.
    expect(jsonBody(calls()[1])).toMatchObject({
      entries: expect.arrayContaining([refAt(SC_SET_API_URL_ROW)]),
    })
    expect(statesOf(rows(), [0, 1, ...PARTIAL_ROWS])).toEqual([
      'ready',
      'ready',
      ...PARTIAL_ROWS.map(() => 'loading'),
    ])
  })

  it('fills each row with its full track, merged by platform + id', async () => {
    // Out of request order: the merge goes by platform + id, never by position or URL.
    server.on(ROUTE, (call) => {
      const { results } = resultsFor(call)
      return json({ results: results.reverse() })
    })
    const { rows } = renderEnrichment(scSet.entries)
    const before = rows()

    await advance(150)

    expect(rows()).not.toBe(before)
    for (const index of PARTIAL_ROWS) {
      expect(rows()[index]).toEqual({
        entry: { ...scSetTracks[index], partial: false },
        state: 'ready',
      })
    }
    expect(rows()[SC_SET_API_URL_ROW]?.entry.url).toBe(scSetTracks[SC_SET_API_URL_ROW]?.url)
    expect(rows()[SC_SET_PREVIEW_ROW]?.entry).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
    // Complete rows keep their identity, so the table doesn't render them again.
    expect(rows()[0]).toBe(before[0])
    expect(rows()[1]).toBe(before[1])
    await advance(60_000)
    expect(calls()).toHaveLength(2)
    expect(askedIds()).toEqual(PARTIAL_ROWS.map((index) => scSet.entries[index]?.id))
  })

  it('marks rows unavailable when the lookup says so, and fails the rest', async () => {
    const at = (index: number) => scSet.entries[index]?.id
    const errors = {
      [at(2) ?? '']: { code: 'private', message: 'This track is private.' },
      [at(3) ?? '']: { code: 'unavailable', message: 'This track was removed.' },
      [at(4) ?? '']: { code: 'rate_limited', message: 'SoundCloud is limiting requests.' },
      [at(6) ?? '']: { code: 'invalid_request', message: 'This link is a list, not a track.' },
    } as const
    answerRows((ref) => {
      const error = errors[ref.id]
      return error === undefined ? undefined : entryError(ref, error)
    })
    const { rows } = renderEnrichment(scSet.entries)

    await advance(150)

    expect(rows()[2]).toEqual({
      entry: { ...scSet.entries[2], availability: 'unavailable', unavailableReason: 'private' },
      state: 'ready',
      error: errors[at(2) ?? ''],
    })
    expect(rows()[3]?.entry).toMatchObject({ partial: true, unavailableReason: 'unavailable' })
    expect(rows()[4]).toEqual({
      entry: scSet.entries[4],
      state: 'failed',
      error: errors[at(4) ?? ''],
    })
    expect(rows()[6]).toMatchObject({ state: 'failed', error: errors[at(6) ?? ''] })
    expect(statesOf(rows(), [5, 7])).toEqual(['ready', 'ready'])
  })

  it('asks again for a rate-limited row after 30 s while it is in view, and never for a list', async () => {
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    const list = { code: 'invalid_request', message: 'This link is a list, not a track.' } as const
    answerRows((ref) => {
      if (ref.id === scSet.entries[4]?.id) return entryError(ref, limited)
      if (ref.id === scSet.entries[6]?.id) return entryError(ref, list)
      return undefined
    })
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)
    expect(statesOf(rows(), [4, 6])).toEqual(['failed', 'failed'])

    answerRows((ref) => (ref.id === scSet.entries[6]?.id ? entryError(ref, list) : undefined))
    await advance(29_999)
    expect(calls()).toHaveLength(2)
    await advance(1)

    expect(calls()).toHaveLength(3)
    expect(idsIn(calls()[2])).toEqual([scSet.entries[4]?.id])
    expect(rows()[4]).toEqual({ entry: { ...scSetTracks[4], partial: false }, state: 'ready' })
    await advance(10 * 60_000)
    expect(calls()).toHaveLength(3)
    expect(rows()[6]?.state).toBe('failed')
  })

  it('asks again for a failed row that scrolls back into view after its 30 s', async () => {
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    answerRows((ref) => (ref.id === big.tracks[3]?.id ? entryError(ref, limited) : undefined))
    const { rows, scroll } = renderEnrichment(big.entries)
    await advance(150)
    expect(rows()[3]?.state).toBe('failed')

    await scroll(50, 65)
    await advance(150)
    expect(rows()[69]?.state).toBe('ready')
    const asked = calls().length
    await advance(60_000)
    expect(calls()).toHaveLength(asked)

    answerRows()
    await scroll(0, 15)
    await advance(150)
    expect(calls()).toHaveLength(asked + 1)
    expect(idsIn(calls()[asked])).toEqual(bigIds([3]))
    expect(rows()[3]?.state).toBe('ready')
  })

  it('asks for the first screenful until the table reports its rows', async () => {
    answerRows()
    renderEnrichment(big.entries)

    await advance(150)

    // The default 15 visible rows plus 5 below, and no more.
    expect(askedIds()).toEqual(bigIds(span(0, 20)))
    await advance(60_000)
    expect(askedIds()).toHaveLength(20)
  })

  it('asks for 4 rows per request, 2 requests at a time, and fills rows in as each answers', async () => {
    const held = holdRequests()
    const { rows, scroll } = renderEnrichment(big.entries)
    await scroll(0, 20)
    await advance(150)

    expect(calls()).toHaveLength(2)
    expect(idsIn(calls()[0])).toEqual(bigIds(span(0, 4)))
    expect(idsIn(calls()[1])).toEqual(bigIds(span(4, 8)))
    expect(statesOf(rows(), [7, 8])).toEqual(['loading', 'pending'])
    await advance(10_000)
    expect(calls()).toHaveLength(2)

    // The first answer fills its rows at once, without waiting for the rest of the screen.
    await held.answer(0)
    expect(statesOf(rows(), [0, 3, 4, 8, 12])).toEqual([
      'ready',
      'ready',
      'loading',
      'loading',
      'pending',
    ])
    expect(calls()).toHaveLength(3)
    expect(idsIn(calls()[2])).toEqual(bigIds(span(8, 12)))

    await held.answer(2)
    expect(statesOf(rows(), [4, 8, 11, 12])).toEqual(['loading', 'ready', 'ready', 'loading'])
    expect(idsIn(calls()[3])).toEqual(bigIds(span(12, 16)))
  })

  it('asks only for the rows in view, however far apart (a filter shows a few)', async () => {
    answerRows()
    const { rows, show } = renderEnrichment(big.entries)
    await show([2, 90])
    await advance(150)

    expect(calls()).toHaveLength(1)
    expect(idsIn(calls()[0])).toEqual(bigIds([2, 90]))
    expect(statesOf(rows(), [2, 3, 89, 90])).toEqual(['ready', 'pending', 'pending', 'ready'])
    // Indexes off the list are left out.
    await show([95, -1, 100, 1.5, 96])
    await advance(150)
    expect(idsIn(calls()[1])).toEqual(bigIds([95, 96]))
    await advance(60_000)
    expect(calls()).toHaveLength(2)
  })

  it("doesn't ask for rows a fast scroll flies past", async () => {
    holdRequests()
    const { scroll } = renderEnrichment(big.entries)

    for (let start = 10; start <= 60; start += 10) {
      await scroll(start, start + 15)
      await advance(100)
    }
    expect(calls()).toHaveLength(0)
    await advance(50)

    expect(calls()).toHaveLength(2)
    expect(idsIn(calls()[0])).toEqual(bigIds(span(60, 64)))
    expect(idsIn(calls()[1])).toEqual(bigIds(span(64, 68)))
  })

  it('asks for the rows in view top-down, then the overscan below, then above', async () => {
    answerRows()
    const { scroll } = renderEnrichment(big.entries)
    await scroll(60, 75)
    await advance(150)

    expect(askedIds()).toEqual(bigIds([...span(60, 80), ...span(59, 54)]))
  })

  it('aborts a request once all its rows have scrolled away, and its rows are pending again', async () => {
    holdRequests()
    const { rows, scroll } = renderEnrichment(big.entries)
    await advance(150)
    const [first, second] = calls()
    expect(statesOf(rows(), [0, 7])).toEqual(['loading', 'loading'])

    await scroll(50, 65)

    // At once, not after the debounce: the server stops looking those rows up.
    expect(first?.signal?.aborted).toBe(true)
    expect(second?.signal?.aborted).toBe(true)
    expect(statesOf(rows(), [0, 7])).toEqual(['pending', 'pending'])
    await advance(150)
    expect(calls()).toHaveLength(4)
    expect(idsIn(calls()[2])).toEqual(bigIds(span(50, 54)))

    // Back up: the rows are asked for again.
    await scroll(0, 15)
    expect(calls()[2]?.signal?.aborted).toBe(true)
    expect(calls()[3]?.signal?.aborted).toBe(true)
    await advance(150)
    expect(idsIn(calls()[4])).toEqual(bigIds(span(0, 4)))
  })

  it('keeps a request while one of its rows is still in view or the overscan', async () => {
    holdRequests()
    const { rows, scroll } = renderEnrichment(big.entries)
    await advance(150)

    // Rows 0–3 and 4–7 were asked for; 5–7 stay within the overscan above row 10.
    await scroll(10, 25)
    await advance(150)

    expect(calls()[0]?.signal?.aborted).toBe(true)
    expect(calls()[1]?.signal?.aborted).toBe(false)
    expect(statesOf(rows(), [0, 4])).toEqual(['pending', 'loading'])
    expect(calls()).toHaveLength(3)
    expect(idsIn(calls()[2])).toEqual(bigIds(span(10, 14)))
  })

  it('waits for a scroll to rest before asking for more when an answer arrives mid-scroll', async () => {
    const held = holdRequests()
    const { rows, scroll } = renderEnrichment(big.entries)
    await advance(150)

    await scroll(6, 21)
    await held.answer(0)
    expect(rows()[0]?.state).toBe('ready')
    expect(calls()).toHaveLength(2)
    await advance(149)
    expect(calls()).toHaveLength(2)
    await advance(1)

    expect(calls()).toHaveLength(3)
    expect(idsIn(calls()[2])).toEqual(bigIds(span(8, 12)))
  })

  it('puts the rows back and backs off when the whole request fails', async () => {
    server.on(ROUTE, networkError)
    const { rows, scroll } = renderEnrichment(big.entries)
    await advance(150)
    // Both requests failed in the same outage: one back-off.
    expect(calls()).toHaveLength(2)
    expect(rows()[0]?.state).toBe('pending')

    await advance(1999)
    expect(calls()).toHaveLength(2)
    await advance(1)
    expect(calls()).toHaveLength(4)

    await advance(3999)
    expect(calls()).toHaveLength(4)
    answerRows()
    await advance(1)
    expect(statesOf(rows(), [0, 19])).toEqual(['ready', 'ready'])

    // A success resets the back-off.
    server.on(ROUTE, networkError)
    await scroll(50, 65)
    await advance(150)
    const asked = calls().length
    await advance(1999)
    expect(calls()).toHaveLength(asked)
    await advance(1)
    expect(calls()).toHaveLength(asked + 2)
  })

  it('backs off once for requests that fail in the same outage', async () => {
    const held = holdRequests()
    renderEnrichment(big.entries)
    await advance(150)
    expect(calls()).toHaveLength(2)

    await held.fail(0, 1)
    await advance(1999)
    expect(calls()).toHaveLength(2)
    await advance(1)
    // 2 s, as after one failure: the second one doesn't double the wait.
    expect(calls()).toHaveLength(4)

    // Failing again doubles the wait to 4 s, and a failure during that wait doesn't add to it.
    await held.fail(2)
    await advance(1000)
    await held.fail(3)
    await advance(2999)
    expect(calls()).toHaveLength(4)
    await advance(1)
    expect(calls()).toHaveLength(6)
  })

  it.each([
    ['503 engine_missing', { code: 'engine_missing', message: 'yt-dlp is not installed.' }, 503],
    ['429', { code: 'rate_limited', message: 'Too many requests.' }, 429],
  ] as const)('backs off after a %s too', async (_name, error, status) => {
    server.on(ROUTE, () => json({ error }, status))
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)
    expect(rows()[2]?.state).toBe('pending')

    answerRows()
    await advance(2000)
    expect(calls()).toHaveLength(4)
    expect(rows()[2]?.state).toBe('ready')
  })

  it('fails the rows of a request the server refuses', async () => {
    const refusal = { code: 'invalid_request', message: 'At most 25 rows per request.' } as const
    server.on(ROUTE, () => json({ error: refusal }, 400))
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)

    expect(rows()[2]).toEqual({ entry: scSet.entries[2], state: 'failed', error: refusal })
    await advance(10 * 60_000)
    expect(calls()).toHaveLength(2)
  })

  it('fails the rows of an answer off the contract, and asks again after 30 s', async () => {
    server.on(ROUTE, () => json({ results: 'none' }))
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)

    expect(rows()[2]).toMatchObject({
      state: 'failed',
      error: { code: 'unknown', message: 'Unexpected answer from the server.' },
    })
    answerRows()
    await advance(30_000)
    expect(calls()).toHaveLength(4)
    expect(rows()[2]?.state).toBe('ready')
  })

  it('fails a row the answer leaves out, and asks for it again after 30 s', async () => {
    const left = scSet.entries[3]?.id
    server.on(ROUTE, (call) => {
      const { results } = resultsFor(call)
      return json({ results: results.filter((result) => result.id !== left) })
    })
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)

    expect(rows()[3]).toMatchObject({
      state: 'failed',
      error: { code: 'unknown', message: 'The server sent no details for this track.' },
    })
    expect(rows()[4]?.state).toBe('ready')
    answerRows()
    await advance(30_000)
    expect(calls()).toHaveLength(3)
    expect(idsIn(calls()[2])).toEqual([left])
    expect(rows()[3]?.state).toBe('ready')
  })

  it('waits longer each time a row fails again, up to 10 min', async () => {
    const unreadable = { code: 'unknown', message: "yt-dlp's answer could not be read." } as const
    const failing = scSet.entries[4]?.id
    answerRows((ref) => (ref.id === failing ? entryError(ref, unreadable) : undefined))
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)
    expect(rows()[4]).toMatchObject({ state: 'failed', error: unreadable })
    expect(timesAsked(failing)).toBe(1)

    await advance(30_000)
    expect(timesAsked(failing)).toBe(2)
    await advance(59_999)
    expect(timesAsked(failing)).toBe(2)
    await advance(1)
    expect(timesAsked(failing)).toBe(3)
    for (const wait of [120_000, 240_000, 480_000, 600_000, 600_000]) {
      const before = timesAsked(failing)
      await advance(wait - 1)
      expect(timesAsked(failing)).toBe(before)
      await advance(1)
      expect(timesAsked(failing)).toBe(before + 1)
    }
    // Every other row was asked for once.
    expect(askedIds().filter((id) => id !== failing)).toHaveLength(PARTIAL_ROWS.length - 1)
  })

  it('asks a failed row again only once the tab is shown again', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    const failing = scSet.entries[4]?.id
    answerRows((ref) => (ref.id === failing ? entryError(ref, limited) : undefined))
    const { rows, unmount } = renderEnrichment(scSet.entries)
    // A hidden tab still fills the rows in view once, but sets no timer to ask again.
    await advance(150)
    expect(rows()[4]?.state).toBe('failed')
    expect(rows()[2]?.state).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
    await advance(10 * 60_000)
    expect(timesAsked(failing)).toBe(1)

    visibility.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(timesAsked(failing)).toBe(2)
    expect(rows()[4]?.state).toBe('failed')

    // Once unmounted, showing the tab asks for nothing.
    unmount()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(timesAsked(failing)).toBe(2)
    visibility.mockRestore()
  })

  it('times its waits on a monotonic clock, so a wall-clock step back stalls nothing', async () => {
    server.on(ROUTE, networkError)
    const { rows } = renderEnrichment(scSet.entries)
    await advance(150)
    expect(calls()).toHaveLength(2)

    // The clock is set back an hour during the 2 s back-off.
    await advance(1000)
    vi.setSystemTime(Date.now() - 60 * 60_000)
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    const failing = scSet.entries[4]?.id
    answerRows((ref) => (ref.id === failing ? entryError(ref, limited) : undefined))
    await advance(1000)
    expect(calls()).toHaveLength(4)
    expect(rows()[2]?.state).toBe('ready')

    // And back an hour again during a row's 30 s wait (its first ask was in the failed request).
    expect(timesAsked(failing)).toBe(2)
    await advance(10_000)
    vi.setSystemTime(Date.now() - 60 * 60_000)
    answerRows()
    await advance(19_999)
    expect(timesAsked(failing)).toBe(2)
    await advance(1)
    expect(timesAsked(failing)).toBe(3)
    expect(rows()[4]?.state).toBe('ready')
  })

  it('asks once for a track the list has twice, and fills both rows', async () => {
    const [first, second] = big.entries
    if (first === undefined || second === undefined) throw new Error('no rows')
    answerRows()
    const { rows } = renderEnrichment([first, second, first])
    await advance(150)

    expect(idsIn(calls()[0])).toEqual(bigIds([0, 1]))
    expect(rows()[0]).toEqual({ entry: { ...big.tracks[0], partial: false }, state: 'ready' })
    expect(rows()[2]).toEqual(rows()[0])
  })

  it('does nothing for a list without partial rows, even at 5,000 rows', async () => {
    const { entries } = bigPlaylist(5000)
    const { rows, scroll, renders } = renderEnrichment(entries)

    expect(
      rows().every((row, index) => row.state === 'ready' && row.entry === entries[index]),
    ).toBe(true)
    const rendered = renders()
    await scroll(2000, 2015)
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(calls()).toHaveLength(0)
    expect(renders()).toBe(rendered)
  })

  it('keeps its rows and setter between renders, and a scroll alone renders nothing', async () => {
    holdRequests()
    const { result, rerender, scroll, renders } = renderEnrichment(scSet.entries)
    const { rows, setRowsInView } = result.current

    rerender({ entries: scSet.entries })
    expect(result.current.rows).toBe(rows)
    expect(result.current.setRowsInView).toBe(setRowsInView)

    const rendered = renders()
    await scroll(0, 5)
    await scroll(1, 6)
    expect(renders()).toBe(rendered)
  })

  it('starts over for a new list: aborts the old requests and asks for the new rows', async () => {
    holdRequests()
    const { rows, rerender } = renderEnrichment(big.entries)
    await advance(150)
    const old = calls()

    rerender({ entries: scSet.entries })

    expect(old.map((call) => call.signal?.aborted)).toEqual([true, true])
    expect(rows().map((row) => row.entry)).toEqual(scSet.entries)
    expect(statesOf(rows(), PARTIAL_ROWS)).toEqual(PARTIAL_ROWS.map(() => 'pending'))
    await advance(150)
    expect(calls()).toHaveLength(4)
    expect([...idsIn(calls()[2]), ...idsIn(calls()[3])]).toEqual(
      PARTIAL_ROWS.map((index) => scSet.entries[index]?.id),
    )
  })

  it('aborts every request on unmount and leaves no timer', async () => {
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    const held = holdRequests()
    const { scroll, unmount } = renderEnrichment(big.entries)
    await advance(150)
    await held.answer(0, (ref) =>
      ref.id === big.tracks[3]?.id ? entryError(ref, limited) : undefined,
    )
    expect(calls()).toHaveLength(3)
    // In flight: two requests; waiting: the failed row's retry and a new scroll's debounce.
    await scroll(2, 17)
    expect(vi.getTimerCount()).toBe(2)

    unmount()

    expect(calls()[1]?.signal?.aborted).toBe(true)
    expect(calls()[2]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(calls()).toHaveLength(3)
  })

  it('asks for each row once under StrictMode', async () => {
    answerRows()
    const { rows } = renderEnrichment(scSet.entries, { strict: true })
    await advance(150)

    expect(askedIds()).toEqual(PARTIAL_ROWS.map((index) => scSet.entries[index]?.id))
    expect(statesOf(rows(), PARTIAL_ROWS)).toEqual(PARTIAL_ROWS.map(() => 'ready'))
  })
})
