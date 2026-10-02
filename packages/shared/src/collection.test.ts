import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type Collection,
  type CollectionEntry,
  CollectionEntrySchema,
  type CollectionKind,
  CollectionKindSchema,
  CollectionSchema,
} from './collection.ts'
import type { Platform } from './platform.ts'
import { issuePaths, nonHttpUrls, type OptionalKeys, without } from './test-helpers.ts'
import type { Track } from './track.ts'

type FullEntry = Extract<CollectionEntry, { partial: false }>
type PartialEntry = Extract<CollectionEntry, { partial: true }>

const youtubeEntry = {
  id: 'dQw4w9WgXcQ',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
  uploader: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  availability: 'available',
  partial: false,
} satisfies CollectionEntry

const privateYoutubeEntry = {
  id: 'aBcDeFgHiJk',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk',
  title: '[Private video]',
  availability: 'unavailable',
  unavailableReason: 'private',
  partial: false,
} satisfies CollectionEntry

/** A SoundCloud set row as yt-dlp lists it with --flat-playlist: only id and an API URL. */
const bareSetEntry = {
  id: '1234567890',
  platform: 'soundcloud',
  url: 'https://api-v2.soundcloud.com/tracks/1234567890',
  availability: 'unknown',
  partial: true,
} satisfies CollectionEntry

const otherBareSetEntry = {
  id: '1234567893',
  platform: 'soundcloud',
  url: 'https://api-v2.soundcloud.com/tracks/1234567893',
  availability: 'unknown',
  partial: true,
} satisfies CollectionEntry

/** `bareSetEntry` after enrichment through POST /api/resolve/entries. */
const enrichedSetEntry = {
  id: '1234567890',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/deep-house-edit',
  title: 'Some Artist - Deep House Edit',
  uploader: 'Some Artist',
  durationSec: 212.53,
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000123456789-abcdef-t500x500.jpg',
  availability: 'available',
  source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
  partial: false,
} satisfies CollectionEntry

/** A SoundCloud user /tracks row in flat mode: permalink, id and title, but no duration, uploader or artwork. */
const userTracksEntry = {
  id: '1234567892',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/warehouse-dub',
  title: 'Warehouse Dub',
  availability: 'unknown',
  partial: true,
} satisfies CollectionEntry

const youtubePlaylist = {
  id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  platform: 'youtube',
  url: 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
  kind: 'playlist',
  title: 'Deep House Selection 2026',
  owner: 'Some Channel',
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  truncated: false,
  entries: [youtubeEntry, privateYoutubeEntry],
} satisfies Collection

const soundcloudSet = {
  id: '1876543210',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/sets/summer-2026',
  kind: 'set',
  title: 'Summer 2026',
  owner: 'Some Artist',
  trackCount: 2,
  durationSec: 425.06,
  truncated: false,
  entries: [bareSetEntry, otherBareSetEntry],
} satisfies Collection

const partlyEnrichedSet = {
  ...soundcloudSet,
  entries: [enrichedSetEntry, otherBareSetEntry],
} satisfies Collection

const soundcloudUserTracks = {
  id: '987654321',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/tracks',
  kind: 'channel',
  title: 'Some Artist (Tracks)',
  truncated: false,
  entries: [userTracksEntry],
} satisfies Collection

/** A SoundCloud user page lists sets too; the server keeps only the tracks and counts the rest. */
const soundcloudUserPage = {
  id: '987654321',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist',
  kind: 'channel',
  title: 'Some Artist',
  truncated: false,
  skippedEntries: 3,
  entries: [userTracksEntry],
} satisfies Collection

/** A playlist longer than the listing cap: the platform's count exceeds the rows listed. */
const truncatedPlaylist = {
  id: 'PLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  platform: 'youtube',
  url: 'https://www.youtube.com/playlist?list=PLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'playlist',
  title: 'Every House Track Ever',
  trackCount: 5214,
  truncated: true,
  entries: [youtubeEntry],
} satisfies Collection

const youtubeMix = {
  id: 'RDdQw4w9WgXcQ',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  kind: 'mix',
  title: 'Mix - Rick Astley - Never Gonna Give You Up',
  truncated: true,
  entries: [youtubeEntry],
} satisfies Collection

const emptyPlaylist = {
  id: 'PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  platform: 'youtube',
  url: 'https://www.youtube.com/playlist?list=PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'playlist',
  title: 'Crate (empty)',
  trackCount: 0,
  truncated: false,
  entries: [],
} satisfies Collection

const partialEntryRequiredFields = ['id', 'platform', 'url', 'availability', 'partial'] as const
const requiredFields = ['id', 'platform', 'url', 'kind', 'title', 'truncated', 'entries'] as const
const optionalFields = [
  'owner',
  'thumbnailUrl',
  'trackCount',
  'durationSec',
  'skippedEntries',
] as const
const urlFields = ['url', 'thumbnailUrl'] as const
const nonEmptyStringFields = ['id', 'title', 'owner'] as const

