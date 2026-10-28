import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type Collection,
  CollectionSchema,
  classifyUrl,
  type Track,
  TrackSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  EmbedParseError,
  embedPath,
  parseEmbedPage,
  SPOTIFY_EMBED_LIMIT,
  type SpotifyEntity,
  toResolveResult,
} from './embed.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/spotify')
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, name), 'utf8')

/** The embed page each fixture was recorded from (see test/fixtures/spotify/README.md). */
const RECORDED_PAGES: Record<string, string> = {
  'album.html': 'https://open.spotify.com/embed/album/6N9PS4QXF1D0OWPk0Sxtb4',
  'playlist-capped.html': 'https://open.spotify.com/embed/playlist/37i9dQZF1DX4UtSsGT1Sbe',
  'playlist.html': 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
  'track.html': 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
  'track-2.html': 'https://open.spotify.com/embed/track/6aiKIFjPwa3UvDCD5ecoJj',
  'track-3.html': 'https://open.spotify.com/embed/track/76QJgXPE3oc1cnkE4PFHEn',
}

/** What a scrubbed page must never hold (test/fixtures/spotify/trim-embed.mjs refuses the same). */
const SECRETS = [
  /access_?token/i,
  /"[a-z_]*token[a-z_]*"\s*:/i,
  /client_?id/i,
  /correlation[-_]?id/i,
  /sentry/i,
  /"session"\s*:/i,
  /p\.scdn\.co\/mp3-preview/i,
]

const NEXT_DATA = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

function classified(url: string): ValidUrl {
  const result = classifyUrl(url)
  if (!result.ok) throw new Error(`not a valid URL: ${url}`)
  return result
}

/** A page as the embed player serves it, around `data` (and other state the parser must skip). */
function page(data: unknown, state: Record<string, unknown> = {}): string {
  const next = { props: { pageProps: { state: { ...state, data } } }, page: '/[type]/[id]' }
  return `<!DOCTYPE html><html><head><script src="/x.js"></script></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">${JSON.stringify(next)}</script></body></html>`
}

const entityPage = (entity: unknown) => page({ entity })

/** The recorded track's entity, to vary one field at a time. */
function recordedEntity(name: string): Record<string, unknown> {
  const script = NEXT_DATA.exec(fixture(name))?.[1]
  if (script === undefined) throw new Error(`${name} has no data script`)
  return { ...JSON.parse(script).props.pageProps.state.data.entity }
}

const trackOf = (entity: SpotifyEntity) => {
  if (entity.type !== 'track') throw new Error(`expected a track, got a ${entity.type}`)
  return entity.track
}

const listOf = (entity: SpotifyEntity) => {
  if (entity.type === 'track') throw new Error('expected a list, got a track')
  return entity
}

/** The contract's own parse of a result: it must be valid as is, with nothing to strip. */
function resultTrack(entity: SpotifyEntity): Track {
  const result = toResolveResult(entity)
  if (result.kind !== 'track') throw new Error(`expected a track, got a ${result.kind}`)
  expect(TrackSchema.parse(result.track)).toStrictEqual(result.track)
  return result.track
}

function resultCollection(entity: SpotifyEntity): Collection {
  const result = toResolveResult(entity)
  if (result.kind !== 'collection') throw new Error(`expected a collection, got a ${result.kind}`)
  expect(CollectionSchema.parse(result.collection)).toStrictEqual(result.collection)
  return result.collection
}

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  uri: `spotify:track:${id}`,
  uid: `uid-${id}`,
  title: `Song ${id}`,
  subtitle: 'An Artist',
  duration: 180_000,
  entityType: 'track',
  ...fields,
})

/** 22-character base62 ids, as Spotify's are. */
const spotifyId = (n: number) => `${'0'.repeat(22 - String(n).length)}${n}`

const playlistEntity = (rows: unknown[], fields: Record<string, unknown> = {}) => ({
  type: 'playlist',
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'A Playlist',
  title: 'A Playlist',
  subtitle: 'A Curator',
  trackList: rows,
  ...fields,
})

const ALBUM_COVER =
  'https://image-cdn-ak.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673'

