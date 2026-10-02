import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { Collection, CollectionKind } from './collection.ts'
import type { ErrorInfo } from './errors.ts'
import type { Platform } from './platform.ts'
import {
  type AmbiguousListKind,
  AmbiguousListKindSchema,
  type EntryRef,
  EntryRefSchema,
  type EntryResult,
  EntryResultSchema,
  MAX_COLLECTION_ENTRIES,
  MAX_ENTRIES_PER_REQUEST,
  MAX_MIX_ENTRIES,
  type ResolveEntriesRequest,
  ResolveEntriesRequestSchema,
  type ResolveEntriesResponse,
  ResolveEntriesResponseSchema,
  type ResolveMode,
  ResolveModeSchema,
  type ResolveRequest,
  ResolveRequestSchema,
  type ResolveResult,
  ResolveResultSchema,
} from './resolve.ts'
import { issuePaths, nonHttpUrls, without } from './test-helpers.ts'
import { MAX_ID_LENGTH, type Track } from './track.ts'
import { MAX_URL_LENGTH } from './url.ts'

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
  source: { codec: 'mp4a.40.2', bitrateKbps: 129.502 },
} satisfies Track

const soundcloudSet = {
  id: '1876543210',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/sets/summer-2026',
  kind: 'set',
  title: 'Summer 2026',
  owner: 'Some Artist',
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000987654321-fedcba-t500x500.jpg',
  trackCount: 2,
  durationSec: 425.06,
  truncated: false,
  entries: [
    {
      id: '1234567890',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/some-artist/deep-house-edit',
      title: 'Some Artist - Deep House Edit',
      durationSec: 212.53,
      availability: 'available',
      partial: false,
    },
    {
      id: '1234567893',
      platform: 'soundcloud',
      url: 'https://api-v2.soundcloud.com/tracks/1234567893',
      availability: 'unknown',
      partial: true,
    },
  ],
} satisfies Collection

const playlistUrl = 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'

const trackResult = { kind: 'track', track: youtubeTrack } satisfies ResolveResult
const collectionResult = { kind: 'collection', collection: soundcloudSet } satisfies ResolveResult
const ambiguousResult = {
  kind: 'ambiguous',
  track: youtubeTrack,
  collectionUrl: playlistUrl,
  collectionKind: 'playlist',
} satisfies ResolveResult
const ambiguousMixResult = {
  kind: 'ambiguous',
  track: youtubeTrack,
  collectionUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  collectionKind: 'mix',
} satisfies ResolveResult