describe('CollectionKindSchema', () => {
  it('rejects a yt-dlp _type in place of a kind', () => {
    expect(CollectionKindSchema.safeParse('multi_video').success).toBe(false)
  })

  it('is exactly the union of the documented kinds', () => {
    expectTypeOf<CollectionKind>().toEqualTypeOf<
      'playlist' | 'album' | 'set' | 'channel' | 'likes' | 'mix' | 'other'
    >()
  })
})

describe('CollectionEntrySchema', () => {
  it.each([
    ['a full YouTube playlist row', youtubeEntry],
    ['a bare SoundCloud set row as yt-dlp lists it in flat mode', bareSetEntry],
    ['a SoundCloud user /tracks row with a title only', userTracksEntry],
  ])('parses %s unchanged', (_label, entry) => {
    expect(CollectionEntrySchema.parse(entry)).toStrictEqual(entry)
  })

  it('rejects a bare row that claims to be full, at its missing title', () => {
    expect(issuePaths(CollectionEntrySchema, { ...bareSetEntry, partial: false })).toEqual([
      ['title'],
    ])
  })

  it.each(partialEntryRequiredFields)('requires %s on a partial row', (field) => {
    expect(issuePaths(CollectionEntrySchema, without(bareSetEntry, field))).toEqual([[field]])
  })

  it('rejects a Track without partial, as entries were shaped before the flag', () => {
    expect(issuePaths(CollectionEntrySchema, without(youtubeEntry, 'partial'))).toEqual([
      ['partial'],
    ])
  })

  it.each([
    ['a word', 'yes'],
    ['a string that reads as true', 'true'],
    ['a number', 1],
    ['null', null],
  ])('rejects partial that is %s', (_label, partial) => {
    expect(issuePaths(CollectionEntrySchema, { ...userTracksEntry, partial })).toEqual([
      ['partial'],
    ])
  })

  it('rejects an empty title on a partial row', () => {
    expect(issuePaths(CollectionEntrySchema, { ...userTracksEntry, title: '' })).toEqual([
      ['title'],
    ])
  })

  it('rejects a null title on a partial row (normalizers must drop yt-dlp nulls)', () => {
    expect(issuePaths(CollectionEntrySchema, { ...bareSetEntry, title: null })).toEqual([['title']])
  })

  it.each(nonHttpUrls)('rejects %s as the url of a partial row', (url) => {
    expect(issuePaths(CollectionEntrySchema, { ...bareSetEntry, url })).toEqual([['url']])
  })

  it('strips unknown keys such as yt-dlp _type and ie_key from a bare row', () => {
    const input = { ...bareSetEntry, _type: 'url', ie_key: 'Soundcloud' }
    expect(CollectionEntrySchema.parse(input)).toStrictEqual(bareSetEntry)
  })

  it('narrows title to string on full rows and string | undefined on partial rows', () => {
    const labelOf = (entry: CollectionEntry): string => {
      if (entry.partial) {
        expectTypeOf(entry.title).toEqualTypeOf<string | undefined>()
        return entry.title ?? entry.id
      }
      expectTypeOf(entry.title).toEqualTypeOf<string>()
      return entry.title
    }
    expect(labelOf(CollectionEntrySchema.parse(youtubeEntry))).toBe(youtubeEntry.title)
    expect(labelOf(CollectionEntrySchema.parse(bareSetEntry))).toBe(bareSetEntry.id)
  })

  it('makes a full row exactly a Track tagged partial: false', () => {
    expectTypeOf<FullEntry['partial']>().toEqualTypeOf<false>()
    expectTypeOf<Omit<FullEntry, 'partial'>>().toEqualTypeOf<Track>()
  })

  it('makes a partial row a Track tagged partial: true whose title is optional', () => {
    expectTypeOf<PartialEntry['partial']>().toEqualTypeOf<true>()
    expectTypeOf<Omit<PartialEntry, 'partial' | 'title'>>().toEqualTypeOf<Omit<Track, 'title'>>()
    expectTypeOf<OptionalKeys<PartialEntry>>().toEqualTypeOf<OptionalKeys<Track> | 'title'>()
    expectTypeOf<Exclude<keyof PartialEntry, OptionalKeys<PartialEntry>>>().toEqualTypeOf<
      (typeof partialEntryRequiredFields)[number]
    >()
  })
})

