// The collection view with the real useEnrichment (no vi.mock in this file): the rows the table
// shows are the rows looked up through POST /api/resolve/entries, through the real virtualizer.
// Real timers: the virtualizer's scroll end and the 150 ms debounce run as in a browser.
import {
  type Collection,
  CollectionSchema,
  type EntryRef,
  ResolveEntriesRequestSchema,
  type Track,
  TrackSchema,
} from '@dj-scraper/shared'
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settings } from '@/test/downloads.ts'
import { type ApiCall, fakeApi, json, jsonBody } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { entryOk, scSet, scSetTracks } from '@/test/resolve.ts'
import { CollectionView } from './collection-view.tsx'
import { scrollToRow, stubTableViewport } from './test-utils.ts'

const ROUTE = 'POST /api/resolve/entries'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

const span = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
/** Waits, inside act(), for `ms` of real time. */
const rest = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const idsIn = (call: ApiCall | undefined) =>
  ResolveEntriesRequestSchema.parse(jsonBody(call)).entries.map((entry) => entry.id)

/**
 * A SoundCloud list of `n` rows as a user's tracks page lists them: partial (no duration or
 * source), but titled. Rows 2 and n - 10 are the only "Needle Drop"s. `full` holds what enrichment
 * returns for each.
 */
function titledList(n: number): { collection: Collection; full: Track[] } {
  const needles = new Set([2, n - 10])
  const full = Array.from({ length: n }, (_, index) =>
    TrackSchema.parse({
      id: String(1_800_000_000 + index),
      platform: 'soundcloud',
      url: `https://soundcloud.com/mara-vey/track-${index}`,
      title: needles.has(index) ? `Needle Drop ${index}` : `Track ${index}`,
      artist: 'Mara Vey',
      durationSec: 300,
      availability: 'available',
      source: { codec: 'mp3', bitrateKbps: 128 },
    }),
  )
  const collection = CollectionSchema.parse({
    id: '777000111',
    platform: 'soundcloud',
    url: 'https://soundcloud.com/mara-vey/tracks',
    kind: 'channel',
    title: 'Mara Vey',
    truncated: false,
    entries: full.map(({ id, platform, url, title }) => ({
      id,
      platform,
      url,
      title,
      availability: 'unknown',
      partial: true,
    })),
  })
  return { collection, full }
}

/** The server answers every lookup at once with the row's full track from `full`. */
function answerFrom(full: readonly Track[]) {
  const byId = new Map(full.map((track) => [track.id, track]))
  server.on(ROUTE, (call) => {
    const { entries } = ResolveEntriesRequestSchema.parse(jsonBody(call))
    return json({
      results: entries.map((ref: EntryRef) => {
        const track = byId.get(ref.id)
        if (track === undefined) throw new Error(`No track for ${ref.id}`)
        return entryOk(track)
      }),
    })
  })
}

/** Lookups stay in flight until aborted. */
function holdRequests() {
  server.on(ROUTE, () => new Promise<Response>(() => {}))
}

describe('CollectionView enrichment', () => {
  it('looks up only the rows a filter shows, never the hidden ones between them', async () => {
    stubTableViewport(15)
    const { collection, full } = titledList(300)
    const indexOf = new Map(full.map((track, index) => [track.id, index]))
    const asked = () =>
      server
        .callsTo(ROUTE)
        .flatMap(idsIn)
        .map((id) => indexOf.get(id))
    answerFrom(full)
    renderWithQueryClient(<CollectionView collection={collection} onOpenList={() => {}} />)

    // The first screen (15 rows) and 5 below.
    await waitFor(() => expect(asked()).toEqual(span(0, 20)))
    await rest(300)
    expect(asked()).toHaveLength(20)

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Filter tracks' }), 'needle')
    expect(screen.getByRole('checkbox', { name: 'Select Needle Drop 2' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Select Needle Drop 290' })).toBeTruthy()

    // Row 2 is filled already; row 290 is the one row left to look up.
    await waitFor(() => expect(asked().slice(20)).toEqual([290]))
    await rest(300)
    expect(asked().slice(20)).toEqual([290])
  })

  it('aborts the lookups of rows scrolled away, and looks up the rows scrolled to', async () => {
    stubTableViewport(10)
    const { collection } = titledList(200)
    holdRequests()
    renderWithQueryClient(<CollectionView collection={collection} onOpenList={() => {}} />)
    await waitFor(() => expect(server.callsTo(ROUTE)).toHaveLength(2))
    const [first, second] = server.callsTo(ROUTE)
    const ids = collection.entries.map((entry) => entry.id)
    expect(idsIn(first)).toEqual(ids.slice(0, 4))
    expect(idsIn(second)).toEqual(ids.slice(4, 8))

    await scrollToRow(100)

    expect(first?.signal?.aborted).toBe(true)
    expect(second?.signal?.aborted).toBe(true)
    await waitFor(() => expect(server.callsTo(ROUTE)).toHaveLength(4))
    expect(idsIn(server.callsTo(ROUTE)[2])).toEqual(ids.slice(100, 104))
    expect(idsIn(server.callsTo(ROUTE)[3])).toEqual(ids.slice(104, 108))
  })

  it('fills a set in under StrictMode, asking for each row once', async () => {
    stubTableViewport(10)
    answerFrom(scSetTracks)
    renderWithQueryClient(
      <StrictMode>
        <CollectionView collection={scSet} onOpenList={() => {}} />
      </StrictMode>,
    )
    expect(screen.getAllByText('Loading details…')).toHaveLength(6)

    await waitFor(() => expect(screen.queryAllByText('Loading details…')).toHaveLength(0))
    await rest(200)
    const partial = scSet.entries.filter((entry) => entry.partial).map((entry) => entry.id)
    expect(server.callsTo(ROUTE).flatMap(idsIn)).toEqual(partial)
    expect(screen.getByRole('checkbox', { name: 'Select Tram Lines' })).toBeTruthy()
  })
})
