import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { ErrorCode } from './errors.ts'
import type { Platform } from './platform.ts'
import { issuePaths, nonHttpUrls, type OptionalKeys, without } from './test-helpers.ts'
import {
  type AudioSource,
  AudioSourceSchema,
  type Availability,
  AvailabilitySchema,
  MAX_ID_LENGTH,
  type Track,
  TrackSchema,
  type UnavailableReason,
  UnavailableReasonSchema,
} from './track.ts'

// YouTube reports whole-second durations; SoundCloud's come from milliseconds, so they are fractional.
const youtubeTrack = {
  id: 'dQw4w9WgXcQ',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
  artist: 'Rick Astley',
  uploader: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  availability: 'available',
  source: { codec: 'opus', bitrateKbps: 135.817 },
} satisfies Track

const soundcloudTrack = {
  id: '1234567890',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/deep-house-edit',
  title: 'Some Artist - Deep House Edit',
  uploader: 'Some Artist',
  durationSec: 212.53,
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000123456789-abcdef-t500x500.jpg',
  availability: 'available',
  source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
} satisfies Track

const privatePlaylistEntry = {
  id: 'aBcDeFgHiJk',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk',
  title: '[Private video]',
  availability: 'unavailable',
  unavailableReason: 'private',
} satisfies Track

const goPlusPreviewTrack = {
  id: '1234567891',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-label/go-plus-exclusive',
  title: 'Some Label - Go+ Exclusive',
  uploader: 'Some Label',
  durationSec: 30,
  availability: 'unavailable',
  unavailableReason: 'preview_only',
} satisfies Track

const requiredOnlyTrack = {
  id: 'track-01',
  platform: 'other',
  url: 'https://example.com/audio/track-01',
  title: 'Track 01',
  availability: 'unknown',
} satisfies Track

/** Every field set, so omitting any one of them is a real change. */
const geoBlockedTrack = {
  ...youtubeTrack,
  availability: 'unavailable',
  unavailableReason: 'geo_blocked',
} satisfies Track

const requiredFields = ['id', 'platform', 'url', 'title', 'availability'] as const
const optionalFields = [
  'artist',
  'uploader',
  'durationSec',
  'thumbnailUrl',
  'unavailableReason',
  'source',
] as const
const urlFields = ['url', 'thumbnailUrl'] as const
const nonEmptyStringFields = ['id', 'title', 'artist', 'uploader'] as const

describe('AvailabilitySchema', () => {
  it('rejects an error code in place of an availability', () => {
    expect(AvailabilitySchema.safeParse('private').success).toBe(false)
  })

  it('is exactly available, unavailable or unknown', () => {
    expectTypeOf<Availability>().toEqualTypeOf<'available' | 'unavailable' | 'unknown'>()
  })
})

describe('UnavailableReasonSchema', () => {
  it.each(['network', 'invalid_url', 'canceled'])(
    'rejects the error code %s, which does not explain why a track is unavailable',
    (code) => {
      expect(UnavailableReasonSchema.safeParse(code).success).toBe(false)
    },
  )

  it('rejects free text such as a yt-dlp error message', () => {
    expect(UnavailableReasonSchema.safeParse('This video is private').success).toBe(false)
  })

  it('is exactly the error codes that explain an unavailable track', () => {
    expectTypeOf<UnavailableReason>().toEqualTypeOf<
      | 'unavailable'
      | 'private'
      | 'geo_blocked'
      | 'age_restricted'
      | 'login_required'
      | 'preview_only'
    >()
    expectTypeOf<UnavailableReason>().toExtend<ErrorCode>()
  })
})

describe('AudioSourceSchema', () => {
  // Codecs are yt-dlp's raw `acodec` values for the stream that would be downloaded.
  it.each([
    ['YouTube Opus (format 251)', { codec: 'opus', bitrateKbps: 135.817 }],
    ['YouTube AAC (format 140)', { codec: 'mp4a.40.2', bitrateKbps: 129.502 }],
    ['SoundCloud AAC (hls_aac_160k)', { codec: 'mp4a.40.2', bitrateKbps: 160 }],
    ['SoundCloud MP3 (http_mp3_0_0)', { codec: 'mp3', bitrateKbps: 128 }],
    ['a codec with an unknown bitrate', { codec: 'opus' }],
  ])('parses %s unchanged', (_label, source) => {
    expect(AudioSourceSchema.parse(source)).toStrictEqual(source)
  })

  it('rejects an empty codec', () => {
    expect(issuePaths(AudioSourceSchema, { codec: '' })).toEqual([['codec']])
  })

  it('rejects an empty source: unknown is expressed by omitting it', () => {
    expect(issuePaths(AudioSourceSchema, {})).toEqual([[]])
  })

  it.each([
    ['zero (an unknown bitrate is omitted instead)', 0],
    ['negative', -128],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '160'],
  ])('rejects a bitrate that is %s', (_label, bitrateKbps) => {
    const input = { codec: 'mp4a.40.2', bitrateKbps }
    expect(issuePaths(AudioSourceSchema, input)).toEqual([['bitrateKbps']])
  })

  it('strips unknown keys such as raw yt-dlp format fields', () => {
    const input = { codec: 'opus', bitrateKbps: 135.817, format_id: '251', ext: 'webm', asr: 48000 }
    expect(AudioSourceSchema.parse(input)).toStrictEqual({ codec: 'opus', bitrateKbps: 135.817 })
  })

  it('has only optional fields', () => {
    expectTypeOf<AudioSource>().toEqualTypeOf<{
      codec?: string | undefined
      bitrateKbps?: number | undefined
    }>()
  })
})

