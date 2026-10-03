import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type Collection,
  CollectionSchema,
  classifyUrl,
  MAX_COLLECTION_ENTRIES,
  MAX_MIX_ENTRIES,
  type Track,
  TrackSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { InfoParseError, type Normalized, normalizeEntry, normalizeInfo } from './ytdlp-parse.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures')
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'))

/** A fixture's top-level object, to vary a field of a recorded document. */
function fixtureObject(name: string): Record<string, unknown> {
  const value = fixture(name)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is not a JSON object`)
  }
  return { ...value }
}

/** The URL each success fixture was recorded from (see the fixture READMEs). */
const RECORDED_URLS: Record<string, string> = {
  'youtube/album-olak.json':
    'https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
  'youtube/album.json': 'https://music.youtube.com/browse/MPREb_gTAcphH99wE',
  'youtube/channel-root.json': 'https://www.youtube.com/@NoCopyrightSounds',
  'youtube/channel-videos.json': 'https://www.youtube.com/@NoCopyrightSounds/videos',
  'youtube/mix-track.json': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  'youtube/mix-unrecognized.json': 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=RDjNQXAC9IVRw',
  'youtube/mix.json': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  'youtube/music-track.json': 'https://music.youtube.com/watch?v=XNEnEBrHws8',
  'youtube/playlist-capped.json':
    'https://www.youtube.com/playlist?list=PLzH6n4zXuckpfMu_4Ff8E7Z1behQks5ba',
  'youtube/playlist-empty.json':
    'https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf',
  'youtube/playlist-unavailable-entries.json':
    'https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2',
  'youtube/playlist.json':
    'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  'youtube/video.json': 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'youtube/watch-list-playlist.json':
    'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  'youtube/watch-list-track.json':
    'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  'soundcloud/album-set.json': 'https://soundcloud.com/leviryan/sets/out-of-spite',
  'soundcloud/entry-metadata-only.json': 'https://api-v2.soundcloud.com/tracks/47127631',
  'soundcloud/entry.json': 'https://api-v2.soundcloud.com/tracks/47127631',
  'soundcloud/set-capped.json': 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
  'soundcloud/set.json': 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
  'soundcloud/track-preview.json': 'https://soundcloud.com/the-concept-band/world-on-fire-1',
  'soundcloud/track-secret.json':
    'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
  'soundcloud/track-short-link.json': 'https://on.soundcloud.com/9TqpUbrnArHjKNAq6',
  'soundcloud/track.json': 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
  'soundcloud/user-likes.json': 'https://soundcloud.com/leviryan/likes',
  'soundcloud/user-reposts.json': 'https://soundcloud.com/the-concept-band/reposts',
  'soundcloud/user-sets.json': 'https://soundcloud.com/the-concept-band/sets',
  'soundcloud/user-tracks.json': 'https://soundcloud.com/the-concept-band/tracks',
  'soundcloud/user.json': 'https://soundcloud.com/the-concept-band',
}

function classified(url: string): ValidUrl {
  const result = classifyUrl(url)
  if (!result.ok) throw new Error(`not a valid URL: ${url}`)
  return result
}

function recordedInput(name: string): ValidUrl {
  const url = RECORDED_URLS[name]
  if (url === undefined) throw new Error(`no recorded URL for ${name}`)
  return classified(url)
}

/** JSON paths whose value is `undefined`: optional fields must be omitted instead. */
function undefinedPaths(value: unknown, at = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => undefinedPaths(item, `${at}[${index}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, field]) =>
    field === undefined ? [`${at}.${key}`] : undefinedPaths(field, `${at}.${key}`),
  )
}

/** Every output must match the shared contract exactly, with no present-but-undefined fields. */
function trackOf(normalized: Normalized): Track {
  if (normalized.kind !== 'track') throw new Error(`expected a track, got a ${normalized.kind}`)
  expect(TrackSchema.parse(normalized.track)).toStrictEqual(normalized.track)
  expect(undefinedPaths(normalized.track)).toEqual([])
  return normalized.track
}

function collectionOf(normalized: Normalized): Collection {
  if (normalized.kind !== 'collection') throw new Error(`expected a collection, got a track`)
  expect(CollectionSchema.parse(normalized.collection)).toStrictEqual(normalized.collection)
  expect(undefinedPaths(normalized.collection)).toEqual([])
  return normalized.collection
}

const trackFixture = (name: string, input = recordedInput(name)) =>
  trackOf(normalizeInfo(fixture(name), { input, limit: MAX_COLLECTION_ENTRIES }))

const collectionFixture = (
  name: string,
  limit = MAX_COLLECTION_ENTRIES,
  input = recordedInput(name),
) => collectionOf(normalizeInfo(fixture(name), { input, limit }))

const ids = (collection: Collection) => collection.entries.map((entry) => entry.id)

describe('recorded fixtures', () => {
  const recorded = ['youtube', 'soundcloud'].flatMap((dir) =>
    readdirSync(path.join(fixturesDir, dir))
      .filter((file) => file.endsWith('.json'))
      .map((file) => `${dir}/${file}`),
  )

  it('knows the recorded URL of every success fixture', () => {
    expect(recorded.toSorted()).toEqual(Object.keys(RECORDED_URLS).toSorted())
  })

  it.each(recorded)('normalizes %s into contract-valid output', (name) => {
    // Mixes are listed with their own cap, as the fixture was recorded (-I 1:51).
    const limit = name === 'youtube/mix.json' ? MAX_MIX_ENTRIES : MAX_COLLECTION_ENTRIES
    const input = recordedInput(name)
    const normalized = normalizeInfo(fixture(name), { input, limit })
    if (normalized.kind === 'collection') {
      collectionOf(normalized)
    } else {
      // An enrichment lookup of the same JSON gives the same track.
      expect(normalizeEntry(fixture(name), input)).toStrictEqual(trackOf(normalized))
    }
  })
})

describe('normalizeInfo: YouTube tracks', () => {
  it('reads a video with the best audio-only stream as its source', () => {
    expect(trackFixture('youtube/video.json')).toStrictEqual({
      id: 'jNQXAC9IVRw',
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      title: 'Me at the zoo',
      uploader: 'jawed',
      durationSec: 19,
      thumbnailUrl:
        'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=-oaymwEmCOADEOgC8quKqQMa8AEB-AG-AoAC8AGKAgwIABABGFUgWShlMA8=&rs=AOn4CLA9eLBatYv9WbkD4BbZ2Im-biSPTw',
      availability: 'available',
      // Format 251, the last audio-only format: what `-f ba` downloads, not the muxed 395+251.
      source: { codec: 'opus', bitrateKbps: 106.064 },
    })
  })

  it('takes artist and title from YouTube Music metadata and links the www page', () => {
    expect(trackFixture('youtube/music-track.json')).toStrictEqual({
      id: 'XNEnEBrHws8',
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=XNEnEBrHws8',
      title: 'The Chill Zone',
      artist: 'Royalty Free Music',
      uploader: 'Royalty Free Music Crew - Topic',
      durationSec: 267,
      thumbnailUrl: 'https://i.ytimg.com/vi/XNEnEBrHws8/maxresdefault.jpg',
      availability: 'available',
      source: { codec: 'opus', bitrateKbps: 154.673 },
    })
  })

  it('reports the stream yt-dlp ranks best, not the highest bitrate on offer', () => {
    // The 5 s test video's Opus 251 is 4 kbps while AAC 140 is 130 kbps; `ba` still takes 251.
    const track = trackFixture('youtube/watch-list-track.json')
    expect(track).toMatchObject({
      id: 'gHKT4uU8Zng',
      title: 'dlp test video title primary (en-GB)',
      url: 'https://www.youtube.com/watch?v=gHKT4uU8Zng',
      durationSec: 5,
      availability: 'available',
    })
    expect(track.source).toStrictEqual({ codec: 'opus', bitrateKbps: 4.069 })
  })

  it('returns the seed track when YouTube has no mix for it', () => {
    expect(trackFixture('youtube/mix-unrecognized.json')).toStrictEqual(
      trackFixture('youtube/video.json'),
    )
  })
})