describe('CollectionSchema', () => {
  it.each([
    ['a YouTube playlist with a private entry', youtubePlaylist],
    ['a SoundCloud set as listed in flat mode, every entry bare', soundcloudSet],
    ['a SoundCloud set with some entries enriched', partlyEnrichedSet],
    ['a SoundCloud user /tracks page', soundcloudUserTracks],
    ['a SoundCloud user page with skipped sets', soundcloudUserPage],
    ['a YouTube mix cut at the mix cap', youtubeMix],
    ['a playlist cut at the listing cap', truncatedPlaylist],
    ['a playlist without entries', emptyPlaylist],
  ])('parses %s unchanged', (_label, collection) => {
    expect(CollectionSchema.parse(collection)).toStrictEqual(collection)
  })

  it.each(requiredFields)('requires %s', (field) => {
    expect(issuePaths(CollectionSchema, without(youtubePlaylist, field))).toEqual([[field]])
  })

  it.each(optionalFields)('allows %s to be omitted', (field) => {
    expect(issuePaths(CollectionSchema, without(truncatedPlaylist, field))).toEqual([])
  })

  it.each([
    ['trackCount', 0],
    ['trackCount', 5214],
    ['durationSec', 0],
    ['durationSec', 425.06],
    ['skippedEntries', 1],
    ['truncated', true],
    ['truncated', false],
  ])('accepts %s %j', (field, value) => {
    expect(issuePaths(CollectionSchema, { ...youtubePlaylist, [field]: value })).toEqual([])
  })

  it.each([
    ['trackCount', 'a negative count', -1],
    ['trackCount', 'a fractional count', 2.5],
    ['trackCount', 'a count as a string', '5214'],
    ['trackCount', 'null (normalizers must drop yt-dlp nulls)', null],
    ['trackCount', 'infinity', Number.POSITIVE_INFINITY],
    ['durationSec', 'a negative duration', -1],
    ['durationSec', 'a duration as a string', '425'],
    ['durationSec', 'null', null],
    ['durationSec', 'NaN', Number.NaN],
    ['skippedEntries', 'zero (omit it instead)', 0],
    ['skippedEntries', 'a negative count', -2],
    ['skippedEntries', 'a fractional count', 1.5],
    ['truncated', 'a string that reads as false', 'false'],
    ['truncated', 'a number', 0],
    ['truncated', 'null', null],
  ])('rejects %s that is %s', (field, _label, value) => {
    expect(issuePaths(CollectionSchema, { ...youtubePlaylist, [field]: value })).toEqual([[field]])
  })

  it.each([
    ['kind', 'radio'],
    ['platform', 'deezer'],
  ])('rejects %s %j', (field, value) => {
    expect(issuePaths(CollectionSchema, { ...youtubePlaylist, [field]: value })).toEqual([[field]])
  })

  it.each(urlFields.flatMap((field) => nonHttpUrls.map((url) => ({ field, url }))))(
    'rejects $url as $field',
    ({ field, url }) => {
      expect(issuePaths(CollectionSchema, { ...youtubePlaylist, [field]: url })).toEqual([[field]])
    },
  )

  it.each(nonEmptyStringFields)('rejects an empty %s', (field) => {
    expect(issuePaths(CollectionSchema, { ...youtubePlaylist, [field]: '' })).toEqual([[field]])
  })

  it.each([
    ['null', null],
    ['an object keyed by id', { dQw4w9WgXcQ: youtubeEntry }],
    ['a single entry', youtubeEntry],
  ])('rejects entries that are %s', (_label, entries) => {
    expect(issuePaths(CollectionSchema, { ...youtubePlaylist, entries })).toEqual([['entries']])
  })

  it('validates every entry and reports the index of a bad one', () => {
    const input = {
      ...youtubePlaylist,
      entries: [youtubeEntry, { ...privateYoutubeEntry, url: 'javascript:alert(1)' }],
    }
    expect(issuePaths(CollectionSchema, input)).toEqual([['entries', 1, 'url']])
  })

  it('rejects a full entry without a title at its index', () => {
    const input = {
      ...youtubePlaylist,
      entries: [youtubeEntry, without(privateYoutubeEntry, 'title')],
    }
    expect(issuePaths(CollectionSchema, input)).toEqual([['entries', 1, 'title']])
  })

  it('rejects an entry without partial at its index', () => {
    const input = {
      ...soundcloudSet,
      entries: [bareSetEntry, without(enrichedSetEntry, 'partial')],
    }
    expect(issuePaths(CollectionSchema, input)).toEqual([['entries', 1, 'partial']])
  })

  it('strips unknown keys on the collection and its full and partial entries', () => {
    const input = {
      ...partlyEnrichedSet,
      _type: 'playlist',
      playlist_count: 2,
      entries: partlyEnrichedSet.entries.map((entry) => ({
        ...entry,
        _type: 'url',
        ie_key: 'Soundcloud',
      })),
    }
    expect(CollectionSchema.parse(input)).toStrictEqual(partlyEnrichedSet)
  })

  it('makes exactly the documented fields optional', () => {
    expectTypeOf<OptionalKeys<Collection>>().toEqualTypeOf<(typeof optionalFields)[number]>()
    expectTypeOf<Exclude<keyof Collection, OptionalKeys<Collection>>>().toEqualTypeOf<
      (typeof requiredFields)[number]
    >()
  })

  it('types entries as CollectionEntry[] and the enums with their shared types', () => {
    expectTypeOf<Collection['entries']>().toEqualTypeOf<CollectionEntry[]>()
    expectTypeOf<Collection['truncated']>().toEqualTypeOf<boolean>()
    expectTypeOf<Collection['trackCount']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Collection['durationSec']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Collection['skippedEntries']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Collection['kind']>().toEqualTypeOf<CollectionKind>()
    expectTypeOf<Collection['platform']>().toEqualTypeOf<Platform>()
  })
})