describe('TrackSchema', () => {
  it.each([
    ['a YouTube video', youtubeTrack],
    ['a SoundCloud track', soundcloudTrack],
    ['a private YouTube playlist entry', privatePlaylistEntry],
    ['a SoundCloud Go+ track that only has a preview', goPlusPreviewTrack],
    ['a track with only the required fields', requiredOnlyTrack],
  ])('parses %s unchanged', (_label, track) => {
    expect(TrackSchema.parse(track)).toStrictEqual(track)
  })

  it.each(requiredFields)('requires %s', (field) => {
    expect(issuePaths(TrackSchema, without(youtubeTrack, field))).toEqual([[field]])
  })

  it.each(optionalFields)('allows %s to be omitted', (field) => {
    expect(issuePaths(TrackSchema, without(geoBlockedTrack, field))).toEqual([])
  })

  it.each(optionalFields)('rejects null for %s (normalizers must drop yt-dlp nulls)', (field) => {
    expect(issuePaths(TrackSchema, { ...geoBlockedTrack, [field]: null })).toEqual([[field]])
  })

  it.each([
    ['platform', 'spotify'],
    ['availability', 'private'],
    ['unavailableReason', 'This video is private'],
    ['unavailableReason', 'network'],
  ])('rejects %s %j', (field, value) => {
    expect(issuePaths(TrackSchema, { ...privatePlaylistEntry, [field]: value })).toEqual([[field]])
  })

  it.each(urlFields.flatMap((field) => nonHttpUrls.map((url) => ({ field, url }))))(
    'rejects $url as $field',
    ({ field, url }) => {
      expect(issuePaths(TrackSchema, { ...youtubeTrack, [field]: url })).toEqual([[field]])
    },
  )

  it.each(nonEmptyStringFields)('rejects an empty %s', (field) => {
    expect(issuePaths(TrackSchema, { ...youtubeTrack, [field]: '' })).toEqual([[field]])
  })

  it('accepts an id of MAX_ID_LENGTH characters and rejects a longer one', () => {
    const id = 'a'.repeat(MAX_ID_LENGTH)
    expect(issuePaths(TrackSchema, { ...youtubeTrack, id })).toEqual([])
    expect(issuePaths(TrackSchema, { ...youtubeTrack, id: `${id}a` })).toEqual([['id']])
  })

  it('reports an invalid source at its nested path', () => {
    const input = { ...youtubeTrack, source: { codec: '', bitrateKbps: -1 } }
    expect(issuePaths(TrackSchema, input)).toEqual([
      ['source', 'codec'],
      ['source', 'bitrateKbps'],
    ])
  })

  it.each([0, 212.53, 7384.1])('accepts a duration of %s seconds', (durationSec) => {
    expect(TrackSchema.parse({ ...soundcloudTrack, durationSec }).durationSec).toBe(durationSec)
  })

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '212.53'],
  ])('rejects a duration that is %s', (_label, durationSec) => {
    expect(issuePaths(TrackSchema, { ...soundcloudTrack, durationSec })).toEqual([['durationSec']])
  })

  it('strips unknown keys such as raw yt-dlp fields instead of rejecting them', () => {
    const input = {
      ...youtubeTrack,
      _type: 'url',
      ie_key: 'Youtube',
      channel_id: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      live_status: 'not_live',
      source: { ...youtubeTrack.source, format_id: '251' },
    }
    expect(TrackSchema.parse(input)).toStrictEqual(youtubeTrack)
  })

  it('makes exactly the documented fields optional', () => {
    expectTypeOf<OptionalKeys<Track>>().toEqualTypeOf<(typeof optionalFields)[number]>()
    expectTypeOf<Exclude<keyof Track, OptionalKeys<Track>>>().toEqualTypeOf<
      (typeof requiredFields)[number]
    >()
  })

  it('types fields with the shared enums and AudioSource', () => {
    expectTypeOf<Track['platform']>().toEqualTypeOf<Platform>()
    expectTypeOf<Track['availability']>().toEqualTypeOf<Availability>()
    expectTypeOf<Track['unavailableReason']>().toEqualTypeOf<UnavailableReason | undefined>()
    expectTypeOf<Track['source']>().toEqualTypeOf<AudioSource | undefined>()
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof TrackSchema>>().toEqualTypeOf<Track>()
  })
})