describe('normalizeInfo: SoundCloud tracks', () => {
  it('splits "Artist - Title" when the platform names no artist', () => {
    expect(trackFixture('soundcloud/track.json')).toStrictEqual({
      id: '62986583',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
      title: 'She so Heavy (SneakPreview) Adrian Ackers Blueprint 1',
      artist: 'Lostin Powers',
      uploader: 'E.T. ExTerrestrial Music',
      durationSec: 143.206,
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-000031955188-rwb18x-original.jpg',
      availability: 'available',
      // yt-dlp picks AAC 96k over MP3 128k here; the source says so rather than claim 128.
      source: { codec: 'mp4a.40.2', bitrateKbps: 96 },
    })
  })

  it('keeps a secret link and drops the default-avatar placeholder artwork', () => {
    expect(trackFixture('soundcloud/track-secret.json')).toStrictEqual({
      id: '123998367',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
      title: "Dl Test Video '' Ä↭",
      artist: 'Youtube',
      uploader: 'jaimeMF',
      durationSec: 9.927,
      availability: 'available',
      source: { codec: 'mp3', bitrateKbps: 128 },
    })
  })

  it('marks a Go+ track whose only formats are previews as preview_only', () => {
    expect(trackFixture('soundcloud/track-preview.json')).toStrictEqual({
      id: '75206121',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/the-concept-band/world-on-fire-1',
      title: 'World On Fire (Re-Mastered)',
      artist: 'The Royal Concept',
      uploader: 'The Royal Concept',
      // No durationSec (30.0 is the snippet) and no source (the preview stream isn't the track).
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-acRKqXJcJGVN-0-original.jpg',
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
  })

  it('links a short link to the clean page it redirected to', () => {
    expect(trackFixture('soundcloud/track-short-link.json')).toStrictEqual({
      id: '189341496',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/excision/robokitty',
      title: 'Robo Kitty',
      artist: 'Excision & Downlink',
      uploader: 'Excision',
      durationSec: 250.403,
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-000105521976-8awbru-original.jpg',
      availability: 'available',
      source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
    })
  })
})

describe('normalizeEntry', () => {
  const apiUrl = classified('https://api-v2.soundcloud.com/tracks/47127631')
  const knockedUp = {
    id: '47127631',
    platform: 'soundcloud',
    url: 'https://soundcloud.com/the-concept-band/knocked-up-mastered',
    title: 'Knocked Up',
    uploader: 'The Royal Concept',
    durationSec: 221.872,
    thumbnailUrl: 'https://i1.sndcdn.com/artworks-000043574646-iq6flj-original.jpg',
    availability: 'available',
  }

  it('turns a lookup of an api-v2 row URL into a full track with its page URL', () => {
    expect(normalizeEntry(fixture('soundcloud/entry.json'), apiUrl)).toStrictEqual({
      ...knockedUp,
      source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
    })
  })

  it('omits the source when the lookup listed no formats', () => {
    expect(normalizeEntry(fixture('soundcloud/entry-metadata-only.json'), apiUrl)).toStrictEqual(
      knockedUp,
    )
  })

  it.each(['soundcloud/set.json', 'youtube/playlist.json'])(
    'refuses %s, which is a collection',
    (name) => {
      expect(() => normalizeEntry(fixture(name), apiUrl)).toThrow(InfoParseError)
    },
  )

  it.each([null, [], 'track', 42])('refuses %j, which is not an info object', (info) => {
    expect(() => normalizeEntry(info, apiUrl)).toThrow(InfoParseError)
  })
})

describe('normalizeInfo: YouTube collections', () => {
  it('lists a playlist as full rows with unknown availability', () => {
    expect(collectionFixture('youtube/playlist.json')).toStrictEqual({
      id: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
      platform: 'youtube',
      url: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
      kind: 'playlist',
      title: 'dlp test playlist',
      owner: 'cole-dlp-test-acc',
      thumbnailUrl:
        'https://i.ytimg.com/vi/gHKT4uU8Zng/hqdefault.jpg?sqp=-oaymwExCNACELwBSFryq4qpAyMIARUAAIhCGAHwAQH4Af4JgALQBYoCDAgAEAEYXCATKH8wDw==&rs=AOn4CLBK7d9INJMEaK_SE2Yxfo_TJOWQ6A',
      trackCount: 1,
      truncated: false,
      entries: [
        {
          id: 'gHKT4uU8Zng',
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=gHKT4uU8Zng',
          title: 'dlp test video title translated (en)',
          uploader: 'cole-dlp-test-acc',
          durationSec: 6,
          // The largest of the row's four hqdefault sizes (336x188).
          thumbnailUrl:
            'https://i.ytimg.com/vi/gHKT4uU8Zng/hqdefault.jpg?sqp=-oaymwE2CNACELwBSFXyq4qpAygIARUAAIhCGAFwAcABBvABAfgB_gmAAtAFigIMCAAQARhcIBMofzAP&rs=AOn4CLAhtS1eII_HcNOXiR17wbyhASj5Fg',
          availability: 'unknown',
          partial: false,
        },
      ],
    })
  })

  it('lists the list behind a watch?v=…&list=… URL like the playlist itself', () => {
    expect(collectionFixture('youtube/watch-list-playlist.json')).toStrictEqual(
      collectionFixture('youtube/playlist.json'),
    )
  })

  it('cuts a list that returned more rows than the cap and keeps YouTube’s own count', () => {
    // Recorded with -I 1:4, as a cap of 3 would request it.
    const capped = collectionFixture('youtube/playlist-capped.json', 3)
    expect(capped).toMatchObject({ truncated: true, trackCount: 11 })
    expect(ids(capped)).toEqual(['NxYEzbbpk-4', '8GIbOJtUw8w', 'SEeQgNdJ6AQ'])

    const uncapped = collectionFixture('youtube/playlist-capped.json')
    expect(uncapped).toMatchObject({ truncated: false, trackCount: 11 })
    expect(uncapped.entries).toHaveLength(4)
  })

  it('returns an empty playlist as a success without its placeholder artwork', () => {
    expect(collectionFixture('youtube/playlist-empty.json')).toStrictEqual({
      id: 'PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf',
      platform: 'youtube',
      url: 'https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf',
      kind: 'playlist',
      title: 'youtube-dl empty playlist',
      owner: 'Sergey M.',
      trackCount: 0,
      truncated: false,
      entries: [],
    })
  })

  describe('private and deleted rows', () => {
    // A -I 49:71 window of a 162-row playlist: a window, not a cap.
    const window = collectionFixture('youtube/playlist-unavailable-entries.json')
    const row = (id: string) => window.entries.find((entry) => entry.id === id)

    it('keeps them as full, unavailable rows without placeholder artwork', () => {
      expect(row('ETbOX50t0kw')).toStrictEqual({
        id: 'ETbOX50t0kw',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=ETbOX50t0kw',
        title: '[Private video]',
        availability: 'unavailable',
        unavailableReason: 'private',
        partial: false,
      })
      expect(row('qZLs7BHhduA')).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'private',
      })
      expect(row('RcUnmaanrNM')).toStrictEqual({
        id: 'RcUnmaanrNM',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=RcUnmaanrNM',
        title: '[Deleted video]',
        availability: 'unavailable',
        unavailableReason: 'unavailable',
        partial: false,
      })
    })

    it('matches the placeholder titles exactly, not a real title that starts with a bracket', () => {
      expect(row('H6T1FW7qMxA')).toStrictEqual({
        id: 'H6T1FW7qMxA',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=H6T1FW7qMxA',
        title: '[ORIGINAL] Kid cussing and punching! "Hello Motherf*cker"',
        uploader: 'OMGBERAW',
        durationSec: 67,
        thumbnailUrl:
          'https://i.ytimg.com/vi/H6T1FW7qMxA/hqdefault.jpg?sqp=-oaymwE2CNACELwBSFXyq4qpAygIARUAAIhCGAFwAcABBvABAfgBjAKAAuADigIMCAAQARhlIF0oTTAP&rs=AOn4CLCTdszROCSP_JztJ3sSikt-yPHPzA',
        availability: 'unknown',
        partial: false,
      })
    })

    it('keeps every row, YouTube’s total and no truncation for a window', () => {
      expect(window).toMatchObject({ trackCount: 162, truncated: false })
      expect(window.skippedEntries).toBeUndefined()
      expect(window.entries).toHaveLength(23)
      const unavailable = window.entries.filter((entry) => entry.availability === 'unavailable')
      expect(unavailable.map((entry) => entry.id)).toEqual([
        'ETbOX50t0kw',
        'qZLs7BHhduA',
        'RcUnmaanrNM',
      ])
    })
  })

  it('lists a YouTube Music album, naming its artist after the rows’ shared Topic channel', () => {
    const album = collectionFixture('youtube/album.json')
    expect({ ...album, entries: album.entries.slice(0, 1) }).toStrictEqual({
      id: 'OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
      platform: 'youtube',
      url: 'https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
      kind: 'album',
      title: 'Album - Royalty Free Music Library V2 (50 Songs)',
      // yt-dlp's top-level uploader is null; all 50 rows are "Royalty Free Music Crew - Topic".
      owner: 'Royalty Free Music Crew',
      thumbnailUrl:
        'https://i9.ytimg.com/s_p/OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0/maxresdefault.jpg',
      trackCount: 50,
      truncated: false,
      entries: [
        {
          id: 'XNEnEBrHws8',
          platform: 'youtube',
          url: 'https://music.youtube.com/watch?v=XNEnEBrHws8',
          title: 'The Chill Zone',
          uploader: 'Royalty Free Music Crew - Topic',
          durationSec: 268,
          thumbnailUrl: expect.stringMatching(/^https:\/\/i\.ytimg\.com\/vi\/XNEnEBrHws8\//),
          availability: 'unknown',
          partial: false,
        },
      ],
    })
    expect(album.entries).toHaveLength(50)
    expect(
      album.entries.every((entry) => entry.uploader === 'Royalty Free Music Crew - Topic'),
    ).toBe(true)
  })

  it('lists the same album through its OLAK playlist URL with www row links', () => {
    const viaBrowse = collectionFixture('youtube/album.json')
    const viaOlak = collectionFixture('youtube/album-olak.json')
    const withoutUrls = (collection: Collection) =>
      collection.entries.map(({ url: _url, ...entry }) => entry)
    expect({ ...viaOlak, entries: [] }).toStrictEqual({ ...viaBrowse, entries: [] })
    expect(withoutUrls(viaOlak)).toStrictEqual(withoutUrls(viaBrowse))
    expect(viaOlak.entries.every((entry) => entry.url.startsWith('https://www.youtube.com/'))).toBe(
      true,
    )
  })

  it('caps a mix at the mix limit and says it was truncated', () => {
    const mix = collectionFixture('youtube/mix.json', MAX_MIX_ENTRIES)
    expect({ ...mix, entries: mix.entries.slice(0, 1) }).toStrictEqual({
      id: 'RDdQw4w9WgXcQ',
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
      kind: 'mix',
      title: 'Mix - Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
      truncated: true,
      entries: [
        {
          id: 'dQw4w9WgXcQ',
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Never Gonna Give You Up (Official Video) (4K Remaster)',
          artist: 'Rick Astley',
          uploader: 'Rick Astley',
          durationSec: 214,
          thumbnailUrl:
            'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?sqp=-oaymwEcCNACELwBSFXyq4qpAw4IARUAAIhCGAFwAcABBg==&rs=AOn4CLB_p0PncTtkrhaNDZtntrE3gKkoYw',
          availability: 'unknown',
          partial: false,
        },
      ],
    })
    expect(mix.entries).toHaveLength(MAX_MIX_ENTRIES)
    expect(ids(mix).at(-1)).toBe('KrZHPOeOxQQ')
    expect(ids(mix)).not.toContain('ZbZSe6N_BXs')
  })

  it('lists a channel tab, filling the rows’ uploader from the channel', () => {
    const channel = collectionFixture('youtube/channel-videos.json')
    expect({ ...channel, entries: channel.entries.slice(0, 1) }).toStrictEqual({
      id: 'UC_aEa8K-EOJ3D6gOs7HcyNg',
      platform: 'youtube',
      url: 'https://www.youtube.com/@NoCopyrightSounds/videos',
      kind: 'channel',
      title: 'NoCopyrightSounds - Videos',
      owner: 'NoCopyrightSounds',
      // The uncropped avatar (preference 1), not the wider banner (preference -10).
      thumbnailUrl:
        'https://yt3.googleusercontent.com/opGwWu2ScRBy-OA81LIzKwSatxlVKjjNyAdt4fWh4LoLzldx05Sdf3OGQz0Fz78ziZ9RLP4=s0',
      // playlist_count is null for a capped channel tab.
      truncated: false,
      entries: [
        {
          id: 'ZAz2xoQMvW8',
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=ZAz2xoQMvW8',
          title: 'Halcyon | Trance | NCS - Copyright Free Music',
          artist: 'P3PPER, Jibaan',
          uploader: 'NoCopyrightSounds',
          durationSec: 225,
          thumbnailUrl: expect.stringMatching(
            /^https:\/\/i\.ytimg\.com\/vi\/ZAz2xoQMvW8\/hq720\.jpg/,
          ),
          availability: 'unknown',
          partial: false,
        },
      ],
    })
    expect(channel.entries).toHaveLength(6)
    expect(channel.entries.every((entry) => entry.uploader === 'NoCopyrightSounds')).toBe(true)
  })

  it('truncates a channel tab by row count alone, since it reports no total', () => {
    const channel = collectionFixture('youtube/channel-videos.json', 5)
    expect(channel.truncated).toBe(true)
    expect(channel.entries).toHaveLength(5)
    expect(channel.trackCount).toBeUndefined()
  })

  it('skips the nested tab playlists of a channel root instead of listing them', () => {
    const root = collectionFixture('youtube/channel-root.json')
    expect(root).toStrictEqual({
      id: '@NoCopyrightSounds',
      platform: 'youtube',
      url: 'https://www.youtube.com/@NoCopyrightSounds',
      kind: 'channel',
      title: 'NoCopyrightSounds',
      owner: 'NoCopyrightSounds',
      thumbnailUrl:
        'https://yt3.googleusercontent.com/opGwWu2ScRBy-OA81LIzKwSatxlVKjjNyAdt4fWh4LoLzldx05Sdf3OGQz0Fz78ziZ9RLP4=s0',
      // playlist_count 2 counts tabs, not tracks.
      truncated: false,
      skippedEntries: 2,
      entries: [],
    })
  })

  it.each([
    ['youtube/mix.json', 'mix'],
    ['youtube/album-olak.json', 'album'],
    ['youtube/channel-videos.json', 'channel'],
    ['youtube/playlist.json', 'playlist'],
  ])('infers the kind of %s from the resolved URL when the input names none', (name, kind) => {
    const input = classified('https://youtu.be/dQw4w9WgXcQ')
    expect(input.collectionKind).toBeUndefined()
    expect(collectionFixture(name, MAX_COLLECTION_ENTRIES, input).kind).toBe(kind)
  })
})

describe('normalizeInfo: SoundCloud collections', () => {
  const setRows = [
    ['75206121', 'https://soundcloud.com/the-concept-band/world-on-fire-1'],
    ['47127625', 'https://soundcloud.com/the-concept-band/gimme-twice-mastered'],
    ['47127627', 'https://soundcloud.com/the-concept-band/goldrushed-mastered'],
    ['30510138', 'https://soundcloud.com/the-concept-band/the-concept-d-d-dance'],
    ['47127629', 'https://soundcloud.com/the-concept-band/in-the-end-mastered'],
    ['47127631', 'https://api-v2.soundcloud.com/tracks/47127631'],
  ]

  it('lists a set as bare partial rows, page or API URL as listed, with the set’s totals', () => {
    expect(collectionFixture('soundcloud/set.json')).toStrictEqual({
      id: '2284613',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
      // SoundCloud labels this set an EP (album_type "ep"): a release, so an album.
      kind: 'album',
      title: 'The Royal Concept EP',
      owner: 'The Royal Concept',
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-000030896212-o16m9v-original.jpg',
      trackCount: 6,
      durationSec: 1398.595,
      truncated: false,
      entries: setRows.map(([id, url]) => ({
        id,
        platform: 'soundcloud',
        url,
        availability: 'unknown',
        partial: true,
      })),
    })
  })

  it('keeps a capped set’s full track count and duration', () => {
    // Recorded with -I 1:3, as a cap of 2 would request it.
    const capped = collectionFixture('soundcloud/set-capped.json', 2)
    expect(capped).toMatchObject({
      kind: 'album',
      truncated: true,
      trackCount: 6,
      durationSec: 1398.595,
    })
    expect(ids(capped)).toEqual(['75206121', '47127625'])
  })

  it('lists an album set as an album, its later rows as API URLs', () => {
    const album = collectionFixture('soundcloud/album-set.json')
    expect(album).toMatchObject({
      id: '1524158182',
      kind: 'album',
      title: 'out of spite',
      owner: 'Levi Ryan',
      trackCount: 8,
      durationSec: 1531.376,
      truncated: false,
    })
    expect(album.entries.map((entry) => entry.url.startsWith('https://api-v2.'))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ])
    expect(album.entries.every((entry) => entry.partial && entry.title === undefined)).toBe(true)
  })

  it('infers a set from the resolved URL behind a short link, then labels it by its type', () => {
    const input = classified('https://on.soundcloud.com/abc123')
    expect(input.collectionKind).toBeUndefined()
    const kindOf = (info: unknown) =>
      collectionOf(normalizeInfo(info, { input, limit: MAX_COLLECTION_ENTRIES })).kind
    const albumSet = fixtureObject('soundcloud/album-set.json')
    expect(kindOf(albumSet)).toBe('album')
    expect(kindOf({ ...albumSet, album_type: 'playlist' })).toBe('set')
  })

  it('skips the sets on a user page, counts them, and keeps titled partial rows', () => {
    // Recorded with -I 1:12, as a cap of 11 would request it; row 3 is a set.
    const user = collectionFixture('soundcloud/user.json', 11)
    expect({ ...user, entries: [] }).toStrictEqual({
      id: '9615865',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/the-concept-band',
      kind: 'channel',
      // yt-dlp's own title, kept; the owner is its username part (the page has no uploader).
      title: 'The Royal Concept (All)',
      owner: 'The Royal Concept',
      truncated: true,
      skippedEntries: 1,
      entries: [],
    })
    expect(ids(user)).toEqual([
      '607075623',
      '597335928',
      '88359828',
      '153528495',
      '149905846',
      '149905575',
      '149906096',
      '109919787',
      '47127629',
      '122071563',
    ])
    expect(user.entries[0]).toStrictEqual({
      id: '607075623',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/the-concept-band/kick-it-main',
      title: 'Kick It',
      availability: 'unknown',
      partial: true,
    })
    // A repost by another user, split like any upload title.
    expect(user.entries[9]).toStrictEqual({
      id: '122071563',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/beatmafia/goldrushed_beat_mafia_remix',
      title: 'Goldrushed (Beat Mafia Remix)',
      artist: 'The Royal Concept',
      availability: 'unknown',
      partial: true,
    })
  })

  it('lists a whole user page without truncation and without a track count', () => {
    const user = collectionFixture('soundcloud/user.json')
    expect(user).toMatchObject({ truncated: false, skippedEntries: 1 })
    expect(user.trackCount).toBeUndefined()
    expect(user.entries).toHaveLength(11)
  })

  it('skips every row of a sets tab', () => {
    const sets = collectionFixture('soundcloud/user-sets.json')
    expect(sets).toMatchObject({
      kind: 'channel',
      title: 'The Royal Concept (Sets)',
      owner: 'The Royal Concept',
      skippedEntries: 4,
      entries: [],
    })
  })

  it('lists a tracks tab as partial rows', () => {
    const tracks = collectionFixture('soundcloud/user-tracks.json')
    expect(tracks).toMatchObject({
      kind: 'channel',
      title: 'The Royal Concept (Tracks)',
      owner: 'The Royal Concept',
    })
    expect(tracks.skippedEntries).toBeUndefined()
    expect(ids(tracks)).toEqual([
      '607075623',
      '597335928',
      '149905846',
      '149905575',
      '149906096',
      '109919787',
    ])
    expect(tracks.entries.every((entry) => entry.partial)).toBe(true)
  })

  it('lists likes as their own kind', () => {
    const likes = collectionFixture('soundcloud/user-likes.json')
    expect(likes).toMatchObject({
      id: '229146182',
      kind: 'likes',
      title: 'Levi Ryan (Likes)',
      owner: 'Levi Ryan',
    })
    expect(likes.trackCount).toBeUndefined()
    expect(likes.entries[1]).toStrictEqual({
      id: '2063414124',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/papipastrami/levi-ryan-can-you-drive-v2-6',
      title: 'can you drive (v2)',
      artist: 'Levi Ryan',
      availability: 'unknown',
      partial: true,
    })
  })

  it('counts the rows of a user list that ran out under the cap', () => {
    const reposts = collectionFixture('soundcloud/user-reposts.json')
    expect(reposts).toMatchObject({
      title: 'The Royal Concept (Reposts)',
      owner: 'The Royal Concept',
      trackCount: 3,
      truncated: false,
    })
    expect(reposts.entries[1]).toMatchObject({ artist: 'MRTN Feat. Deer', title: 'Illusion' })
  })
})