describe('ResolveResultSchema', () => {
  it.each([
    ['a single track', trackResult],
    ['a collection with full and partial entries', collectionResult],
    ['an ambiguous watch?v=…&list=… link', ambiguousResult],
    ['an ambiguous link into a mix', ambiguousMixResult],
  ])('parses %s unchanged', (_label, input) => {
    expect(ResolveResultSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['an unknown kind', { kind: 'playlist', collection: soundcloudSet }],
    ['a capitalised kind', { kind: 'Track', track: youtubeTrack }],
    ['an empty kind', { kind: '', track: youtubeTrack }],
    ['a missing kind', { track: youtubeTrack }],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(ResolveResultSchema, input)).toEqual([['kind']])
  })

  it.each([
    ['track without its track', { kind: 'track' }, ['track']],
    ['collection without its collection', { kind: 'collection' }, ['collection']],
    ['ambiguous without its track', without(ambiguousResult, 'track'), ['track']],
    [
      'ambiguous without its collectionUrl',
      without(ambiguousResult, 'collectionUrl'),
      ['collectionUrl'],
    ],
    [
      'ambiguous without its collectionKind',
      without(ambiguousResult, 'collectionKind'),
      ['collectionKind'],
    ],
  ])('rejects %s', (_label, input, missing) => {
    expect(issuePaths(ResolveResultSchema, input)).toEqual([missing])
  })

  it.each(['set', 'channel', 'likes', 'other', 'radio'])(
    'rejects %j as the collectionKind of an ambiguous result',
    (collectionKind) => {
      const input = { ...ambiguousResult, collectionKind }
      expect(issuePaths(ResolveResultSchema, input)).toEqual([['collectionKind']])
    },
  )

  it.each([
    [
      'collection with a track payload',
      { kind: 'collection', track: youtubeTrack },
      ['collection'],
    ],
    ['track with a collection payload', { kind: 'track', collection: soundcloudSet }, ['track']],
  ])('rejects a %s', (_label, input, missing) => {
    expect(issuePaths(ResolveResultSchema, input)).toEqual([missing])
  })

  it('validates the payload of the chosen variant', () => {
    const input = { kind: 'track', track: { ...youtubeTrack, url: 'javascript:alert(1)' } }
    expect(issuePaths(ResolveResultSchema, input)).toEqual([['track', 'url']])
  })

  it.each(nonHttpUrls)('rejects %s as the collectionUrl of an ambiguous result', (url) => {
    const input = { ...ambiguousResult, collectionUrl: url }
    expect(issuePaths(ResolveResultSchema, input)).toEqual([['collectionUrl']])
  })

  it('strips unknown keys, including payloads of other variants, instead of rejecting them', () => {
    const input = {
      ...trackResult,
      collection: soundcloudSet,
      collectionUrl: playlistUrl,
      collectionKind: 'playlist',
      webpage_url_domain: 'youtube.com',
    }
    expect(ResolveResultSchema.parse(input)).toStrictEqual(trackResult)
  })

  it('re-parses equal after a JSON round-trip, as the /api/resolve response body', () => {
    const parsed = ResolveResultSchema.parse(collectionResult)
    expect(ResolveResultSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(parsed)
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof ResolveResultSchema>>().toEqualTypeOf<ResolveResult>()
  })

  it('discriminates on kind', () => {
    expectTypeOf<ResolveResult['kind']>().toEqualTypeOf<'track' | 'collection' | 'ambiguous'>()
    expectTypeOf<Extract<ResolveResult, { kind: 'track' }>>().toEqualTypeOf<{
      kind: 'track'
      track: Track
    }>()
    expectTypeOf<Extract<ResolveResult, { kind: 'collection' }>>().toEqualTypeOf<{
      kind: 'collection'
      collection: Collection
    }>()
    expectTypeOf<Extract<ResolveResult, { kind: 'ambiguous' }>>().toEqualTypeOf<{
      kind: 'ambiguous'
      track: Track
      collectionUrl: string
      collectionKind: AmbiguousListKind
    }>()
  })

  it('narrows to the variant payload when switching on kind', () => {
    const titleOf = (result: ResolveResult): string => {
      switch (result.kind) {
        case 'track':
          return result.track.title
        case 'collection':
          return result.collection.title
        case 'ambiguous':
          expectTypeOf(result.collectionUrl).toEqualTypeOf<string>()
          return result.track.title
        default:
          return result satisfies never
      }
    }
    expect(titleOf(ResolveResultSchema.parse(trackResult))).toBe(youtubeTrack.title)
    expect(titleOf(ResolveResultSchema.parse(collectionResult))).toBe('Summer 2026')
    expect(titleOf(ResolveResultSchema.parse(ambiguousResult))).toBe(youtubeTrack.title)
  })
})

describe('listing limits', () => {
  it('caps listings at YouTube’s own playlist limit and mixes far below it', () => {
    expect(MAX_COLLECTION_ENTRIES).toBe(5000)
    expect(MAX_MIX_ENTRIES).toBe(50)
    expect(MAX_MIX_ENTRIES).toBeLessThan(MAX_COLLECTION_ENTRIES)
  })

  it('enriches at most a screenful of rows per request', () => {
    expect(MAX_ENTRIES_PER_REQUEST).toBe(25)
  })
})

describe('ResolveModeSchema', () => {
  it.each(['auto', 'track', 'collection'])('accepts %j', (mode) => {
    expect(ResolveModeSchema.parse(mode)).toBe(mode)
  })

  it.each(['playlist', 'Auto', '', null])('rejects %j', (mode) => {
    expect(ResolveModeSchema.safeParse(mode).success).toBe(false)
  })

  it('is exactly the three documented modes', () => {
    expectTypeOf<ResolveMode>().toEqualTypeOf<'auto' | 'track' | 'collection'>()
  })
})

describe('ResolveRequestSchema', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'

  it('defaults mode to auto', () => {
    expect(ResolveRequestSchema.parse({ url })).toStrictEqual({ url, mode: 'auto' })
  })

  it.each(['track', 'collection'] as const)('keeps an explicit mode %j', (mode) => {
    expect(ResolveRequestSchema.parse({ url, mode })).toStrictEqual({ url, mode })
  })

  // classifyUrl validates the url, so the server can answer invalid_url with a precise message.
  it.each(['youtu.be/dQw4w9WgXcQ', 'not a link', ''])(
    'leaves validating the url %j to classifyUrl',
    (pasted) => {
      expect(ResolveRequestSchema.parse({ url: pasted })).toStrictEqual({
        url: pasted,
        mode: 'auto',
      })
    },
  )

  it.each([
    ['without a url', { mode: 'auto' }, ['url']],
    ['with a non-string url', { url: 42 }, ['url']],
    ['with an unknown mode', { url, mode: 'playlist' }, ['mode']],
    ['with a null mode', { url, mode: null }, ['mode']],
  ])('rejects a request %s', (_label, input, path) => {
    expect(issuePaths(ResolveRequestSchema, input)).toEqual([path])
  })

  it('strips unknown keys', () => {
    expect(ResolveRequestSchema.parse({ url, mode: 'track', format: 'mp3' })).toStrictEqual({
      url,
      mode: 'track',
    })
  })

  it('makes mode optional on input and always present on output', () => {
    expectTypeOf<z.input<typeof ResolveRequestSchema>>().toEqualTypeOf<{
      url: string
      mode?: ResolveMode | undefined
    }>()
    expectTypeOf<ResolveRequest>().toEqualTypeOf<{ url: string; mode: ResolveMode }>()
  })
})

