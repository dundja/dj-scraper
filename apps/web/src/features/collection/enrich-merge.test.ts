import {
  type CollectionEntry,
  CollectionEntrySchema,
  EntryResultSchema,
  type ErrorInfo,
  type UnavailableReason,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  entryError,
  entryOk,
  SC_SET_API_URL_ROW,
  SC_SET_PREVIEW_ROW,
  scSet,
  scSetTracks,
} from '@/test/resolve.ts'
import { failedStatus, LOADING, type LookupStatus, lookupStatusOf, rowFor } from './enrich-merge.ts'

const NOW = 1_000_000

/** Row `index` of `scSet` and the full track behind it. */
function row(index: number): { entry: CollectionEntry; full: (typeof scSetTracks)[number] } {
  const entry = scSet.entries[index]
  const full = scSetTracks[index]
  if (entry === undefined || full === undefined) throw new Error(`scSet has no row ${index}`)
  return { entry, full }
}

const bare = row(3)

describe('lookupStatusOf', () => {
  it('fills a row with the full track, no longer partial', () => {
    const status = lookupStatusOf(entryOk(bare.full), NOW)

    expect(status).toEqual({ state: 'filled', entry: { ...bare.full, partial: false } })
    if (status.state !== 'filled') throw new Error('not filled')
    expect(CollectionEntrySchema.parse(status.entry)).toEqual(status.entry)
  })

  it('replaces an API URL with the track page', () => {
    const { entry, full } = row(SC_SET_API_URL_ROW)
    expect(entry.url).toMatch(/^https:\/\/api-v2\.soundcloud\.com\//)

    const status = lookupStatusOf(entryOk(full), NOW)
    expect(status.state === 'filled' && status.entry.url).toBe(full.url)
  })

  it("keeps the request's platform + id even when the track says otherwise", () => {
    const result = EntryResultSchema.parse({
      status: 'ok',
      platform: 'soundcloud',
      id: bare.entry.id,
      track: { ...bare.full, id: 'another-id' },
    })

    const status = lookupStatusOf(result, NOW)
    expect(status.state === 'filled' && status.entry.id).toBe(bare.entry.id)
  })

  it('fills a Go+ preview as the unavailable track it is', () => {
    const status = lookupStatusOf(entryOk(row(SC_SET_PREVIEW_ROW).full), NOW)
    expect(status.state === 'filled' && status.entry).toMatchObject({
      partial: false,
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
  })

  it.each<UnavailableReason>([
    'unavailable',
    'private',
    'geo_blocked',
    'age_restricted',
    'login_required',
    'preview_only',
  ])('marks a row unavailable when its lookup fails with %s', (code) => {
    const error = { code, message: 'This track is not available.' }
    expect(lookupStatusOf(entryError(bare.entry, error), NOW)).toEqual({
      state: 'unavailable',
      reason: code,
      error,
    })
  })

  it('fails a row on any other error, retried later only when the answer can change', () => {
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    const list = { code: 'invalid_request', message: 'This link is a list.' } as const

    expect(lookupStatusOf(entryError(bare.entry, limited), NOW)).toEqual({
      state: 'failed',
      error: limited,
      retryAt: NOW + 30_000,
    })
    expect(lookupStatusOf(entryError(bare.entry, list), NOW)).toEqual({
      state: 'failed',
      error: list,
      retryAt: Number.POSITIVE_INFINITY,
    })
  })

  it('waits longer for a row that failed again', () => {
    const limited = { code: 'rate_limited', message: 'SoundCloud is limiting requests.' } as const
    expect(lookupStatusOf(entryError(bare.entry, limited), NOW, 3)).toMatchObject({
      retryAt: NOW + 120_000,
    })
    expect(failedStatus(limited, NOW, 2)).toMatchObject({ retryAt: NOW + 60_000 })
  })
})

describe('rowFor', () => {
  const error: ErrorInfo = { code: 'network', message: 'Connection reset.' }

  it('shows a row not asked for yet as pending, and one in a request as loading', () => {
    expect(rowFor(bare.entry, undefined)).toEqual({ entry: bare.entry, state: 'pending' })
    expect(rowFor(bare.entry, LOADING)).toEqual({ entry: bare.entry, state: 'loading' })
  })

  it('shows the filled entry as ready', () => {
    const filled = { ...bare.full, partial: false } as const
    const shown = rowFor(bare.entry, { state: 'filled', entry: filled })
    expect(shown).toEqual({ entry: filled, state: 'ready' })
    expect(shown.entry).toBe(filled)
  })

  it('marks an unavailable row with its reason, keeping what the listing had', () => {
    const removed: ErrorInfo = { code: 'unavailable', message: 'This track was removed.' }
    const status: LookupStatus = { state: 'unavailable', reason: 'unavailable', error: removed }

    const shown = rowFor(bare.entry, status)
    expect(shown).toEqual({
      entry: { ...bare.entry, availability: 'unavailable', unavailableReason: 'unavailable' },
      state: 'ready',
      error: removed,
    })
    expect(CollectionEntrySchema.parse(shown.entry)).toEqual(shown.entry)
  })

  it('shows a failed row with its error and the entry as listed', () => {
    const shown = rowFor(bare.entry, failedStatus(error, NOW))
    expect(shown).toEqual({ entry: bare.entry, state: 'failed', error })
    expect(shown.entry).toBe(bare.entry)
  })
})

describe('failedStatus', () => {
  it('sets when to ask again from the error code', () => {
    const error: ErrorInfo = { code: 'unknown', message: 'yt-dlp failed.' }
    expect(failedStatus(error, NOW)).toEqual({ state: 'failed', error, retryAt: NOW + 30_000 })
  })
})