describe('tolerance: tracks', () => {
  const youtubeInput = classified('https://www.youtube.com/watch?v=abcdefghijk')
  const info = (fields: Record<string, unknown>) => ({
    _type: 'video',
    extractor_key: 'Youtube',
    id: 'abcdefghijk',
    title: 'Song',
    webpage_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    ...fields,
  })
  const track = (fields: Record<string, unknown> = {}, input = youtubeInput) =>
    trackOf(normalizeInfo(info(fields), { input, limit: 10 }))
  const minimal = {
    id: 'abcdefghijk',
    platform: 'youtube',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'Song',
    availability: 'available',
  }
  const parse = (value: unknown) => () => normalizeInfo(value, { input: youtubeInput, limit: 10 })

  it.each([null, [], 'video', 42, true])('refuses %j, which is not an info object', (value) => {
    expect(parse(value)).toThrow(InfoParseError)
  })

  it.each(['url', 'url_transparent', 'channel'])('refuses an unexpected _type %j', (type) => {
    expect(parse(info({ _type: type }))).toThrow(InfoParseError)
  })

  it('reads a document without _type as a track only when it has formats', () => {
    expect(parse(info({ _type: undefined }))).toThrow(InfoParseError)
    expect(track({ _type: undefined, formats: [] })).toStrictEqual(minimal)
  })

  it.each([
    ['no id', { id: undefined }],
    ['an empty id', { id: '  ' }],
    ['no title', { title: undefined }],
    ['a whitespace title', { title: ' \t' }],
    ['a numeric title', { title: 1999 }],
  ])('refuses a track with %s', (_label, fields) => {
    expect(parse(info(fields))).toThrow(InfoParseError)
  })

  it('turns a numeric id into a string', () => {
    expect(track({ id: 62986583 }).id).toBe('62986583')
  })

  it('drops nulls and empty strings instead of failing', () => {
    expect(
      track({
        uploader: '',
        channel: 'Channel',
        artist: null,
        artists: [null, '', 'Real Artist'],
        duration: null,
        thumbnail: null,
        thumbnails: null,
        availability: null,
        live_status: null,
        formats: null,
      }),
    ).toStrictEqual({ ...minimal, artist: 'Real Artist', uploader: 'Channel' })
  })

  it('drops wrongly typed fields instead of failing', () => {
    expect(
      track({
        uploader: { name: 'x' },
        artists: 'not a list',
        duration: '120',
        thumbnail: 7,
        thumbnails: 'nope',
        formats: { 0: {} },
        live_status: 7,
        extractor_key: 3,
      }),
    ).toStrictEqual(minimal)
  })

  it('drops a negative duration and keeps zero', () => {
    expect(track({ duration: -5 }).durationSec).toBeUndefined()
    expect(track({ duration: 0 }).durationSec).toBe(0)
  })

  it('drops non-http and placeholder thumbnails', () => {
    expect(
      track({
        thumbnail: 'javascript:alert(1)',
        thumbnails: [
          { url: 'https://img.example/ok.jpg', width: 10 },
          { url: 'file:///etc/passwd', width: 9999 },
          { url: 'data:image/png;base64,AAAA', width: 9999 },
          { url: 'https://i.ytimg.com/img/no_thumbnail.jpg', width: 9999 },
          { url: 'https://a1.sndcdn.com/images/default_avatar_large.png', width: 9999 },
          'garbage',
          null,
        ],
      }).thumbnailUrl,
    ).toBe('https://img.example/ok.jpg')
    expect(
      track({ thumbnail: 'https://i.ytimg.com/img/no_thumbnail.jpg', thumbnails: [] }).thumbnailUrl,
    ).toBeUndefined()
  })

  it.each([
    [
      'preference beats size',
      [
        { url: 'https://img.example/banner', width: 2560, height: 424, preference: -10 },
        { url: 'https://img.example/avatar', width: 900, height: 900 },
        { url: 'https://img.example/original', preference: 1 },
      ],
      'https://img.example/original',
    ],
    [
      'the largest wins without preferences',
      [
        { url: 'https://img.example/small', width: 100, height: 100 },
        { url: 'https://img.example/large', width: 300, height: 300 },
        { url: 'https://img.example/medium', width: 200, height: 200 },
      ],
      'https://img.example/large',
    ],
    [
      'a known size beats an unknown one',
      [
        { url: 'https://img.example/sized', width: 120, height: 90 },
        { url: 'https://img.example/unsized' },
      ],
      'https://img.example/sized',
    ],
    [
      'the later of equals wins, as in yt-dlp’s sorted list',
      [{ url: 'https://img.example/first' }, { url: 'https://img.example/last' }],
      'https://img.example/last',
    ],
  ])('ranks thumbnails like yt-dlp: %s', (_label, thumbnails, expected) => {
    expect(track({ thumbnails }).thumbnailUrl).toBe(expected)
  })

  it('prefers yt-dlp’s own thumbnail pick over the list', () => {
    expect(
      track({
        thumbnail: 'https://img.example/picked',
        thumbnails: [{ url: 'https://img.example/bigger', width: 4000, height: 4000 }],
      }).thumbnailUrl,
    ).toBe('https://img.example/picked')
  })

  it('falls back from a non-http page URL to the original URL, then to the input', () => {
    expect(
      track({ webpage_url: 'ftp://example.com/x', original_url: 'https://youtu.be/abcdefghijk' })
        .url,
    ).toBe('https://youtu.be/abcdefghijk')
    expect(track({ webpage_url: undefined }).url).toBe(youtubeInput.url)
  })

  it('names the platform from the extractor, else from the classified input', () => {
    expect(track({ extractor_key: 'Generic' }).platform).toBe('other')
    expect(track({ extractor_key: 'SoundcloudSet' }).platform).toBe('soundcloud')
    const soundcloudInput = classified('https://soundcloud.com/user/song')
    expect(track({ extractor_key: undefined }, soundcloudInput).platform).toBe('soundcloud')
  })

  it('prefers the track field to the title and platform artists to a split', () => {
    expect(track({ title: 'A - B', track: 'Track Name', artist: 'Platform' })).toMatchObject({
      title: 'Track Name',
      artist: 'Platform',
    })
    expect(track({ title: 'DJ Name - Song (Extended Mix) - Live' })).toMatchObject({
      title: 'Song (Extended Mix) - Live',
      artist: 'DJ Name',
    })
    expect(track({ title: 'Jay-Z Lo-Fi' })).toStrictEqual({ ...minimal, title: 'Jay-Z Lo-Fi' })
  })

  it.each(['is_live', 'is_upcoming'])('marks a track with live_status %s unavailable', (status) => {
    expect(track({ live_status: status })).toStrictEqual({
      ...minimal,
      availability: 'unavailable',
      unavailableReason: 'unavailable',
    })
  })

  it.each(['not_live', 'was_live', 'post_live'])('keeps a %s track available', (status) => {
    expect(track({ live_status: status }).availability).toBe('available')
  })

  describe('previews', () => {
    const soundcloudInput = classified('https://soundcloud.com/user/song')
    const scTrack = (fields: Record<string, unknown>) =>
      track(
        {
          extractor_key: 'Soundcloud',
          webpage_url: 'https://soundcloud.com/user/song',
          duration: 30,
          ...fields,
        },
        soundcloudInput,
      )
    const preview = { format_id: 'http_mp3_0_0_preview', vcodec: 'none', acodec: 'mp3', abr: 128 }
    const full = { format_id: 'hls_aac_160k', vcodec: 'none', acodec: 'mp4a.40.2', abr: 160 }

    it('marks a track with only preview formats preview_only, without duration or source', () => {
      expect(scTrack({ formats: [preview] })).toStrictEqual({
        id: 'abcdefghijk',
        platform: 'soundcloud',
        url: 'https://soundcloud.com/user/song',
        title: 'Song',
        availability: 'unavailable',
        unavailableReason: 'preview_only',
      })
    })

    it('takes the full stream when previews come with one', () => {
      expect(scTrack({ formats: [full, preview] })).toMatchObject({
        availability: 'available',
        durationSec: 30,
        source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
      })
    })

    it('reads a picked preview format when no formats are listed', () => {
      expect(scTrack({ formats: [], format_id: 'http_mp3_0_0_preview' })).toMatchObject({
        availability: 'unavailable',
        unavailableReason: 'preview_only',
      })
      expect(scTrack({ formats: [], format_id: 'hls_aac_160k' }).availability).toBe('available')
    })

    it('never reports SoundCloud’s login-only original as the source', () => {
      const original = { format_id: 'download', vcodec: 'none', acodec: 'wav', abr: 1411 }
      expect(scTrack({ formats: [full, original] }).source).toStrictEqual({
        codec: 'mp4a.40.2',
        bitrateKbps: 160,
      })
    })
  })

  // Synthetic: no recorded SoundCloud track lists Opus any more, but yt-dlp still knows the format
  // and ranks it first (acodec opus > aac > mp3). Downloads ask for `ba[acodec!=opus]/ba`.
  describe('SoundCloud Opus', () => {
    const soundcloudInput = classified('https://soundcloud.com/user/song')
    const scSource = (formats: unknown[]) =>
      track(
        { extractor_key: 'Soundcloud', webpage_url: 'https://soundcloud.com/user/song', formats },
        soundcloudInput,
      ).source
    const format = (format_id: string, acodec: string, abr: number, protocol = 'm3u8_native') => ({
      format_id,
      ext: acodec === 'opus' ? 'opus' : acodec === 'mp3' ? 'mp3' : 'm4a',
      acodec,
      vcodec: 'none',
      abr,
      protocol,
    })
    // As yt-dlp sorts them, worst to best (track.json's list plus the Opus stream).
    const formats = [
      format('hls_mp3_0_0', 'mp3', 128),
      format('http_mp3_0_0', 'mp3', 128, 'http'),
      format('hls_aac_96k', 'mp4a.40.2', 96),
      format('hls_opus_64k', 'opus', 64),
    ]

    it('skips hls_opus_64k for the stream behind it, as the download does', () => {
      expect(scSource(formats)).toStrictEqual({ codec: 'mp4a.40.2', bitrateKbps: 96 })
    })

    it('takes the Opus stream when nothing else is left, like the selector’s `/ba`', () => {
      expect(scSource([format('hls_opus_64k', 'opus', 64)])).toStrictEqual({
        codec: 'opus',
        bitrateKbps: 64,
      })
    })

    it('still skips previews and the original when it falls back to Opus', () => {
      const preview = format('hls_mp3_0_0_preview', 'mp3', 128)
      const original = { format_id: 'download', vcodec: 'none', acodec: 'wav', abr: 1411 }
      expect(scSource([preview, format('hls_opus_64k', 'opus', 64), original])).toStrictEqual({
        codec: 'opus',
        bitrateKbps: 64,
      })
    })

    it('keeps YouTube’s Opus: only SoundCloud’s is skipped', () => {
      expect(track({ formats }).source).toStrictEqual({ codec: 'opus', bitrateKbps: 64 })
    })
  })

  describe('source', () => {
    const audio = (format_id: string, fields: Record<string, unknown> = {}) => ({
      format_id,
      vcodec: 'none',
      acodec: 'opus',
      abr: 130,
      ...fields,
    })
    const muxed = { format_id: '18', vcodec: 'avc1', acodec: 'mp4a.40.2', abr: 96, tbr: 500 }
    const videoOnly = { format_id: '137', vcodec: 'avc1', acodec: 'none', tbr: 4000 }

    it('takes the last audio-only format, past video-only and muxed ones', () => {
      expect(
        track({ formats: [audio('140', { acodec: 'mp4a.40.2' }), audio('251'), muxed, videoOnly] })
          .source,
      ).toStrictEqual({ codec: 'opus', bitrateKbps: 130 })
    })

    it('omits the source when only muxed and video formats exist', () => {
      expect(track({ formats: [muxed, videoOnly] }).source).toBeUndefined()
    })

    it('skips DRM formats and formats of unknown codec', () => {
      expect(
        track({
          formats: [
            audio('140', { acodec: 'mp4a.40.2', abr: 129.5 }),
            audio('234', { acodec: null, abr: null }),
            audio('251', { has_drm: true }),
          ],
        }).source,
      ).toStrictEqual({ codec: 'mp4a.40.2', bitrateKbps: 129.5 })
    })

    it('falls back from abr to tbr, and to the codec alone', () => {
      expect(track({ formats: [audio('a', { abr: null, tbr: 97.2 })] }).source).toStrictEqual({
        codec: 'opus',
        bitrateKbps: 97.2,
      })
      expect(track({ formats: [audio('a', { abr: 0, tbr: null })] }).source).toStrictEqual({
        codec: 'opus',
      })
    })

    it('reads past garbage in the formats list', () => {
      expect(track({ formats: [audio('251'), null, 'x', 42] }).source).toStrictEqual({
        codec: 'opus',
        bitrateKbps: 130,
      })
    })
  })
})