describe('AmbiguousListKindSchema', () => {
  it.each(['playlist', 'album', 'mix'])('accepts %j', (kind) => {
    expect(AmbiguousListKindSchema.parse(kind)).toBe(kind)
  })

  it.each(['set', 'channel', 'likes', 'other'])('rejects the collection kind %j', (kind) => {
    expect(AmbiguousListKindSchema.safeParse(kind).success).toBe(false)
  })

  it('is the YouTube list kinds of CollectionKind', () => {
    expectTypeOf<AmbiguousListKind>().toEqualTypeOf<'playlist' | 'album' | 'mix'>()
    expectTypeOf<AmbiguousListKind>().toExtend<CollectionKind>()
  })
})

const bareRef = {
  platform: 'soundcloud',
  id: '1234567893',
  url: 'https://api-v2.soundcloud.com/tracks/1234567893',
} satisfies EntryRef

const pageRef = {
  platform: 'soundcloud',
  id: '1234567892',
  url: 'https://soundcloud.com/some-artist/warehouse-dub',
} satisfies EntryRef

describe('EntryRefSchema', () => {
  it.each([
    ['a bare set row with an API url', bareRef],
    ['a user-page row with a page url', pageRef],
  ])('parses %s unchanged', (_label, ref) => {
    expect(EntryRefSchema.parse(ref)).toStrictEqual(ref)
  })

  it.each(['platform', 'id', 'url'])('requires %s', (field) => {
    expect(issuePaths(EntryRefSchema, without(bareRef, field))).toEqual([[field]])
  })

  it.each(nonHttpUrls)('rejects %s as the url', (url) => {
    expect(issuePaths(EntryRefSchema, { ...bareRef, url })).toEqual([['url']])
  })

  it('accepts a url of exactly MAX_URL_LENGTH characters', () => {
    const base = 'https://soundcloud.com/some-artist/'
    const url = base + 'a'.repeat(MAX_URL_LENGTH - base.length)
    expect(issuePaths(EntryRefSchema, { ...bareRef, url })).toEqual([])
  })

  it('rejects a url longer than MAX_URL_LENGTH', () => {
    const base = 'https://soundcloud.com/some-artist/'
    const url = base + 'a'.repeat(MAX_URL_LENGTH - base.length + 1)
    expect(issuePaths(EntryRefSchema, { ...bareRef, url })).toEqual([['url']])
  })

  it('accepts an id of MAX_ID_LENGTH characters', () => {
    expect(issuePaths(EntryRefSchema, { ...bareRef, id: 'a'.repeat(MAX_ID_LENGTH) })).toEqual([])
  })

  it.each([
    ['an empty id', { ...bareRef, id: '' }, 'id'],
    ['a numeric id', { ...bareRef, id: 1234567893 }, 'id'],
    ['an id longer than MAX_ID_LENGTH', { ...bareRef, id: 'a'.repeat(MAX_ID_LENGTH + 1) }, 'id'],
    ['an out-of-scope platform', { ...bareRef, platform: 'spotify' }, 'platform'],
  ])('rejects %s', (_label, input, path) => {
    expect(issuePaths(EntryRefSchema, input)).toEqual([[path]])
  })

  it('strips row fields the server does not need', () => {
    const row = { ...bareRef, availability: 'unknown', partial: true, title: 'Warehouse Dub' }
    expect(EntryRefSchema.parse(row)).toStrictEqual(bareRef)
  })

  it('types the ref as platform, id and url', () => {
    expectTypeOf<EntryRef>().toEqualTypeOf<{ platform: Platform; id: string; url: string }>()
  })
})

