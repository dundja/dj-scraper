// The resolve fixtures promise these shapes in their docs; other tests rely on them.
import { classifyUrl, MAX_COLLECTION_ENTRIES } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  ambiguous,
  bigPlaylist,
  collectionResult,
  collectionWith,
  entryError,
  entryOk,
  PLAYLIST_SPECIAL_ROWS,
  playlist,
  previewTrack,
  SC_SET_API_URL_ROW,
  SC_SET_FULL_ROWS,
  SC_SET_PREVIEW_ROW,
  scSet,
  scSetTracks,
  scTrack,
  selectableEntries,
  track,
  trackResult,
  trackWith,
  urls,
  userPage,
  userPageWithLists,
} from './resolve.ts'

describe('resolve fixtures', () => {
  it('has a YouTube track with an AAC source and a SoundCloud one with MP3 128', () => {
    expect(track).toMatchObject({ platform: 'youtube', source: { codec: 'mp4a.40.2' } })
    expect(scTrack).toMatchObject({
      platform: 'soundcloud',
      source: { codec: 'mp3', bitrateKbps: 128 },
    })
    expect(previewTrack).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
    expect(previewTrack.source).toBeUndefined()
  })

  it('has an ambiguous answer per list kind', () => {
    expect(ambiguous.playlist.collectionKind).toBe('playlist')
    expect(ambiguous.album.collectionKind).toBe('album')
    expect(ambiguous.mix).toMatchObject({ collectionKind: 'mix', collectionUrl: urls.mix })
  })

  it('has a 30-row YouTube playlist with the special rows its docs list', () => {
    const rows = playlist.entries
    const special = PLAYLIST_SPECIAL_ROWS
    expect(rows).toHaveLength(30)
    expect(playlist).toMatchObject({ trackCount: 30, owner: 'Crate Diggers', truncated: false })
    expect(rows[special.privateVideo]).toMatchObject({
      title: '[Private video]',
      availability: 'unavailable',
      unavailableReason: 'private',
    })
    expect(rows[special.deletedVideo]).toMatchObject({
      title: '[Deleted video]',
      unavailableReason: 'unavailable',
    })
    expect(rows[special.noArtist]?.artist).toBeUndefined()
    expect(rows[special.noArtist]?.uploader).toBeDefined()
    expect(rows[special.noDuration]?.durationSec).toBeUndefined()
    expect(rows[special.noArtwork]?.thumbnailUrl).toBeUndefined()
    expect(rows[special.duplicateOf5]?.id).toBe(rows[5]?.id)
    expect(rows.filter((row) => row.availability === 'unknown').length).toBeGreaterThan(10)
    expect(rows.filter((row) => row.availability === 'available').length).toBeGreaterThan(3)
    expect(rows.every((row) => !row.partial)).toBe(true)
    expect(selectableEntries(playlist)).toHaveLength(28)
  })

  it('has a SoundCloud set whose later rows are partial, and their full tracks', () => {
    const rows = scSet.entries
    expect(rows).toHaveLength(8)
    expect(scSet.durationSec).toBeGreaterThan(0)
    expect(rows.map((row) => row.partial)).toEqual([
      ...Array(SC_SET_FULL_ROWS).fill(false),
      ...Array(8 - SC_SET_FULL_ROWS).fill(true),
    ])
    expect(rows[SC_SET_API_URL_ROW]?.url).toMatch(/^https:\/\/api-v2\.soundcloud\.com\/tracks\//)
    expect(rows[SC_SET_FULL_ROWS]?.title).toBeUndefined()
    expect(scSetTracks.map((full) => full.id)).toEqual(rows.map((row) => row.id))
    expect(scSetTracks[SC_SET_PREVIEW_ROW]).toMatchObject({ unavailableReason: 'preview_only' })
  })

  it('builds big playlists up to the listing cap, once per size', () => {
    const big = bigPlaylist(MAX_COLLECTION_ENTRIES)
    expect(big.entries).toHaveLength(MAX_COLLECTION_ENTRIES)
    expect(new Set(big.entries.map((row) => row.id)).size).toBe(MAX_COLLECTION_ENTRIES)
    expect(bigPlaylist(MAX_COLLECTION_ENTRIES)).toBe(big)
    expect(bigPlaylist(3).entries.map((row) => row.title)).toEqual([
      'Track 1',
      'Track 2',
      'Track 3',
    ])
  })

  it('has user pages that list sets', () => {
    expect(userPageWithLists.entries).toEqual([])
    expect(userPageWithLists.lists).toHaveLength(4)
    expect(userPageWithLists.skippedEntries).toBe(4)
    expect(userPage.entries).toHaveLength(3)
    expect(userPage.lists).toHaveLength(1)
    expect(userPage.skippedEntries).toBe(2)
  })

  it('wraps tracks and collections as resolve answers and entry results', () => {
    expect(trackResult()).toEqual({ kind: 'track', track })
    expect(collectionResult(scSet)).toEqual({ kind: 'collection', collection: scSet })
    const [full] = scSetTracks
    if (full === undefined) throw new Error('fixture has tracks')
    expect(entryOk(full)).toEqual({
      status: 'ok',
      platform: 'soundcloud',
      id: full.id,
      track: full,
    })
    expect(entryError(full, { code: 'rate_limited', message: 'Too many requests.' })).toEqual({
      status: 'error',
      platform: 'soundcloud',
      id: full.id,
      error: { code: 'rate_limited', message: 'Too many requests.' },
    })
  })

  it('validates changes against the contract', () => {
    expect(trackWith({ title: 'Edit' }).title).toBe('Edit')
    expect(collectionWith(playlist, { trackCount: 214 }).trackCount).toBe(214)
    expect(() => trackWith({ title: '' })).toThrow()
  })

  it('has paste URLs that classify as their kind, and a DRM one that is refused', () => {
    expect(classifyUrl(urls.track)).toMatchObject({ ok: true, guess: 'track' })
    expect(classifyUrl(urls.playlist)).toMatchObject({ ok: true, guess: 'collection' })
    expect(classifyUrl(urls.scSet)).toMatchObject({ ok: true, guess: 'collection' })
    expect(classifyUrl(urls.drm)).toMatchObject({ ok: true, kind: 'out_of_scope' })
  })
})