describe('recorded embed pages', () => {
  const recorded = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'))

  it('knows the recorded page of every fixture', () => {
    expect(recorded.toSorted()).toEqual(Object.keys(RECORDED_PAGES).toSorted())
  })

  it.each(recorded)('keeps nothing of %s but its data: no token, ids or tracing', (name) => {
    const html = fixture(name)
    for (const secret of SECRETS) expect(html, String(secret)).not.toMatch(secret)
    expect(html.match(/<script\b/g)).toHaveLength(1)
    const next: unknown = JSON.parse(NEXT_DATA.exec(html)?.[1] ?? 'null')
    expect(Object.keys(next as object)).toEqual(['props'])
    const { props } = next as { props: { pageProps: { state: object } } }
    expect(Object.keys(props)).toEqual(['pageProps'])
    expect(Object.keys(props.pageProps)).toEqual(['state'])
    expect(Object.keys(props.pageProps.state)).toEqual(['data'])
  })

  it.each(recorded)('reads %s as the entity its URL names, into contract-valid output', (name) => {
    const input = classified(RECORDED_PAGES[name] ?? '')
    const entity = parseEmbedPage(fixture(name))
    expect(entity.type).toBe(input.kind.replace('spotify_', ''))
    const id = entity.type === 'track' ? entity.track.id : entity.id
    expect(id).toBe(input.spotifyId)
    expect(embedPath(input)).toBe(new URL(RECORDED_PAGES[name] ?? '').pathname)
    if (entity.type === 'track') resultTrack(entity)
    else resultCollection(entity)
  })
})

describe('embedPath', () => {
  it.each([
    [
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      '/embed/track/4uLU6hMCjMI75M1A2tKUQC',
    ],
    [
      'https://open.spotify.com/intl-de/album/6N9PS4QXF1D0OWPk0Sxtb4?si=abc',
      '/embed/album/6N9PS4QXF1D0OWPk0Sxtb4',
    ],
    [
      'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M?utm_source=generator',
      '/embed/playlist/37i9dQZF1DXcBWIGoYBM5M',
    ],
  ])('builds the embed page of %s from its id alone', (url, expected) => {
    expect(embedPath(classified(url))).toBe(expected)
  })

  it.each([
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt',
  ])('refuses %s, which has no Spotify id', (url) => {
    expect(() => embedPath(classified(url))).toThrow(RangeError)
  })
})

describe('parseEmbedPage + toResolveResult: recorded pages', () => {
  it('reads a track: its names, length, year and the largest cover', () => {
    const entity = parseEmbedPage(fixture('track.html'))
    expect(entity).toStrictEqual({
      type: 'track',
      track: {
        id: '4uLU6hMCjMI75M1A2tKUQC',
        title: 'Never Gonna Give You Up',
        artists: ['Rick Astley'],
        durationSec: 213.573,
        releaseYear: 1987,
        coverUrl:
          'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673',
      },
    })
    expect(resultTrack(entity)).toStrictEqual({
      id: '4uLU6hMCjMI75M1A2tKUQC',
      platform: 'spotify',
      url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      durationSec: 213.573,
      thumbnailUrl:
        'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673',
      availability: 'available',
    })
  })

  it("reads an album: 10 complete rows, each with the album's cover", () => {
    const album = resultCollection(parseEmbedPage(fixture('album.html')))
    const { entries, ...rest } = album
    expect(rest).toStrictEqual({
      id: '6N9PS4QXF1D0OWPk0Sxtb4',
      platform: 'spotify',
      url: 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4',
      kind: 'album',
      title: 'Whenever You Need Somebody',
      owner: 'Rick Astley',
      thumbnailUrl: ALBUM_COVER,
      truncated: false,
    })
    expect(entries).toHaveLength(10)
    expect(entries[0]).toStrictEqual({
      partial: false,
      id: '4uLU6hMCjMI75M1A2tKUQC',
      platform: 'spotify',
      url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      durationSec: 213.573,
      thumbnailUrl: ALBUM_COVER,
      availability: 'available',
    })
    expect(entries.at(-1)).toMatchObject({ title: 'When I Fall in Love', durationSec: 183.026 })
    for (const entry of entries) {
      expect(entry).toMatchObject({
        partial: false,
        artist: 'Rick Astley',
        thumbnailUrl: ALBUM_COVER,
      })
      // Their audio is unknown until a download matches them on YouTube.
      expect(entry).not.toHaveProperty('source')
    }
  })

  it('reads a playlist: 50 rows without covers, artists as Spotify lists them', () => {
    const playlist = resultCollection(parseEmbedPage(fixture('playlist.html')))
    expect(playlist).toMatchObject({
      kind: 'playlist',
      title: 'Today’s Top Hits',
      owner: 'Spotify',
      truncated: false,
      thumbnailUrl:
        'https://image-cdn-fa.spotifycdn.com/image/ab67706f0000000330888e59410296f950502d00',
    })
    expect(playlist).not.toHaveProperty('skippedEntries')
    expect(playlist.entries).toHaveLength(50)
    expect(playlist.entries.slice(0, 2)).toStrictEqual([
      {
        partial: false,
        id: '3XmwAZpIMNpTJy8faw3ajD',
        platform: 'spotify',
        url: 'https://open.spotify.com/track/3XmwAZpIMNpTJy8faw3ajD',
        title: 'expectations (feat. Chappell Roan)',
        // Spotify separates artists with a no-break space after the comma.
        artist: 'Olivia Rodrigo, Chappell Roan',
        durationSec: 223.935,
        availability: 'available',
      },
      {
        partial: false,
        id: '70cHKK8bHAfJrOGVnfRG9J',
        platform: 'spotify',
        url: 'https://open.spotify.com/track/70cHKK8bHAfJrOGVnfRG9J',
        title: 'Nicole Kidman',
        artist: 'ADÉLA',
        durationSec: 181.27,
        availability: 'available',
      },
    ])
    for (const entry of playlist.entries) {
      expect(entry).not.toHaveProperty('thumbnailUrl')
      expect(entry.artist ?? '').not.toContain(' ')
    }
  })

  it('marks a playlist the page cut at 100 rows as truncated', () => {
    const entity = listOf(parseEmbedPage(fixture('playlist-capped.html')))
    expect(entity.listed).toBe(SPOTIFY_EMBED_LIMIT)
    const playlist = resultCollection(entity)
    expect(playlist).toMatchObject({ title: 'All Out 80s', truncated: true })
    expect(playlist.entries).toHaveLength(100)
    expect(playlist.entries.map((entry) => entry.title)).toContain(
      'There Is a Light That Never Goes Out - 2011 Remaster',
    )
  })
})

