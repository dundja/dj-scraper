import {
  type CollectionEntry,
  CollectionEntrySchema,
  DownloadOptionsSchema,
  MAX_SUBFOLDER_LENGTH,
  MAX_TRACK_TEXT_LENGTH,
  TrackRefSchema,
  TrackSchema,
} from '@dj-scraper/shared'
import { soundcloudRowRef, youtubeRef } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { settings } from '@/test/downloads.ts'
import { playlist, previewTrack, scSet, track } from '@/test/resolve.ts'
import { downloadOptionsFrom, toTrackRef, trackKey } from './track-ref.ts'

describe('toTrackRef', () => {
  it("keeps a track's display fields and drops its source", () => {
    expect(track.source).toBeDefined()
    expect(toTrackRef(track)).toStrictEqual({
      platform: 'youtube',
      id: track.id,
      url: track.url,
      title: track.title,
      artist: track.artist,
      uploader: track.uploader,
      durationSec: track.durationSec,
      thumbnailUrl: track.thumbnailUrl,
      availability: 'available',
    })
  })

  it("drops a collection row's partial flag, so the server accepts the ref", () => {
    const row = playlist.entries[0]
    if (row === undefined) throw new Error('fixture has rows')
    const ref = toTrackRef(row)
    expect(ref).not.toHaveProperty('partial')
    expect(TrackRefSchema.strict().parse(ref)).toStrictEqual(ref)
  })

  it('sends a partial SoundCloud row as just platform, id, url and availability', () => {
    const row = scSet.entries.find((entry) => entry.partial)
    if (row === undefined) throw new Error('fixture has partial rows')
    expect(toTrackRef(row)).toStrictEqual({
      platform: 'soundcloud',
      id: row.id,
      url: row.url,
      availability: 'unknown',
    })
  })

  it('keeps why a track is unavailable, so the server fails it without a download', () => {
    expect(toTrackRef(previewTrack)).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
  })

  it('clips text the contract caps and leaves out an artwork URL it would refuse', () => {
    const long = TrackSchema.parse({
      ...youtubeRef,
      title: 'x'.repeat(MAX_TRACK_TEXT_LENGTH + 500),
      artist: 'a'.repeat(MAX_TRACK_TEXT_LENGTH + 1),
      uploader: 'u'.repeat(MAX_TRACK_TEXT_LENGTH),
      thumbnailUrl: `https://i.ytimg.com/vi/${'v'.repeat(3000)}.jpg`,
    })
    const ref = toTrackRef(long)

    expect(ref.title).toHaveLength(MAX_TRACK_TEXT_LENGTH)
    expect(ref.title?.endsWith('…')).toBe(true)
    expect(ref.artist).toHaveLength(MAX_TRACK_TEXT_LENGTH)
    expect(ref.uploader).toBe(long.uploader)
    expect(ref).not.toHaveProperty('thumbnailUrl')
    expect(TrackRefSchema.safeParse(ref).success).toBe(true)
  })

  it('makes a valid TrackRef of every fixture row', () => {
    const rows: CollectionEntry[] = [...playlist.entries, ...scSet.entries]
    for (const row of rows) {
      CollectionEntrySchema.parse(row)
      expect(TrackRefSchema.safeParse(toTrackRef(row)).success, row.id).toBe(true)
    }
  })
})

describe('trackKey', () => {
  it('joins platform and id', () => {
    expect(trackKey(track)).toBe(`youtube:${track.id}`)
    expect(trackKey(soundcloudRowRef)).toBe('soundcloud:1234567893')
    expect(trackKey(toTrackRef(track))).toBe(trackKey(track))
  })

  it('tells the same id on two platforms apart', () => {
    expect(trackKey({ platform: 'youtube', id: '1' })).not.toBe(
      trackKey({ platform: 'soundcloud', id: '1' }),
    )
  })
})

describe('downloadOptionsFrom', () => {
  it('takes the format, file names, artwork and comment settings', () => {
    expect(downloadOptionsFrom({ ...settings, format: 'aiff', embedArtwork: false })).toStrictEqual(
      {
        format: 'aiff',
        filenameTemplate: '{artist} - {title}',
        embedArtwork: false,
        sourceUrlComment: true,
      },
    )
  })

  it('adds a subfolder, trimmed', () => {
    expect(downloadOptionsFrom(settings, '  Late Night Selects ').subfolder).toBe(
      'Late Night Selects',
    )
  })

  it('leaves a blank subfolder out', () => {
    expect(downloadOptionsFrom(settings, '   ')).not.toHaveProperty('subfolder')
    expect(downloadOptionsFrom(settings, '')).not.toHaveProperty('subfolder')
    expect(downloadOptionsFrom(settings)).not.toHaveProperty('subfolder')
  })

  it('clips a subfolder the contract would refuse', () => {
    const options = downloadOptionsFrom(settings, 'A very long playlist title '.repeat(20))
    expect(options.subfolder).toHaveLength(MAX_SUBFOLDER_LENGTH)
    expect(DownloadOptionsSchema.safeParse(options).success).toBe(true)
  })
})
