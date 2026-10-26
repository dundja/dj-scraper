import {
  MAX_TRACK_TEXT_LENGTH,
  MAX_URL_LENGTH,
  RemixRequestSchema,
  RemixUploadSchema,
  TrackRefSchema,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { artySoundcloud, artyYoutube, bareUpload } from '@/test/remixes.ts'
import { previewTrack, spotifyTrack, track, trackWith } from '@/test/resolve.ts'
import { remixRequestFor, uploadRef } from './remix-request.ts'

describe('remixRequestFor', () => {
  it("sends the track's names and leaves the track itself out of the answer", () => {
    expect(remixRequestFor(track)).toStrictEqual({
      title: 'The Chill Zone',
      artist: 'Royalty Free Music',
      uploader: 'Royalty Free Music Crew',
      exclude: { platform: 'youtube', id: track.id },
    })
  })

  it('asks for both platforms by leaving them out', () => {
    expect(remixRequestFor(track)).not.toHaveProperty('platforms')
  })

  it('leaves out the names a track lacks', () => {
    const bare = trackWith({ artist: undefined, uploader: undefined })
    expect(remixRequestFor(bare)).toStrictEqual({
      title: 'The Chill Zone',
      exclude: { platform: 'youtube', id: track.id },
    })
  })

  it('searches for unavailable and Spotify tracks too', () => {
    expect(remixRequestFor(previewTrack).exclude).toEqual({
      platform: 'soundcloud',
      id: previewTrack.id,
    })
    expect(remixRequestFor(spotifyTrack).exclude).toEqual({
      platform: 'spotify',
      id: spotifyTrack.id,
    })
    expect(RemixRequestSchema.safeParse(remixRequestFor(spotifyTrack)).success).toBe(true)
  })

  it('clips names the contract caps (a track title can be any length)', () => {
    const long = trackWith({
      title: 't'.repeat(MAX_TRACK_TEXT_LENGTH + 50),
      artist: 'a'.repeat(MAX_TRACK_TEXT_LENGTH + 1),
      uploader: 'u'.repeat(MAX_TRACK_TEXT_LENGTH + 1),
    })
    const request = remixRequestFor(long)
    expect(request.title).toHaveLength(MAX_TRACK_TEXT_LENGTH)
    expect(request.artist).toHaveLength(MAX_TRACK_TEXT_LENGTH)
    expect(request.uploader).toHaveLength(MAX_TRACK_TEXT_LENGTH)
    expect(RemixRequestSchema.safeParse(request).success).toBe(true)
  })
})

describe('uploadRef', () => {
  it("keeps an upload's page, names, length and artwork, and nothing about its availability", () => {
    expect(uploadRef(artyYoutube)).toStrictEqual({
      platform: 'youtube',
      id: artyYoutube.id,
      url: artyYoutube.url,
      title: 'Moby - Porcelain (Arty Remix)',
      uploader: 'Anjunabeats',
      durationSec: 214,
      thumbnailUrl: artyYoutube.thumbnailUrl,
    })
  })

  it('makes a valid TrackRef of a SoundCloud upload and of one with only its names', () => {
    expect(TrackRefSchema.strict().parse(uploadRef(artySoundcloud))).toMatchObject({
      platform: 'soundcloud',
      id: artySoundcloud.id,
    })
    expect(uploadRef(bareUpload)).toStrictEqual({
      platform: 'soundcloud',
      id: bareUpload.id,
      url: bareUpload.url,
      title: 'Porcelain remix',
    })
  })

  it('leaves out its plays, which a TrackRef has no field for', () => {
    expect(uploadRef(artyYoutube)).not.toHaveProperty('plays')
  })

  it('clips a long title the way toTrackRef does, and keeps a URL the contract allows', () => {
    const upload = RemixUploadSchema.parse({
      ...artyYoutube,
      title: 'x'.repeat(MAX_TRACK_TEXT_LENGTH),
      thumbnailUrl: `https://i.ytimg.com/${'v'.repeat(MAX_URL_LENGTH - 30)}.jpg`,
    })
    const ref = uploadRef(upload)
    expect(ref.title).toBe(upload.title)
    expect(ref.thumbnailUrl).toBe(upload.thumbnailUrl)
    expect(TrackRefSchema.safeParse(ref).success).toBe(true)
  })
})