describe('ResolveEntriesRequestSchema', () => {
  const refs = (count: number): EntryRef[] =>
    Array.from({ length: count }, (_, index) => ({ ...bareRef, id: String(1000 + index) }))

  it.each([1, MAX_ENTRIES_PER_REQUEST])('accepts %i entries', (count) => {
    const input = { entries: refs(count) }
    expect(ResolveEntriesRequestSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['no entries', []],
    ['more than MAX_ENTRIES_PER_REQUEST entries', refs(MAX_ENTRIES_PER_REQUEST + 1)],
    ['a single ref instead of a list', bareRef],
    ['null', null],
  ])('rejects %s', (_label, entries) => {
    expect(issuePaths(ResolveEntriesRequestSchema, { entries })).toEqual([['entries']])
  })

  it('reports the index of a bad ref', () => {
    const input = { entries: [bareRef, { ...pageRef, url: 'javascript:alert(1)' }] }
    expect(issuePaths(ResolveEntriesRequestSchema, input)).toEqual([['entries', 1, 'url']])
  })

  it('types entries as EntryRef[]', () => {
    expectTypeOf<ResolveEntriesRequest>().toEqualTypeOf<{ entries: EntryRef[] }>()
  })
})

const okResult = {
  status: 'ok',
  platform: 'soundcloud',
  id: '1234567893',
  track: {
    id: '1234567893',
    platform: 'soundcloud',
    url: 'https://soundcloud.com/some-artist/rooftop-edit',
    title: 'Rooftop Edit',
    uploader: 'Some Artist',
    durationSec: 301.4,
    availability: 'available',
    source: { codec: 'opus', bitrateKbps: 64 },
  },
} satisfies EntryResult

const errorResult = {
  status: 'error',
  platform: 'soundcloud',
  id: '1234567892',
  error: { code: 'rate_limited', message: 'SoundCloud is limiting requests. Try again shortly.' },
} satisfies EntryResult

describe('EntryResultSchema', () => {
  it.each([
    ['an enriched row', okResult],
    ['a row that failed on its own', errorResult],
  ])('parses %s unchanged', (_label, input) => {
    expect(EntryResultSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['an unknown status', { ...okResult, status: 'pending' }],
    ['a missing status', without(okResult, 'status')],
    ['a boolean status', { ...okResult, status: true }],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(EntryResultSchema, input)).toEqual([['status']])
  })

  it.each([
    ['ok without its track', without(okResult, 'track'), ['track']],
    [
      'ok with an error in place of its track',
      { ...without(okResult, 'track'), error: errorResult.error },
      ['track'],
    ],
    ['error without its error', without(errorResult, 'error'), ['error']],
    [
      'error with a track in place of its error',
      { ...without(errorResult, 'error'), track: okResult.track },
      ['error'],
    ],
    ['ok without the request id', without(okResult, 'id'), ['id']],
    [
      'an id longer than MAX_ID_LENGTH',
      { ...errorResult, id: 'a'.repeat(MAX_ID_LENGTH + 1) },
      ['id'],
    ],
    ['error without the request platform', without(errorResult, 'platform'), ['platform']],
  ])('rejects %s', (_label, input, path) => {
    expect(issuePaths(EntryResultSchema, input)).toEqual([path])
  })

  it('keys a row by the request id even when the track id differs', () => {
    const input = { ...okResult, id: 'requested-id' }
    expect(EntryResultSchema.parse(input)).toStrictEqual(input)
  })

  it('validates the error code', () => {
    const input = { ...errorResult, error: { code: 'teapot', message: 'No.' } }
    expect(issuePaths(EntryResultSchema, input)).toEqual([['error', 'code']])
  })

  it('discriminates on status', () => {
    expectTypeOf<EntryResult['status']>().toEqualTypeOf<'ok' | 'error'>()
    expectTypeOf<Extract<EntryResult, { status: 'ok' }>>().toEqualTypeOf<{
      status: 'ok'
      platform: Platform
      id: string
      track: Track
    }>()
    expectTypeOf<Extract<EntryResult, { status: 'error' }>>().toEqualTypeOf<{
      status: 'error'
      platform: Platform
      id: string
      error: ErrorInfo
    }>()
  })
})

describe('ResolveEntriesResponseSchema', () => {
  it('parses mixed results in request order', () => {
    const input = { results: [okResult, errorResult] }
    expect(ResolveEntriesResponseSchema.parse(input)).toStrictEqual(input)
  })

  it('accepts an empty result list', () => {
    expect(ResolveEntriesResponseSchema.parse({ results: [] })).toStrictEqual({ results: [] })
  })

  it('reports the index of a bad result', () => {
    const input = { results: [okResult, { ...errorResult, status: 'failed' }] }
    expect(issuePaths(ResolveEntriesResponseSchema, input)).toEqual([['results', 1, 'status']])
  })

  it('re-parses equal after a JSON round-trip, as the response body', () => {
    const parsed = ResolveEntriesResponseSchema.parse({ results: [okResult, errorResult] })
    expect(ResolveEntriesResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(
      parsed,
    )
  })

  it('accepts the same shape it outputs', () => {
    expectTypeOf<
      z.input<typeof ResolveEntriesResponseSchema>
    >().toEqualTypeOf<ResolveEntriesResponse>()
    expectTypeOf<ResolveEntriesResponse>().toEqualTypeOf<{ results: EntryResult[] }>()
  })
})