describe('parseEmbedPage: tolerance', () => {
  const track = recordedEntity('track.html')

  it('reads only state.data.entity, never the token beside it', () => {
    const token = 'BQDsecretAnonymousToken'
    const html = page(
      { entity: track },
      { settings: { session: { accessToken: token, isAnonymous: true }, clientId: 'abc' } },
    )
    const entity = parseEmbedPage(html)
    expect(trackOf(entity).id).toBe('4uLU6hMCjMI75M1A2tKUQC')
    expect(JSON.stringify(entity)).not.toContain(token)
    expect(JSON.stringify(toResolveResult(entity))).not.toContain(token)
  })

  it('does not look for the entity anywhere but state.data', () => {
    const html = page(undefined, { settings: { entity: track } })
    expect(() => parseEmbedPage(html)).toThrow(new EmbedParseError("the page's data has no data"))
  })

  it.each([
    ['no duration', { duration: undefined }, { durationSec: undefined }],
    ['a zero duration', { duration: 0 }, { durationSec: undefined }],
    ['a duration as text', { duration: '213573' }, { durationSec: undefined }],
    ['no release date', { releaseDate: null }, { releaseYear: undefined }],
    [
      'a release date without a year',
      { releaseDate: { isoString: 'soon' } },
      { releaseYear: undefined },
    ],
    ['a year-only release date', { releaseDate: { isoString: '1987' } }, { releaseYear: 1987 }],
    ['no visual identity', { visualIdentity: null }, { coverUrl: undefined }],
    [
      'covers that are no web URLs',
      { visualIdentity: { image: [{ url: 'javascript:alert(1)', maxWidth: 640 }, { url: 7 }] } },
      { coverUrl: undefined },
    ],
    [
      'covers without sizes (the first one wins)',
      {
        visualIdentity: {
          image: [{ url: 'https://i.scdn.co/image/a' }, { url: 'https://i.scdn.co/image/b' }],
        },
      },
      { coverUrl: 'https://i.scdn.co/image/a' },
    ],
    ['no name, only a title', { name: undefined, title: 'Title Only' }, { title: 'Title Only' }],
    ['padded names', { name: '  Padded  ' }, { title: 'Padded' }],
  ])('reads a track with %s', (_label, fields, expected) => {
    const read = trackOf(parseEmbedPage(entityPage({ ...track, ...fields })))
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) expect(read).not.toHaveProperty(key)
      else expect(read).toHaveProperty(key, value)
    }
    resultTrack({ type: 'track', track: read })
  })

  it('keeps the artists it can read, in order, and leaves the artist out when none is left', () => {
    const artists = [{ name: 'Main' }, { name: '' }, null, { uri: 'x' }, { name: 'Second' }]
    expect(trackOf(parseEmbedPage(entityPage({ ...track, artists }))).artists).toEqual([
      'Main',
      'Second',
    ])
    const bare = trackOf(parseEmbedPage(entityPage({ ...track, artists: 'Rick Astley' })))
    expect(bare.artists).toEqual([])
    expect(resultTrack({ type: 'track', track: bare })).not.toHaveProperty('artist')
  })

  it('joins several artists for display, the main artist first', () => {
    const artists = [{ name: 'Dave' }, { name: 'Tems' }]
    const read = parseEmbedPage(entityPage({ ...track, artists }))
    expect(resultTrack(read).artist).toBe('Dave, Tems')
  })

  it('skips rows that are no tracks (podcast episodes), counting them', () => {
    const episode = {
      ...row('x'),
      uri: 'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
      entityType: 'episode',
    }
    const entity = listOf(
      parseEmbedPage(entityPage(playlistEntity([row(spotifyId(1)), episode, row(spotifyId(2))]))),
    )
    expect(entity.rows.map((r) => r.id)).toEqual([spotifyId(1), spotifyId(2)])
    expect(entity).toMatchObject({ skipped: 1, listed: 3 })
    expect(resultCollection(entity).skippedEntries).toBe(1)
  })

  it.each([
    ['no uri', { uri: undefined }],
    ['an artist uri', { uri: 'spotify:artist:0gxyHStUsqpMadRV0Di1Qt' }],
    ['a short id', { uri: 'spotify:track:abc' }],
    ['no title', { title: undefined }],
    ['an empty title', { title: '  ' }],
    ['a local file', { uri: 'spotify:local:Artist:Album:Song:180', entityType: 'track' }],
  ])('skips a row with %s, counting it', (_label, fields) => {
    const entity = listOf(
      parseEmbedPage(entityPage(playlistEntity([row(spotifyId(1), fields), row(spotifyId(2))]))),
    )
    expect(entity.rows.map((r) => r.id)).toEqual([spotifyId(2)])
    expect(entity.skipped).toBe(1)
  })

  it('reads a row without an entity type, an artist or a duration as far as it can', () => {
    const bare = row(spotifyId(1), { entityType: undefined, subtitle: null, duration: -1 })
    const entity = listOf(parseEmbedPage(entityPage(playlistEntity([bare]))))
    expect(entity.rows).toStrictEqual([{ id: spotifyId(1), title: `Song ${spotifyId(1)}` }])
    expect(resultCollection(entity).entries[0]).not.toHaveProperty('artist')
  })

  it('lists a track that a playlist holds twice once, in its first place', () => {
    const rows = [row(spotifyId(1)), row(spotifyId(2)), row(spotifyId(1), { title: 'Again' })]
    const entity = listOf(parseEmbedPage(entityPage(playlistEntity(rows))))
    expect(entity.rows.map((r) => [r.id, r.title])).toEqual([
      [spotifyId(1), `Song ${spotifyId(1)}`],
      [spotifyId(2), `Song ${spotifyId(2)}`],
    ])
    expect(entity).toMatchObject({ listed: 3, skipped: 0 })
    expect(resultCollection(entity).skippedEntries).toBeUndefined()
  })

  it.each([
    [SPOTIFY_EMBED_LIMIT - 1, 0, false],
    [SPOTIFY_EMBED_LIMIT, 0, true],
    // The page listed 100 rows, so there may be more, even if some were repeats or episodes.
    [SPOTIFY_EMBED_LIMIT - 1, 1, true],
  ])('marks %i rows (+%i repeated) as truncated: %s', (unique, repeats, truncated) => {
    const rows = Array.from({ length: unique }, (_, i) => row(spotifyId(i + 1)))
    for (let i = 0; i < repeats; i++) rows.push(row(spotifyId(1)))
    const playlist = resultCollection(parseEmbedPage(entityPage(playlistEntity(rows))))
    expect(playlist.entries).toHaveLength(unique)
    expect(playlist.truncated).toBe(truncated)
  })

  it("takes a list's cover from coverArt when it has no visual identity", () => {
    const entity = listOf(
      parseEmbedPage(
        entityPage(
          playlistEntity([row(spotifyId(1))], {
            coverArt: { sources: [{ url: 'nope' }, { url: 'https://i.scdn.co/image/c' }] },
          }),
        ),
      ),
    )
    expect(entity.coverUrl).toBe('https://i.scdn.co/image/c')
  })

  it('gives album rows the album cover, but playlist rows none', () => {
    const cover = {
      visualIdentity: { image: [{ url: 'https://i.scdn.co/image/a', maxWidth: 640 }] },
    }
    const album = resultCollection(
      parseEmbedPage(entityPage({ ...playlistEntity([row(spotifyId(1))], cover), type: 'album' })),
    )
    const playlist = resultCollection(
      parseEmbedPage(entityPage(playlistEntity([row(spotifyId(1))], cover))),
    )
    expect(album).toMatchObject({ kind: 'album', thumbnailUrl: 'https://i.scdn.co/image/a' })
    expect(album.entries[0]?.thumbnailUrl).toBe('https://i.scdn.co/image/a')
    expect(playlist).toMatchObject({ kind: 'playlist', thumbnailUrl: 'https://i.scdn.co/image/a' })
    expect(playlist.entries[0]).not.toHaveProperty('thumbnailUrl')
  })

  it('reads a list without a track list, an owner or a cover as empty', () => {
    const bare = { type: 'album', id: '6N9PS4QXF1D0OWPk0Sxtb4', name: 'Bare' }
    const album = resultCollection(parseEmbedPage(entityPage(bare)))
    expect(album).toStrictEqual({
      id: '6N9PS4QXF1D0OWPk0Sxtb4',
      platform: 'spotify',
      url: 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4',
      kind: 'album',
      title: 'Bare',
      truncated: false,
      entries: [],
    })
  })
})

