import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { Collection } from './collection.ts'
import { type ResolveResult, ResolveResultSchema } from './resolve.ts'
import { issuePaths, nonHttpUrls } from './test-helpers.ts'
import type { Track } from './track.ts'

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
} satisfies ResolveResult

describe('ResolveResultSchema', () => {
  it.each([
    ['a single track', trackResult],
    ['a collection with full and partial entries', collectionResult],
    ['an ambiguous watch?v=…&list=… link', ambiguousResult],
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
    ['ambiguous without its track', { kind: 'ambiguous', collectionUrl: playlistUrl }, ['track']],
    [
      'ambiguous without its collectionUrl',
      { kind: 'ambiguous', track: youtubeTrack },
      ['collectionUrl'],
    ],
  ])('rejects %s', (_label, input, missing) => {
    expect(issuePaths(ResolveResultSchema, input)).toEqual([missing])
  })

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