describe('tolerance: collections', () => {
  const playlistInput = classified('https://www.youtube.com/playlist?list=PLtest')
  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    _type: 'url',
    ie_key: 'Youtube',
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Title ${id}`,
    duration: 100,
    ...fields,
  })
  const listing = (entries: unknown, fields: Record<string, unknown> = {}) => ({
    _type: 'playlist',
    extractor_key: 'YoutubeTab',
    id: 'PLtest',
    title: 'List',
    webpage_url: 'https://www.youtube.com/playlist?list=PLtest',
    entries,
    ...fields,
  })
  const collection = (info: unknown, { limit = 100, input = playlistInput } = {}) =>
    collectionOf(normalizeInfo(info, { input, limit }))
  const fullRow = (id: string) => ({
    id,
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Title ${id}`,
    durationSec: 100,
    availability: 'unknown',
    partial: false,
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s', (limit) => {
    expect(() => normalizeInfo(listing([]), { input: playlistInput, limit })).toThrow(RangeError)
  })

  it('refuses a collection without an id', () => {
    expect(() => collection(listing([], { id: null }))).toThrow(InfoParseError)
  })

  it('names a collection by its id when it has no title, and stringifies a numeric id', () => {
    expect(collection(listing([], { id: 2284613, title: '' }))).toMatchObject({
      id: '2284613',
      title: '2284613',
    })
  })

  it('falls back to the original URL, then to the input, for the collection URL', () => {
    expect(
      collection(
        listing([], { webpage_url: 'nope', original_url: 'https://youtube.com/playlist?list=X' }),
      ).url,
    ).toBe('https://youtube.com/playlist?list=X')
    expect(collection(listing([], { webpage_url: null })).url).toBe(playlistInput.url)
  })

  it('takes the channel as owner when the uploader is empty', () => {
    expect(collection(listing([], { uploader: '', channel: 'Chan' })).owner).toBe('Chan')
  })

  it.each([
    ['missing', undefined],
    ['not a list', 'entries'],
  ])('lists no rows when entries are %s', (_label, entries) => {
    expect(collection(listing(entries)).entries).toEqual([])
  })

  it('keeps the first of duplicate rows without counting the repeat as skipped', () => {
    const list = collection(listing([row('a'), row('b'), row('a', { title: 'Again' })]))
    expect(list.entries).toStrictEqual([fullRow('a'), fullRow('b')])
    expect(list.skippedEntries).toBeUndefined()
  })

  it('skips and counts rows without an id or a usable URL', () => {
    const list = collection(
      listing([
        null,
        'row',
        42,
        {},
        row('noid', { id: null }),
        row('nourl', { url: null }),
        row('js', { url: 'javascript:alert(1)' }),
        row('ftp', { url: 'ftp://example.com/x' }),
        row('ok'),
      ]),
    )
    expect(list.entries).toStrictEqual([fullRow('ok')])
    expect(list.skippedEntries).toBe(8)
  })

  it('stringifies numeric row ids and falls back to a row’s webpage_url', () => {
    const list = collection(
      listing([
        row('x', { id: 12345, url: 'https://www.youtube.com/watch?v=12345' }),
        row('y', { url: undefined, webpage_url: 'https://www.youtube.com/watch?v=y' }),
      ]),
    )
    expect(ids(list)).toEqual(['12345', 'y'])
    expect(list.entries[1]?.url).toBe('https://www.youtube.com/watch?v=y')
  })

  it.each([
    [{ availability: 'private' }, 'unavailable', 'private'],
    [{ availability: 'needs_auth' }, 'unavailable', 'login_required'],
    [{ availability: 'subscriber_only' }, 'unavailable', 'login_required'],
    [{ availability: 'premium_only' }, 'unavailable', 'login_required'],
    [{ live_status: 'is_live' }, 'unavailable', 'unavailable'],
    [{ live_status: 'is_upcoming' }, 'unavailable', 'unavailable'],
    [{ title: '[Private video]' }, 'unavailable', 'private'],
    [{ title: '[Deleted video]' }, 'unavailable', 'unavailable'],
    [{ availability: 'public' }, 'unknown', undefined],
    [{ availability: 'unlisted', live_status: 'was_live' }, 'unknown', undefined],
    [{ title: '[Private video] remix' }, 'unknown', undefined],
  ])('reads row %j as %s (%s)', (fields, availability, reason) => {
    const [entry] = collection(listing([row('a', fields)])).entries
    expect(entry?.availability).toBe(availability)
    expect(entry?.unavailableReason).toBe(reason)
  })

  it('treats placeholder titles as YouTube’s only', () => {
    const scInput = classified('https://soundcloud.com/user/tracks')
    const list = collection(
      listing(
        [
          row('1', {
            ie_key: 'Soundcloud',
            url: 'https://soundcloud.com/user/x',
            title: '[Private video]',
          }),
        ],
        { extractor_key: 'SoundcloudUser', webpage_url: 'https://soundcloud.com/user/tracks' },
      ),
      { input: scInput },
    )
    expect(list.entries[0]?.availability).toBe('unknown')
  })

  it('marks a row without a title partial, but not a YouTube row without a duration', () => {
    const list = collection(
      listing([
        row('a', { title: null }),
        row('b', { title: '   ' }),
        row('c', { duration: null }),
      ]),
    )
    expect(list.entries).toStrictEqual([
      {
        id: 'a',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=a',
        durationSec: 100,
        availability: 'unknown',
        partial: true,
      },
      {
        id: 'b',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=b',
        durationSec: 100,
        availability: 'unknown',
        partial: true,
      },
      {
        id: 'c',
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=c',
        title: 'Title c',
        availability: 'unknown',
        partial: false,
      },
    ])
  })

  it('marks a SoundCloud row with a duration full', () => {
    const scInput = classified('https://soundcloud.com/user/tracks')
    const list = collection(
      listing([row('1', { ie_key: 'Soundcloud', url: 'https://soundcloud.com/user/x' })], {
        extractor_key: 'SoundcloudUser',
      }),
      { input: scInput },
    )
    expect(list.entries[0]?.partial).toBe(false)
  })

  it('skips rows that are lists, not tracks, and then drops the track count', () => {
    const list = collection(
      listing(
        [
          row('a'),
          row('PLother', {
            ie_key: 'YoutubeTab',
            url: 'https://www.youtube.com/playlist?list=PLother',
          }),
          { _type: 'playlist', id: 'UCx', title: 'Tab', entries: [] },
          row('PLnokey', {
            ie_key: undefined,
            url: 'https://www.youtube.com/playlist?list=PLnokey',
          }),
          row('b', { ie_key: undefined }),
          row('c', { ie_key: 'Bandcamp', url: 'https://artist.bandcamp.com/track/c' }),
        ],
        { playlist_count: 6 },
      ),
    )
    expect(ids(list)).toEqual(['a', 'b', 'c'])
    expect(list.entries[2]?.platform).toBe('other')
    expect(list.skippedEntries).toBe(3)
    expect(list.trackCount).toBeUndefined()
  })

  it('keeps only ie_key Soundcloud rows of a SoundCloud listing, whatever the URL looks like', () => {
    const scInput = classified('https://soundcloud.com/user')
    const list = collection(
      listing(
        [
          row('1', { ie_key: 'Soundcloud', url: 'https://soundcloud.com/user/a' }),
          row('2', { ie_key: undefined, url: 'https://soundcloud.com/user/b' }),
          row('3', { ie_key: 'SoundcloudSet', url: 'https://soundcloud.com/user/sets/c' }),
        ],
        { extractor_key: 'SoundcloudUser', webpage_url: 'https://soundcloud.com/user' },
      ),
      { input: scInput },
    )
    expect(ids(list)).toEqual(['1'])
    expect(list.skippedEntries).toBe(2)
  })

  it('keeps the track count when only unreadable rows were skipped', () => {
    const list = collection(listing([row('a'), null, row('b')], { playlist_count: 3 }))
    expect(list).toMatchObject({ trackCount: 3, skippedEntries: 1 })
  })

  it.each(['11', -1, 1.5, null])('drops a playlist_count of %j', (count) => {
    expect(collection(listing([row('a')], { playlist_count: count })).trackCount).toBeUndefined()
  })

  it('truncates by the raw row count, before rows are skipped', () => {
    const cut = collection(listing([null, row('a'), row('b')]), { limit: 2 })
    expect(cut).toMatchObject({ truncated: true, skippedEntries: 1 })
    expect(ids(cut)).toEqual(['a'])

    const whole = collection(listing([row('a'), row('b')]), { limit: 2 })
    expect(whole.truncated).toBe(false)
    expect(ids(whole)).toEqual(['a', 'b'])
  })

  it('fills row uploaders from the owner only on a YouTube channel tab', () => {
    const rows = [row('a'), row('b', { uploader: 'Guest' })]
    const channelInput = classified('https://www.youtube.com/@someone/videos')
    const channel = collection(listing(rows, { uploader: 'Someone' }), { input: channelInput })
    expect(channel.entries.map((entry) => entry.uploader)).toEqual(['Someone', 'Guest'])

    const playlist = collection(listing(rows, { uploader: 'Someone' }))
    expect(playlist.entries.map((entry) => entry.uploader)).toEqual([undefined, 'Guest'])

    const scInput = classified('https://soundcloud.com/someone')
    const scRows = [row('1', { ie_key: 'Soundcloud', url: 'https://soundcloud.com/other/x' })]
    const user = collection(
      listing(scRows, { extractor_key: 'SoundcloudUser', uploader: 'Someone' }),
      { input: scInput },
    )
    expect(user.entries[0]?.uploader).toBeUndefined()
  })

  it('lets the classified input decide the kind', () => {
    const channelId = `UC${'a'.repeat(22)}`
    expect(collection(listing([], { id: channelId })).kind).toBe('playlist')
  })

  describe('kind inference without an input kind', () => {
    const otherInput = classified('https://example.com/list')
    const inferred = (fields: Record<string, unknown>) =>
      collection(listing([], { webpage_url: 'https://example.com/list', ...fields }), {
        input: otherInput,
      }).kind

    it.each([
      ['an OLAK id', { id: 'OLAK5uy_abc' }, 'album'],
      ['an RD id', { id: 'RDabcdefghijk' }, 'mix'],
      ['an RDCLAK5uy_ id', { id: 'RDCLAK5uy_abc' }, 'playlist'],
      ['a UC id', { id: `UC${'a'.repeat(22)}` }, 'channel'],
      ['a PL id', { id: 'PLabc' }, 'playlist'],
      ['a SoundcloudSet extractor', { extractor_key: 'SoundcloudSet', id: '1' }, 'set'],
      ['a SoundcloudUser extractor', { extractor_key: 'SoundcloudUser', id: '1' }, 'channel'],
      [
        'a likes page URL',
        { extractor_key: 'SoundcloudUser', webpage_url: 'https://soundcloud.com/u/likes' },
        'likes',
      ],
      [
        'the original URL',
        { webpage_url: null, original_url: 'https://soundcloud.com/u/sets/s' },
        'set',
      ],
      ['another site', { extractor_key: 'Bandcamp', id: 'OLAK5uy_abc' }, 'playlist'],
      [
        'a SoundcloudSet labelled an EP',
        { extractor_key: 'SoundcloudSet', id: '1', album_type: 'ep' },
        'album',
      ],
      [
        'a SoundcloudSet labelled a playlist',
        { extractor_key: 'SoundcloudSet', id: '1', album_type: 'playlist' },
        'set',
      ],
    ])('reads %s', (_label, fields, kind) => {
      expect(inferred(fields)).toBe(kind)
    })
  })

  describe('SoundCloud release kinds', () => {
    const setUrl = 'https://soundcloud.com/someone/sets/name'
    const setInput = classified(setUrl)
    const setListing = (fields: Record<string, unknown>) =>
      listing([], { extractor_key: 'SoundcloudSet', id: '1', webpage_url: setUrl, ...fields })

    it.each([
      ['album', 'album'],
      ['ep', 'album'],
      ['single', 'album'],
      ['compilation', 'album'],
      ['EP', 'album'],
      ['Compilation', 'album'],
      ['  Single  ', 'album'],
      ['playlist', 'set'],
      ['Playlist', 'set'],
      ['', 'set'],
      ['mixtape', 'set'],
      ['albums', 'set'],
      [null, 'set'],
      [7, 'set'],
    ])('reads a set with album_type %j as a %s, over the input’s kind', (albumType, kind) => {
      expect(setInput.collectionKind).toBe('set')
      expect(collection(setListing({ album_type: albumType }), { input: setInput }).kind).toBe(kind)
    })

    it('keeps a set without album_type a set', () => {
      expect(collection(setListing({}), { input: setInput }).kind).toBe('set')
    })

    it('reads the label of an API playlist URL too', () => {
      const apiInput = classified('https://api-v2.soundcloud.com/playlists/123')
      const apiListing = setListing({ extractor_key: 'SoundcloudPlaylist', album_type: 'album' })
      expect(collection(apiListing, { input: apiInput }).kind).toBe('album')
    })

    it.each([
      [
        'a SoundCloud user page',
        'https://soundcloud.com/someone/tracks',
        'SoundcloudUser',
        'channel',
      ],
      ['SoundCloud likes', 'https://soundcloud.com/someone/likes', 'SoundcloudUser', 'likes'],
      [
        'a YouTube playlist',
        'https://www.youtube.com/playlist?list=PLtest',
        'YoutubeTab',
        'playlist',
      ],
      [
        'a YouTube mix',
        'https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk',
        'YoutubeTab',
        'mix',
      ],
      // Only SoundCloud's own label counts: here another extractor answered a set URL.
      [
        'a set listed by another site',
        'https://soundcloud.com/someone/sets/name',
        'Generic',
        'set',
      ],
    ])('leaves the kind of %s alone, whatever its album_type', (_label, url, key, kind) => {
      const info = listing([], { extractor_key: key, webpage_url: url, album_type: 'album' })
      expect(collection(info, { input: classified(url) }).kind).toBe(kind)
    })
  })

  describe('derived owners', () => {
    describe('SoundCloud user pages', () => {
      const pageUrl = 'https://soundcloud.com/someone/tracks'
      const userPage = (title: unknown, fields: Record<string, unknown> = {}) =>
        collection(
          listing([], {
            extractor_key: 'SoundcloudUser',
            id: '9',
            webpage_url: pageUrl,
            title,
            ...fields,
          }),
          { input: classified(pageUrl) },
        )

      it.each([
        ['The Royal Concept (All)', 'The Royal Concept'],
        ['Levi Ryan (Likes)', 'Levi Ryan'],
        ['DJ (Live) (Tracks)', 'DJ (Live)'],
        ['Artist - Name (Reposts)', 'Artist - Name'],
        ['Name (Popular-tracks)', 'Name'],
        ['Name (Spotlight)', 'Name'],
        ['Name  (Albums)', 'Name'],
      ])('names the user of %j %j and keeps the title', (title, owner) => {
        expect(userPage(title)).toMatchObject({ title, owner })
      })

      it.each([
        ['no suffix', 'The Royal Concept'],
        ['only a suffix', '(All)'],
        ['a suffix that is not a word', 'Name (2024)'],
        ['a suffix of several words', 'Name (Live set)'],
        ['no space before the suffix', 'Name(All)'],
        ['text after the suffix', 'Name (All) x'],
        ['no title', null],
      ])('names nobody for a title with %s', (_label, title) => {
        expect(userPage(title).owner).toBeUndefined()
      })

      it('keeps the listed uploader or channel when there is one', () => {
        expect(userPage('Name (All)', { uploader: 'Listed' }).owner).toBe('Listed')
        expect(userPage('Name (All)', { channel: 'Channel' }).owner).toBe('Channel')
      })

      it('reads the title format only from the user-page extractor', () => {
        // SoundcloudRelated titles a track's related lists "<track title> (Albums)".
        const related = userPage('Sexapil - Pingers 5 (Albums)', {
          extractor_key: 'SoundcloudRelated',
        })
        expect(related.owner).toBeUndefined()
        const setUrl = 'https://soundcloud.com/someone/sets/live'
        const set = collection(
          listing([], {
            extractor_key: 'SoundcloudSet',
            id: '1',
            webpage_url: setUrl,
            title: 'Summer (Live)',
          }),
          { input: classified(setUrl) },
        )
        expect(set.owner).toBeUndefined()
      })
    })

    describe('YouTube Music albums', () => {
      const albumUrl = 'https://www.youtube.com/playlist?list=OLAK5uy_test'
      const topicRow = (id: string, channel: string | null) =>
        row(id, { uploader: channel, channel })
      const ownerOf = (rows: unknown[], url = albumUrl, fields: Record<string, unknown> = {}) =>
        collection(listing(rows, { id: 'OLAK5uy_test', webpage_url: url, ...fields }), {
          input: classified(url),
        }).owner

      it('names the artist of an album whose rows share one Topic channel', () => {
        const rows = [topicRow('a', 'Artist - Topic'), topicRow('b', 'Artist - Topic')]
        expect(ownerOf(rows)).toBe('Artist')
      })

      it('ignores rows without a channel, such as deleted videos', () => {
        const rows = [
          topicRow('a', 'Artist - Topic'),
          row('b', { title: '[Deleted video]', duration: null }),
          topicRow('c', null),
        ]
        expect(ownerOf(rows)).toBe('Artist')
      })

      it('reads a row’s channel when it has no uploader', () => {
        expect(ownerOf([row('a', { channel: 'Artist - Topic' })])).toBe('Artist')
      })

      it.each([
        ['several Topic channels (a compilation)', ['Artist A - Topic', 'Artist B - Topic']],
        ['a Topic channel and a regular one', ['Artist - Topic', 'Artist']],
        ['one regular channel', ['Artist', 'Artist']],
        ['a lowercase topic', ['Artist - topic']],
        ['a Topic suffix alone', [' - Topic']],
        ['no channels at all', [null, null]],
      ])('names nobody for %s', (_label, channels) => {
        expect(ownerOf(channels.map((channel, index) => topicRow(`r${index}`, channel)))).toBe(
          undefined,
        )
      })

      it('names nobody for an empty album', () => {
        expect(ownerOf([])).toBeUndefined()
      })

      it('keeps the listed uploader when there is one', () => {
        const rows = [topicRow('a', 'Artist - Topic')]
        expect(ownerOf(rows, albumUrl, { uploader: 'Label' })).toBe('Label')
      })

      it.each([
        ['a playlist', 'https://www.youtube.com/playlist?list=PLtest'],
        ['a mix', 'https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk'],
        ['a channel tab', 'https://www.youtube.com/@someone/videos'],
      ])('names nobody for %s of one Topic channel’s tracks', (_label, url) => {
        const rows = [topicRow('a', 'Artist - Topic'), topicRow('b', 'Artist - Topic')]
        expect(ownerOf(rows, url)).toBeUndefined()
      })
    })
  })
})