describe('parseEmbedPage: pages it refuses', () => {
  const track = recordedEntity('track.html')

  it.each([
    [
      'no data script',
      '<html><body><script>window.x = 1</script></body></html>',
      'no __NEXT_DATA__',
    ],
    [
      'a data script that is no JSON',
      '<script id="__NEXT_DATA__" type="application/json">{"props": nope}</script>',
      'is not JSON (15 characters)',
    ],
    ['no page props', '<script id="__NEXT_DATA__">{"props":{}}</script>', 'has no pageProps'],
    ['data that is null', page(null), 'has no entity'],
    [
      'an artist page',
      entityPage({ type: 'artist', id: '0gxyHStUsqpMadRV0Di1Qt', name: 'X' }),
      'not a track, album or playlist',
    ],
    ['an episode', entityPage({ ...track, type: 'episode' }), 'not a track, album or playlist'],
    [
      'a track without an id',
      entityPage({ ...track, id: 'short' }),
      'the track has no id or title',
    ],
    [
      'a track without a name',
      entityPage({ ...track, name: '', title: null }),
      'the track has no id or title',
    ],
    [
      'a playlist without a title',
      entityPage(playlistEntity([], { name: 1, title: '' })),
      'the playlist has no id or title',
    ],
  ])('refuses a page with %s, without quoting it', (_label, html, message) => {
    let error: unknown
    try {
      parseEmbedPage(html)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EmbedParseError)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain('nope')
    expect((error as Error).message).not.toContain('Never Gonna')
  })
})

