import { describe, expect, it } from 'vitest'
import {
  MAX_REMIX_SUGGESTIONS,
  MAX_REMIX_UPLOADS,
  REMIX_PLATFORMS,
  RemixRequestSchema,
  type RemixSuggestion,
  RemixSuggestionSchema,
  type RemixSuggestions,
  RemixSuggestionsSchema,
  type RemixUpload,
  RemixUploadSchema,
} from './remix.ts'
import { nonHttpUrls } from './test-helpers.ts'

const youtubeUpload = {
  platform: 'youtube',
  id: 'Kp7eSUU9oy8',
  url: 'https://www.youtube.com/watch?v=Kp7eSUU9oy8',
  title: 'Moby - Porcelain (Arty Remix)',
  uploader: 'Anjunabeats',
  durationSec: 214,
  thumbnailUrl: 'https://i.ytimg.com/vi/Kp7eSUU9oy8/hqdefault.jpg',
  plays: 597540,
} satisfies RemixUpload

const soundcloudUpload = {
  platform: 'soundcloud',
  id: '279991262',
  url: 'https://soundcloud.com/anjunabeats/moby-porcelain-arty-remix',
  title: 'Moby - Porcelain (Arty Remix)',
  plays: 381927,
} satisfies RemixUpload

const suggestion = {
  kind: 'remix',
  remixer: 'Arty',
  genre: { name: 'Trance', source: 'platform' },
  plays: 597540,
  uploads: [youtubeUpload, soundcloudUpload],
} satisfies RemixSuggestion

const answer = {
  song: { title: 'Porcelain', artist: 'Moby' },
  suggestions: [suggestion],
  searches: {
    youtube: { status: 'ok', found: 12 },
    soundcloud: {
      status: 'error',
      error: { code: 'rate_limited', message: 'SoundCloud is limiting requests.' },
    },
  },
} satisfies RemixSuggestions

describe('RemixRequestSchema', () => {
  it('takes the names, with the artist, uploader and the pasted track optional', () => {
    expect(RemixRequestSchema.parse({ title: 'Porcelain' })).toEqual({ title: 'Porcelain' })
    const full = {
      title: 'Porcelain (Official Video)',
      artist: 'Moby',
      uploader: 'Moby',
      exclude: { platform: 'youtube', id: '13EifDb4GYs' },
    }
    expect(RemixRequestSchema.parse(full)).toEqual(full)
  })

  it('takes the platforms to search: one or both, never none or another', () => {
    expect(RemixRequestSchema.parse({ title: 'x', platforms: ['youtube'] }).platforms).toEqual([
      'youtube',
    ])
    expect(
      RemixRequestSchema.safeParse({ title: 'x', platforms: ['youtube', 'soundcloud'] }).success,
    ).toBe(true)
    expect(RemixRequestSchema.safeParse({ title: 'x', platforms: [] }).success).toBe(false)
    expect(RemixRequestSchema.safeParse({ title: 'x', platforms: ['spotify'] }).success).toBe(false)
  })

  it('refuses an empty title, empty fields and over-long text', () => {
    expect(RemixRequestSchema.safeParse({ title: '' }).success).toBe(false)
    expect(RemixRequestSchema.safeParse({ title: 'x', artist: '' }).success).toBe(false)
    expect(RemixRequestSchema.safeParse({ title: 'x'.repeat(1001) }).success).toBe(false)
    expect(
      RemixRequestSchema.safeParse({ title: 'x', exclude: { platform: 'youtube', id: '' } })
        .success,
    ).toBe(false)
  })
})

describe('RemixUploadSchema', () => {
  it('accepts YouTube and SoundCloud uploads only', () => {
    expect(RemixUploadSchema.parse(youtubeUpload)).toEqual(youtubeUpload)
    expect(RemixUploadSchema.parse(soundcloudUpload)).toEqual(soundcloudUpload)
    expect(REMIX_PLATFORMS).toEqual(['youtube', 'soundcloud'])
    for (const platform of ['spotify', 'other']) {
      expect(RemixUploadSchema.safeParse({ ...youtubeUpload, platform }).success).toBe(false)
    }
  })

  it('refuses a non-http URL, a fractional or negative play count', () => {
    for (const url of nonHttpUrls) {
      expect(RemixUploadSchema.safeParse({ ...youtubeUpload, url }).success).toBe(false)
      expect(RemixUploadSchema.safeParse({ ...youtubeUpload, thumbnailUrl: url }).success).toBe(
        false,
      )
    }
    expect(RemixUploadSchema.safeParse({ ...youtubeUpload, plays: 1.5 }).success).toBe(false)
    expect(RemixUploadSchema.safeParse({ ...youtubeUpload, plays: -1 }).success).toBe(false)
  })
})

describe('RemixSuggestionSchema', () => {
  it('needs 1 to MAX_REMIX_UPLOADS uploads', () => {
    expect(RemixSuggestionSchema.parse(suggestion)).toEqual(suggestion)
    expect(RemixSuggestionSchema.safeParse({ ...suggestion, uploads: [] }).success).toBe(false)
    const many = Array.from({ length: MAX_REMIX_UPLOADS + 1 }, () => youtubeUpload)
    expect(RemixSuggestionSchema.safeParse({ ...suggestion, uploads: many }).success).toBe(false)
  })

  it('takes a version without a remixer or genre, and refuses unknown kinds', () => {
    const extended = { kind: 'extended', uploads: [youtubeUpload] }
    expect(RemixSuggestionSchema.parse(extended)).toEqual(extended)
    expect(RemixSuggestionSchema.safeParse({ ...extended, kind: 'mashup' }).success).toBe(false)
    expect(
      RemixSuggestionSchema.safeParse({ ...suggestion, genre: { name: '', source: 'text' } })
        .success,
    ).toBe(false)
    expect(
      RemixSuggestionSchema.safeParse({ ...suggestion, genre: { name: 'Techno', source: 'ai' } })
        .success,
    ).toBe(false)
  })
})

describe('RemixSuggestionsSchema', () => {
  it('holds the song, the suggestions and how each search went', () => {
    expect(RemixSuggestionsSchema.parse(answer)).toEqual(answer)
  })

  it('caps the suggestions at MAX_REMIX_SUGGESTIONS', () => {
    const suggestions = Array.from({ length: MAX_REMIX_SUGGESTIONS + 1 }, () => suggestion)
    expect(RemixSuggestionsSchema.safeParse({ ...answer, suggestions }).success).toBe(false)
  })

  it('marks a platform the request skipped', () => {
    const skipped = {
      ...answer,
      searches: { ...answer.searches, soundcloud: { status: 'skipped' } },
    }
    expect(RemixSuggestionsSchema.parse(skipped)).toEqual(skipped)
  })

  it('needs both searches', () => {
    const { soundcloud: _, ...youtubeOnly } = answer.searches
    expect(RemixSuggestionsSchema.safeParse({ ...answer, searches: youtubeOnly }).success).toBe(
      false,
    )
  })
})