describe('toResolveResult: the contract', () => {
  it('throws when a track breaks the contract (the resolver answers unknown)', () => {
    const entity: SpotifyEntity = {
      type: 'track',
      track: { id: '4uLU6hMCjMI75M1A2tKUQC', title: 'X', artists: [], coverUrl: 'ftp://x/y.jpg' },
    }
    expect(() => toResolveResult(entity)).toThrow(
      new EmbedParseError("the track doesn't fit the contract"),
    )
  })

  it.each(['album', 'playlist'] as const)(
    'throws when a whole %s breaks the contract, naming only its kind',
    (type) => {
      const entity: SpotifyEntity = {
        type,
        id: '6N9PS4QXF1D0OWPk0Sxtb4',
        title: 'A List',
        coverUrl: 'ftp://x/y.jpg',
        rows: [],
        skipped: 0,
        listed: 0,
      }
      expect(() => toResolveResult(entity)).toThrow(
        new EmbedParseError(`the ${type} doesn't fit the contract`),
      )
    },
  )

  it('leaves out the rows the contract refuses, counting them with the skipped ones', () => {
    const entity: SpotifyEntity = {
      type: 'playlist',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      title: 'A Playlist',
      rows: [
        { id: spotifyId(1), title: 'Fine', durationSec: 200 },
        { id: spotifyId(2), title: 'Negative', durationSec: -5 },
        { id: spotifyId(3), title: 'Also fine' },
      ],
      skipped: 1,
      listed: 4,
    }
    const playlist = resultCollection(entity)
    expect(playlist.entries.map((entry) => entry.id)).toEqual([spotifyId(1), spotifyId(3)])
    expect(playlist.skippedEntries).toBe(2)
  })

  it('links every row to its canonical track page, never to the list', () => {
    const playlist = resultCollection(parseEmbedPage(fixture('playlist.html')))
    for (const entry of playlist.entries) {
      expect(entry.url).toBe(`https://open.spotify.com/track/${entry.id}`)
      expect(classifyUrl(entry.url)).toMatchObject({ ok: true, kind: 'spotify_track' })
    }
  })
})
