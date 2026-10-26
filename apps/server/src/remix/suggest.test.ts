import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  MAX_REMIX_SUGGESTIONS,
  MAX_REMIX_UPLOADS,
  MAX_TRACK_TEXT_LENGTH,
  type RemixSuggestion,
  RemixSuggestionSchema,
  RemixUploadSchema,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  MAX_DURATION_SEC,
  MAX_QUERY_LENGTH,
  MIN_DURATION_SEC,
  parseSearchResults,
  type RemixCandidate,
  remixQuery,
  SEARCH_COUNTS,
  type Song,
  songOf,
  suggestRemixes,
  versionOf,
} from './suggest.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures')
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'))

/** `songOf` for names that have words. */
function song(request: Parameters<typeof songOf>[0]): Song {
  const found = songOf(request)
  if (found === undefined) throw new Error(`no song in ${JSON.stringify(request)}`)
  return found
}

const PORCELAIN = song({ title: 'Porcelain', artist: 'Moby' })

/**
 * The recorded searches for "Moby Porcelain remix" (test/fixtures/youtube/README.md and
 * soundcloud/README.md: `ytsearch30:` and `scsearch30:`, 2026-10-25, yt-dlp 2026.08.19).
 */
const RECORDED = {
  youtube: parseSearchResults('youtube', fixture('youtube/search-remixes-porcelain.json')),
  soundcloud: parseSearchResults('soundcloud', fixture('soundcloud/search-remixes-porcelain.json')),
}

/** The same for "Rick Astley Never Gonna Give You Up remix": the e2e track's song. */
const RECORDED_RICK = {
  youtube: parseSearchResults('youtube', fixture('youtube/search-remixes-never-gonna.json')),
  soundcloud: parseSearchResults(
    'soundcloud',
    fixture('soundcloud/search-remixes-never-gonna.json'),
  ),
}

const byRemixer = (suggestions: readonly RemixSuggestion[], remixer: string) => {
  const found = suggestions.find((suggestion) => suggestion.remixer === remixer)
  if (found === undefined) throw new Error(`no suggestion by ${remixer}`)
  return found
}
const uploadIds = (suggestion: RemixSuggestion) =>
  suggestion.uploads.map((upload) => `${upload.platform}:${upload.id}`)
const allIds = (suggestions: readonly RemixSuggestion[]) => suggestions.flatMap(uploadIds)

let counter = 0
/** A YouTube result: 4:00 long unless `extra` says otherwise. */
function yt(title: string, extra: Partial<RemixCandidate> = {}): RemixCandidate {
  const id = extra.id ?? `yt${String(++counter).padStart(9, '0')}`
  return {
    platform: 'youtube',
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    durationSec: 240,
    ...extra,
  }
}
/** A SoundCloud result: 4:00 long unless `extra` says otherwise. */
function sc(title: string, extra: Partial<RemixCandidate> = {}): RemixCandidate {
  const id = extra.id ?? String(++counter)
  return {
    platform: 'soundcloud',
    id,
    url: `https://soundcloud.com/someone/track-${id}`,
    title,
    durationSec: 240,
    ...extra,
  }
}

describe('songOf', () => {
  it('takes the title and the artist as resolve showed them', () => {
    expect(PORCELAIN).toEqual({
      title: 'Porcelain',
      artist: 'Moby',
      titleWords: ['porcelain'],
      artists: [['moby']],
    })
  })

  it.each([
    ['Never Gonna Give You Up (Official Video) (4K Remaster)', 'Never Gonna Give You Up'],
    ['Porcelain - Radio Edit', 'Porcelain'],
    ['Porcelain [Arty Remix]', 'Porcelain'],
    ['Porcelain | Lyrics', 'Porcelain'],
    ['Porcelain 【MV】', 'Porcelain'],
    ['Porcelain (feat. Someone)', 'Porcelain'],
    ['Porcelain [with Someone]', 'Porcelain'],
    ['Porcelain ft. Someone', 'Porcelain'],
    ['Porcelain featuring Someone Else (Extended Mix)', 'Porcelain'],
  ])('drops featured artists and version notes: %j → %j', (title, expected) => {
    expect(song({ title, artist: 'Moby' }).title).toBe(expected)
  })

  it('takes a pasted remix back to its song, so its search finds the other remixes', () => {
    expect(song({ title: 'Porcelain (Arty Remix)', artist: 'Moby' })).toMatchObject({
      title: 'Porcelain',
      artist: 'Moby',
    })
  })

  it('splits "Artist - Title" when there is no artist', () => {
    expect(song({ title: 'Moby - Porcelain (Arty Remix)', uploader: 'Anjunabeats' })).toEqual({
      title: 'Porcelain',
      artist: 'Moby',
      titleWords: ['porcelain'],
      artists: [['moby']],
    })
  })

  it('drops the artist from "Artist - Title" when it is the artist given, and keeps other titles whole', () => {
    expect(song({ title: 'MOBY - Porcelain', artist: 'Moby' }).title).toBe('Porcelain')
    // "Intro - Live" isn't by an artist called Intro: " - Live" is a version note.
    expect(song({ title: 'Intro - Live', artist: 'The xx' }).title).toBe('Intro')
  })

  it('searches the first of several artists and accepts any of them', () => {
    expect(song({ title: 'Song', artist: 'Moby, Arty & Someone x Other feat. Guest' })).toEqual({
      title: 'Song',
      artist: 'Moby',
      titleWords: ['song'],
      artists: [
        ['moby'],
        ['arty', 'and', 'someone', 'x', 'other'],
        ['arty'],
        ['someone'],
        ['other'],
      ],
    })
  })

  it('searches a duo whole, and accepts either half as a credit', () => {
    expect(song({ title: 'Sun & Moon', artist: 'Above & Beyond' })).toMatchObject({
      artist: 'Above & Beyond',
      artists: [['above', 'and', 'beyond'], ['above'], ['beyond']],
    })
  })

  it("doesn't take an uploader a version note names as the song's artist", () => {
    expect(song({ title: 'Porcelain (Arty Remix)', uploader: 'Arty' })).toEqual({
      title: 'Porcelain',
      titleWords: ['porcelain'],
      artists: [],
    })
  })

  it('falls back to the uploader without " - Topic", searched for but not required', () => {
    expect(song({ title: 'Porcelain', uploader: 'Moby - Topic' })).toEqual({
      title: 'Porcelain',
      artist: 'Moby',
      titleWords: ['porcelain'],
      artists: [],
    })
  })

  it('has no artist when nothing names one', () => {
    expect(song({ title: 'Porcelain' })).toEqual({
      title: 'Porcelain',
      titleWords: ['porcelain'],
      artists: [],
    })
  })

  it('cleans control characters and malformed text out of the names', () => {
    expect(song({ title: 'Porce\u0000lain\n', artist: '\tMoby\uD800' })).toMatchObject({
      title: 'Porce lain',
      artist: 'Moby�',
    })
  })

  it.each(['(Official Video)', '!!!', ' - ', '[Arty Remix] (Lyrics)', '(feat. Someone)'])(
    'is undefined when no words are left of %j',
    (title) => {
      expect(songOf({ title, artist: 'Moby' })).toBeUndefined()
    },
  )
})

describe('remixQuery', () => {
  it('is "<artist> <title> remix"', () => {
    expect(remixQuery(PORCELAIN)).toBe('Moby Porcelain remix')
    expect(remixQuery(song({ title: 'Innerbloom', artist: 'RÜFÜS DU SOL' }))).toBe(
      'RÜFÜS DU SOL Innerbloom remix',
    )
  })

  it('is "<title> remix" without an artist', () => {
    expect(remixQuery({ title: 'Porcelain' })).toBe('Porcelain remix')
  })

  it('turns controls into spaces: the query is one argv entry after --', () => {
    expect(remixQuery({ title: 'Porce\nlain', artist: 'Mo\u0000by' })).toBe(
      'Mo by Porce lain remix',
    )
  })

  it('stops at MAX_QUERY_LENGTH code points, never inside an emoji', () => {
    const query = remixQuery({ title: '🎧'.repeat(MAX_QUERY_LENGTH), artist: 'Moby' })
    expect(Array.from(query).length).toBeLessThanOrEqual(MAX_QUERY_LENGTH)
    expect(query.isWellFormed()).toBe(true)
    expect(query.startsWith('Moby 🎧')).toBe(true)
  })
})

describe('parseSearchResults: the recorded searches', () => {
  it('reads every recorded YouTube result as a video with its page, views and channel', () => {
    expect(RECORDED.youtube).toHaveLength(SEARCH_COUNTS.youtube)
    const [first] = RECORDED.youtube
    expect(first).toMatchObject({
      platform: 'youtube',
      id: 'i_D7Uvf_LEY',
      url: 'https://www.youtube.com/watch?v=i_D7Uvf_LEY',
      title: 'Moby - Porcelain (Arty Remix)',
      uploader: 'Anjunabeats',
      durationSec: 214,
      plays: 597540,
    })
    expect(first?.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/i_D7Uvf_LEY\//)
    expect(first?.description).toMatch(/^Buy\/Stream: /)
  })

  it('reads every recorded SoundCloud result with its page, plays, genre, tags and artists', () => {
    expect(RECORDED.soundcloud).toHaveLength(SEARCH_COUNTS.soundcloud)
    expect(RECORDED.soundcloud[0]).toEqual({
      platform: 'soundcloud',
      id: '305222436',
      // The page, not the API URL the flat entry's `url` holds.
      url: 'https://soundcloud.com/moby/porcelain-arty-remix',
      title: 'Porcelain (Arty Remix)',
      uploader: 'Moby',
      durationSec: 211.248,
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-UNuzCHgYiSGf-0-original.png',
      plays: 26608,
      platformGenre: 'Dance',
      tags: ['Electronica'],
      artists: ['Moby and ARTY'],
    })
  })

  it('gives uploads the contract accepts, the server-side clues aside', () => {
    for (const candidate of [...Object.values(RECORDED), ...Object.values(RECORDED_RICK)].flat()) {
      const { platformGenre: _g, tags: _t, description: _d, artists: _a, ...upload } = candidate
      expect(RemixUploadSchema.safeParse(upload).success, candidate.id).toBe(true)
    }
  })
})

describe('parseSearchResults: tolerance', () => {
  const entry = (fields: Record<string, unknown>) => ({
    id: 'i_D7Uvf_LEY',
    title: 'Moby - Porcelain (Arty Remix)',
    url: 'https://www.youtube.com/watch?v=i_D7Uvf_LEY',
    ...fields,
  })
  const youtube = (...entries: unknown[]) => parseSearchResults('youtube', { entries })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'ERROR'],
    ['entries that are no list', { entries: 'x' }],
    ['no entries', {}],
  ])('reads %s as no results', (_label, json) => {
    expect(parseSearchResults('youtube', json)).toEqual([])
    expect(parseSearchResults('soundcloud', json)).toEqual([])
  })

  it('skips entries that are junk or lack an id or a title, keeping the rest', () => {
    const results = youtube(
      null,
      7,
      'x',
      {},
      entry({ id: undefined }),
      entry({ title: '   ' }),
      entry({ id: 'kYtYCdrEFCE', title: 'Porcelain (SICK INDIVIDUALS Remix)' }),
    )
    expect(results.map((result) => result.id)).toEqual(['kYtYCdrEFCE'])
  })

  it('drops fields of the wrong shape instead of the entry', () => {
    const [result] = youtube(
      entry({
        duration: 'long',
        view_count: -1,
        channel: 42,
        thumbnail: 'javascript:alert(1)',
        tags: ['Trance', 7, null, ''],
        live_status: ['x'],
      }),
    )
    expect(result).toEqual({
      platform: 'youtube',
      id: 'i_D7Uvf_LEY',
      url: 'https://www.youtube.com/watch?v=i_D7Uvf_LEY',
      title: 'Moby - Porcelain (Arty Remix)',
      tags: ['Trance'],
    })
  })

  it("rebuilds a YouTube video's page from its id, whatever its url says", () => {
    const [result] = youtube(
      entry({ url: 'https://music.youtube.com/watch?v=i_D7Uvf_LEY&list=RDAMVM&si=tracking' }),
    )
    expect(result?.url).toBe('https://www.youtube.com/watch?v=i_D7Uvf_LEY')
    const [bare] = youtube(entry({ url: undefined }))
    expect(bare?.url).toBe('https://www.youtube.com/watch?v=i_D7Uvf_LEY')
  })

  it('skips shorts, live and upcoming streams, and ids that are no video id', () => {
    expect(
      youtube(
        entry({ url: 'https://www.youtube.com/shorts/i_D7Uvf_LEY' }),
        entry({ id: 'MU5FD_0iWHk', live_status: 'is_live' }),
        entry({ id: 'kYtYCdrEFCE', live_status: 'is_upcoming' }),
        entry({ id: 'PLt5yu3-wZAlQAaPZ5Z' }),
        entry({ id: '../../etc' }),
        entry({ id: '7xh_HUtX_6c', live_status: 'was_live' }),
      ).map((result) => result.id),
    ).toEqual(['7xh_HUtX_6c'])
  })

  it('takes a SoundCloud track by its page, and only a track page', () => {
    const soundcloud = (fields: Record<string, unknown>) =>
      parseSearchResults('soundcloud', {
        entries: [{ id: 305222436, title: 'Porcelain (Arty Remix)', ...fields }],
      })
    expect(
      soundcloud({ webpage_url: 'https://soundcloud.com/moby/porcelain-arty-remix' }),
    ).toMatchObject([{ id: '305222436', url: 'https://soundcloud.com/moby/porcelain-arty-remix' }])
    // A set, a user page, the API URL a flat entry lists, another site, or no page at all.
    for (const url of [
      'https://soundcloud.com/moby/sets/porcelain-remixes',
      'https://soundcloud.com/moby',
      'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A305222436',
      'https://www.youtube.com/watch?v=i_D7Uvf_LEY',
      undefined,
    ]) {
      expect(soundcloud({ webpage_url: url, url }), String(url)).toEqual([])
    }
  })

  it("prefers SoundCloud's genres list to its genre field, skipping junk", () => {
    const [result] = parseSearchResults('soundcloud', {
      entries: [
        {
          id: '1',
          title: 'Moby - Porcelain (X Remix)',
          webpage_url: 'https://soundcloud.com/x/porcelain',
          genre: 'Techno',
          genres: [5, 'Drum & Bass'],
          artists: [null, 'Moby'],
        },
      ],
    })
    expect(result).toMatchObject({ platformGenre: 'Drum & Bass', artists: ['Moby'] })
  })

  it('clips titles and uploaders to MAX_TRACK_TEXT_LENGTH between code points', () => {
    // An odd start, then emoji (two UTF-16 units each): a cut at the limit would split one.
    const long = `a${'🎧'.repeat(MAX_TRACK_TEXT_LENGTH)}`
    const [result] = youtube(entry({ title: long, channel: long }))
    expect(result?.title.length).toBe(MAX_TRACK_TEXT_LENGTH - 1)
    expect(result?.title.isWellFormed()).toBe(true)
    expect(result?.uploader).toBe(result?.title)
    const [exact] = youtube(entry({ title: 'b'.repeat(MAX_TRACK_TEXT_LENGTH) }))
    expect(exact?.title).toBe('b'.repeat(MAX_TRACK_TEXT_LENGTH))
  })

  it('never lets a result through that would break the contract', () => {
    const results = [
      ...youtube(entry({ view_count: 1e20 }), entry({ duration: 1e9 })),
      ...parseSearchResults('soundcloud', {
        entries: [
          {
            id: '9'.repeat(300),
            title: 'Moby - Porcelain (X Remix)',
            webpage_url: 'https://soundcloud.com/x/porcelain',
          },
        ],
      }),
    ]
    for (const {
      platformGenre: _g,
      tags: _t,
      description: _d,
      artists: _a,
      ...upload
    } of results) {
      expect(RemixUploadSchema.safeParse(upload).success, JSON.stringify(upload)).toBe(true)
    }
  })
})

describe('versionOf: what counts as a version of the song', () => {
  it.each([
    [MIN_DURATION_SEC - 1, false],
    [MIN_DURATION_SEC, true],
    [MAX_DURATION_SEC, true],
    [MAX_DURATION_SEC + 1, false],
  ])('takes a track length only: %s s → %s', (durationSec, kept) => {
    const version = versionOf(yt('Moby - Porcelain (Arty Remix)', { durationSec }), PORCELAIN)
    expect(version !== undefined).toBe(kept)
  })

  it('needs a duration', () => {
    const { durationSec: _, ...noDuration } = yt('Moby - Porcelain (Arty Remix)')
    expect(versionOf(noDuration, PORCELAIN)).toBeUndefined()
  })

  it("needs every word of the song's title outside the notes", () => {
    expect(versionOf(yt('Moby - Natural Blues (Porcelain Remix)'), PORCELAIN)).toBeUndefined()
    expect(versionOf(yt('Moby - Porcelain Dreams (Arty Remix)'), PORCELAIN)).toBeDefined()
    const twoWords = song({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' })
    expect(versionOf(yt('Rick Astley - Never Gonna Give Up (X Remix)'), twoWords)).toBeUndefined()
  })

  it('needs one of the artists in the title, the uploader or SoundCloud artists', () => {
    expect(versionOf(yt('Porcelain (Arty Remix)', { uploader: 'Anjunabeats' }), PORCELAIN)).toBe(
      undefined,
    )
    expect(versionOf(yt('Porcelain (Arty Remix)', { uploader: 'Moby' }), PORCELAIN)).toMatchObject({
      kind: 'remix',
      remixer: 'Arty',
    })
    expect(
      versionOf(sc('Porcelain (Arty Remix)', { artists: ['Moby and ARTY'] }), PORCELAIN),
    ).toMatchObject({ kind: 'remix', remixer: 'Arty' })
    const several = song({ title: 'Porcelain', artist: 'Moby & Someone' })
    expect(versionOf(yt('Someone - Porcelain (Arty Remix)'), several)).toBeDefined()
  })

  it('asks no artist of a song whose uploader only stood in for one', () => {
    const standIn = song({ title: 'Porcelain', uploader: 'Moby - Topic' })
    expect(versionOf(yt('Porcelain (Arty Remix)', { uploader: 'Anjunabeats' }), standIn)).toEqual({
      kind: 'remix',
      remixer: 'Arty',
      note: ['arty', 'remix'],
    })
  })

  it.each([
    'Moby - Porcelain (Arty Remix) [Live]',
    'Moby - Porcelain (Arty Remix) slowed + reverb',
    'Moby - Porcelain (Arty Remix) sped up',
    'Moby - Porcelain (Arty Remix) Instrumental',
    'Moby - Porcelain (Piano Cover)',
    'Moby - Porcelain Remix (1 Hour Loop)',
    'Moby - Porcelain (Arty Remix) Nightcore',
    'Moby - Porcelain (Mark Sherry Remix) PREVIEW',
    'Moby x Enya - Porcelain (X Mashup Remix)',
    'Moby - Porcelain (Arty Remix) | Reaction',
  ])('is not a version to play: %j', (title) => {
    expect(versionOf(yt(title), PORCELAIN)).toBeUndefined()
  })

  it("keeps a word that names no version when it is the song's own name", () => {
    const liveForever = song({ title: 'Live Forever', artist: 'Oasis' })
    expect(versionOf(yt('Oasis - Live Forever (Arty Remix)'), liveForever)).toMatchObject({
      kind: 'remix',
      remixer: 'Arty',
    })
  })

  it('needs a note that names a version: the original, re-uploads and remasters are not', () => {
    for (const title of [
      'Moby - Porcelain',
      'Moby - Porcelain (Official Video)',
      'Moby - Porcelain (Radio Edit)',
      'Moby - Porcelain (Original Mix)',
      'Moby - Porcelain (Album Version)',
      'Moby - Porcelain Remastered HQ',
      'Moby - Porcelain (Edit)',
      'Moby - Porcelain (Mix)',
      'Moby - Porcelain (The beach soundtrack)',
    ]) {
      expect(versionOf(yt(title), PORCELAIN), title).toBeUndefined()
    }
  })

  it.each([
    ['Moby - Porcelain (Arty Remix)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty RMX)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Rework)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Flip)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Refix)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Dub)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty VIP)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Moby VIP)', { kind: 'remix', remixer: 'Moby' }],
    ['Moby - Porcelain (Arty Bootleg)', { kind: 'bootleg', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Edit)', { kind: 'bootleg', remixer: 'Arty' }],
    ['Moby - Porcelain (Bootleg)', { kind: 'bootleg' }],
    ['Moby - Porcelain (Tim Remix Bootleg)', { kind: 'remix', remixer: 'Tim' }],
    ['Moby - Porcelain (Above & Beyond Mix)', { kind: 'remix', remixer: 'Above & Beyond' }],
    ['Moby - Porcelain (Extended Mix)', { kind: 'extended' }],
    ['Moby - Porcelain (Club Mix)', { kind: 'extended' }],
    ['Moby - Porcelain (Moby Club Mix)', { kind: 'extended' }],
    ['Moby - Porcelain (Extended Version)', { kind: 'extended' }],
    ['Moby - Porcelain (Arty Club Mix)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain (Arty Extended Remix)', { kind: 'remix', remixer: 'Arty' }],
    ['Moby - Porcelain Remix', { kind: 'remix' }],
    ['Moby - Porcelain [remix]', { kind: 'remix' }],
  ])('reads %j as %j', (title, expected) => {
    const version = versionOf(yt(title), PORCELAIN)
    expect(version).toMatchObject(expected)
    if (!('remixer' in expected)) expect(version?.remixer).toBeUndefined()
  })

  it('reads "Song Remix" with no note as a remix by no one named', () => {
    expect(versionOf(yt('Porcelain Remix', { uploader: 'Moby' }), PORCELAIN)).toEqual({
      kind: 'remix',
      note: ['porcelain', 'remix'],
    })
  })
})

describe('versionOf: who made it', () => {
  const remixer = (title: string, of: Song = PORCELAIN) => versionOf(yt(title), of)?.remixer

  it.each([
    ['Moby - Porcelain (Pola & Bryson Remix)', 'Pola & Bryson'],
    ['Moby - Porcelain (Above and Beyond Remix)', 'Above and Beyond'],
    ['Moby - Porcelain (NIE x Gilla Remix)', 'NIE x Gilla'],
    ['Moby - Porcelain (A vs. B Remix)', 'A vs. B'],
    ['Moby - Porcelain (Remix by Arty)', 'Arty'],
    ['Moby - Porcelain (Remix Version Video by Arty)', 'Arty'],
    ['Moby - Porcelain (Airton Lamadrid Unofficial Remix)', 'Airton Lamadrid'],
    ['Moby - Porcelain (Arty 2016 Remix)', 'Arty'],
    ['Moby - Porcelain (Arty Remix) [FREE DL]', 'Arty'],
    ['Free Download: Moby - Porcelain (Nico Szabo Remix)', 'Nico Szabo'],
    ['Moby - Porcelain (Chiro Radio Remix)', 'Chiro'],
    ['Moby - Porcelain (adamine jungle remix) [FREE DL]', 'adamine'],
    ['Moby - Porcelain (DJ Pappa Techno Remix)', 'DJ Pappa'],
    ['moby - porcelain 🤍 [ pyxl8 remix / bass house / 2026 ]', 'pyxl8'],
    ['Moby - Porcelain (Torsten Stenzel’s Remix)', 'Torsten Stenzel'],
    ["Moby - Porcelain (Torsten Stenzel's Remix)", 'Torsten Stenzel'],
    ['Eric Faria & Oni Remix - Moby - Porcelain', 'Eric Faria & Oni'],
  ])('reads the remixer of %j as %j', (title, expected) => {
    expect(remixer(title)).toBe(expected)
  })

  it.each([
    'Moby - Porcelain (Lofi Remix)',
    'Moby - Porcelain (DnB Remix)',
    'Moby - Porcelain (Drum n Bass Remix)',
    'Moby - Porcelain (Liquid DnB Remix)',
    'Moby - Porcelain (2026 Remix)',
    'Moby - Porcelain (& Remix)',
    'Moby - Porcelain (Porcelain Remix)',
    'Moby - Porcelain (New Official Free Download Remix)',
    'Moby - Porcelain (One Two Three Four Five Six Remix)',
  ])('names no one in %j', (title) => {
    expect(remixer(title)).toBeUndefined()
  })

  it('doesn\'t take the song\'s own artist for the remixer of an unbracketed "Artist Title Remix"', () => {
    // Recorded: SoundCloud 74964274 and 123153768, two different uploaders' remixes.
    expect(versionOf(sc('Moby Porcelain Remix'), PORCELAIN)).toEqual({
      kind: 'remix',
      note: ['moby', 'porcelain', 'remix'],
    })
    // The same for a song whose uploader stood in for the artist.
    const standIn = song({ title: 'Porcelain', uploader: 'Moby' })
    expect(versionOf(sc('Moby Porcelain Remix'), standIn)?.remixer).toBeUndefined()
    // Their own remix, in a note of its own, is theirs.
    expect(remixer('Moby - Porcelain (Moby Remix)')).toBe('Moby')
  })
})

describe('suggestRemixes: the recorded Porcelain searches', () => {
  const { suggestions, found } = suggestRemixes(PORCELAIN, RECORDED)

  it('finds the versions among the results of each platform', () => {
    expect(found).toEqual({ youtube: 22, soundcloud: 27 })
  })

  it('answers suggestions the contract accepts, most played first, at most 20', () => {
    expect(suggestions).toHaveLength(MAX_REMIX_SUGGESTIONS)
    for (const suggestion of suggestions) {
      expect(RemixSuggestionSchema.safeParse(suggestion).success).toBe(true)
    }
    const plays = suggestions.map((suggestion) => suggestion.plays ?? -1)
    expect(plays).toEqual(plays.toSorted((a, b) => b - a))
  })

  it("groups Arty's remix: 2 YouTube and 2 SoundCloud uploads, most played first, on top", () => {
    const [arty] = suggestions
    expect(arty).toEqual({
      kind: 'remix',
      remixer: 'Arty',
      plays: 908188,
      uploads: [
        expect.objectContaining({ platform: 'youtube', id: 'MU5FD_0iWHk', plays: 908188 }),
        expect.objectContaining({ platform: 'youtube', id: 'i_D7Uvf_LEY', plays: 597540 }),
        expect.objectContaining({ platform: 'soundcloud', id: '279991262', plays: 381927 }),
        expect.objectContaining({ platform: 'soundcloud', id: '305222436', plays: 26608 }),
      ],
    })
    // SoundCloud's genres for it, "Dance" and "Dance & EDM", name no listed genre.
    expect(arty?.genre).toBeUndefined()
  })

  it('keeps the "&" of Pola & Bryson, across both platforms', () => {
    expect(uploadIds(byRemixer(suggestions, 'Pola & Bryson'))).toEqual([
      'youtube:CVxY3xhSGYU',
      'soundcloud:318291447',
      'youtube:YSfGNw51ZDk',
    ])
  })

  it('tags genres from the SoundCloud uploaders first', () => {
    expect(
      Object.fromEntries(
        ['Luca Agnelli', 'Pola & Bryson', 'Nico Szabo', 'Lexer', 'adamine', 'CLOVIS'].map(
          (name) => [name, byRemixer(suggestions, name).genre],
        ),
      ),
    ).toEqual({
      'Luca Agnelli': { name: 'Techno', source: 'platform' },
      'Pola & Bryson': { name: 'Drum & Bass', source: 'platform' },
      'Nico Szabo': { name: 'Melodic House', source: 'platform' },
      Lexer: { name: 'Deep House', source: 'platform' },
      adamine: { name: 'Jungle', source: 'platform' },
      CLOVIS: { name: 'Indie Dance', source: 'platform' },
    })
  })

  it('falls back to a genre the tags or a description name, as text', () => {
    // SoundCloud's tags say Trance; its genre field says "Dance".
    expect(byRemixer(suggestions, 'Above & Beyond').genre).toEqual({
      name: 'Trance',
      source: 'text',
    })
    // "a fresh new melodic house remix of a classic", in the YouTube description.
    expect(byRemixer(suggestions, 'Chiro').genre).toEqual({ name: 'Melodic House', source: 'text' })
  })

  it("groups Torsten Stenzel's remix with Torsten Stenzel's Remix", () => {
    expect(uploadIds(byRemixer(suggestions, 'Torsten Stenzel'))).toEqual([
      'youtube:klpJl9DU01I',
      'youtube:L8AfzJLaPr8',
    ])
  })

  it('leaves out the original, its soundtrack re-uploads, the 19-minute loop, live and slowed takes', () => {
    const suggested = new Set(allIds(suggestRemixes(PORCELAIN, RECORDED).suggestions))
    for (const id of [
      'youtube:13EifDb4GYs', // Moby - Porcelain (Official Video)
      'youtube:i_NwqDjsdeQ', // Reprise Version (Official Audio)
      'youtube:A-8n9unyb9M', // (Loop and Extended), 1151 s
      'youtube:lTO7U7SpUFU', // The Beach • Porcelain • Moby
      'youtube:ZablHuqE4WU', // (The beach soundtrack)
      'youtube:j6AQBttp3Hs', // Remastered HQ
      'youtube:waDdL9WBLhY', // (slowed+reverb)
      'youtube:RKaq-jSX7n4', // (Live) | Montreux Jazz Festival
      'soundcloud:219610160', // Porcelain, the original
      'soundcloud:301982118', // Porcelain, a 30 s preview
      'soundcloud:2252316287', // (Mark Sherry's 'Maya Beach' Remix) PREVIEW, 145 s
    ]) {
      expect(suggested.has(id), id).toBe(false)
    }
  })

  it('puts no version past the cap: the 20 most played groups stay', () => {
    const everything = suggestRemixes(PORCELAIN, RECORDED).suggestions
    const fewest = everything.at(-1)?.plays ?? 0
    // Every upload found but left out by the cap was played less than the last suggestion.
    const suggested = new Set(allIds(everything))
    const leftOut = [...RECORDED.youtube, ...RECORDED.soundcloud].filter(
      (candidate) =>
        versionOf(candidate, PORCELAIN) !== undefined &&
        !suggested.has(`${candidate.platform}:${candidate.id}`),
    )
    expect(leftOut.length).toBeGreaterThan(0)
    for (const candidate of leftOut) expect(candidate.plays ?? 0).toBeLessThanOrEqual(fewest)
  })

  it('finds the other remixes for a pasted remix, leaving the pasted upload out', () => {
    const pasted = song({ title: 'Porcelain (Arty Remix)', artist: 'Moby' })
    const answer = suggestRemixes(pasted, RECORDED, { platform: 'soundcloud', id: '305222436' })
    expect(answer.found).toEqual({ youtube: 22, soundcloud: 26 })
    expect(uploadIds(byRemixer(answer.suggestions, 'Arty'))).toEqual([
      'youtube:MU5FD_0iWHk',
      'youtube:i_D7Uvf_LEY',
      'soundcloud:279991262',
    ])
  })
})

describe('suggestRemixes: the recorded Never Gonna Give You Up searches (the e2e track)', () => {
  // What the web sends for the mix's seed video (youtube/mix-track.json), excluding it.
  const pasted = song({
    title: 'Never Gonna Give You Up (Official Video) (4K Remaster)',
    artist: 'Rick Astley',
    uploader: 'Rick Astley',
  })
  const { suggestions, found } = suggestRemixes(pasted, RECORDED_RICK, {
    platform: 'youtube',
    id: 'dQw4w9WgXcQ',
  })

  it('searches the song, not the video', () => {
    expect(remixQuery(pasted)).toBe('Rick Astley Never Gonna Give You Up remix')
  })

  it("puts Krysiek's remix first, its three YouTube uploads together", () => {
    expect(found).toEqual({ youtube: 15, soundcloud: 25 })
    expect(suggestions).toHaveLength(MAX_REMIX_SUGGESTIONS)
    expect(suggestions[0]).toMatchObject({ kind: 'remix', remixer: 'Krysiek', plays: 578820 })
    expect(uploadIds(suggestions[0] as RemixSuggestion)).toEqual([
      'youtube:s5wTiLJ9NVs',
      'youtube:k5zzJ_yWT_k',
      'youtube:frYwkC2ttwc',
    ])
    expect(uploadIds(byRemixer(suggestions, 'Timmo Hendriks'))).toEqual([
      'soundcloud:293956543',
      'soundcloud:294662069',
    ])
  })

  it('leaves out the original videos, mashups, lyric re-uploads, previews and instrumentals', () => {
    const suggested = new Set(allIds(suggestions))
    for (const id of [
      'youtube:dQw4w9WgXcQ', // the pasted video
      'youtube:-PB_XHb93bk', // a TikTok mashup
      'youtube:oT3mCybbhf0', // Never Gonna Wake You Up (… Mashup)
      'youtube:R03-E52o4sw', // KillerCut Mashup
      'youtube:6PLatPMoxGw', // (Lyrics)
      'youtube:XGxIE1hr0w4', // BBC, live
      'soundcloud:2283207164', // LES BISOUS REMIX SAMPLE, 51 s
      'soundcloud:166877736', // Airhorn Remix, 63 s
      'soundcloud:937489183', // Synthwave Remix Instrumental
    ]) {
      expect(suggested.has(id), id).toBe(false)
    }
  })

  it('names the genre of a remix named after it, and no remixer', () => {
    const lofi = suggestions.find((suggestion) =>
      uploadIds(suggestion).includes('soundcloud:856714582'),
    )
    expect(lofi).toMatchObject({ kind: 'remix', genre: { name: 'Lo-Fi', source: 'text' } })
    expect(lofi?.remixer).toBeUndefined()
  })
})

describe('suggestRemixes: grouping', () => {
  it('groups one remixer across platforms, whatever joins the names', () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [yt('Moby - Porcelain (Pola & Bryson Remix)', { plays: 30 })],
      soundcloud: [
        sc('Moby - Porcelain (Pola and Bryson Remix)', { plays: 20 }),
        sc('Moby - Porcelain (POLA x BRYSON Remix)', { plays: 10 }),
      ],
    })
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ remixer: 'Pola & Bryson', plays: 30 })
    expect(suggestions[0]?.uploads.map((upload) => upload.plays)).toEqual([30, 20, 10])
  })

  it("keeps a remixer's extended mix, VIP, bootleg and remix apart", () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [
        yt('Moby - Porcelain (Arty Remix)', { plays: 3 }),
        yt('Moby - Porcelain (Arty Extended Remix)', { plays: 3 }),
        yt('Moby - Porcelain (Arty VIP)', { plays: 2 }),
        yt('Moby - Porcelain (Arty Bootleg)', { plays: 1 }),
      ],
    })
    expect(suggestions.map(({ kind, remixer, plays }) => ({ kind, remixer, plays }))).toEqual([
      { kind: 'remix', remixer: 'Arty', plays: 3 },
      { kind: 'remix', remixer: 'Arty', plays: 3 },
      { kind: 'remix', remixer: 'Arty', plays: 2 },
      { kind: 'bootleg', remixer: 'Arty', plays: 1 },
    ])
  })

  it('groups extended mixes by their note, and remixes by no one named per upload', () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [
        yt('Moby - Porcelain (Extended Mix)', { plays: 5 }),
        yt('Moby - Porcelain (Club Mix)', { plays: 4 }),
        yt('Moby - Porcelain [remix]', { plays: 3 }),
      ],
      soundcloud: [
        sc('Moby - Porcelain (Extended Mix)', { plays: 2 }),
        sc('Moby - Porcelain (Remix)', { plays: 1 }),
      ],
    })
    expect(suggestions.map((suggestion) => suggestion.uploads.length)).toEqual([2, 1, 1, 1])
    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual([
      'extended',
      'extended',
      'remix',
      'remix',
    ])
  })

  it('counts a result listed twice once', () => {
    const twice = yt('Moby - Porcelain (Arty Remix)', { id: 'MU5FD_0iWHk', plays: 9 })
    const { suggestions, found } = suggestRemixes(PORCELAIN, { youtube: [twice, { ...twice }] })
    expect(found.youtube).toBe(1)
    expect(suggestions[0]?.uploads).toHaveLength(1)
  })

  it('leaves out the pasted track, matched by platform and id', () => {
    const pasted = yt('Moby - Porcelain (Arty Remix)', { id: 'MU5FD_0iWHk', plays: 9 })
    const sameIdElsewhere = sc('Moby - Porcelain (Arty Remix)', { id: 'MU5FD_0iWHk', plays: 1 })
    const { suggestions, found } = suggestRemixes(
      PORCELAIN,
      { youtube: [pasted], soundcloud: [sameIdElsewhere] },
      { platform: 'youtube', id: 'MU5FD_0iWHk' },
    )
    expect(found).toEqual({ youtube: 0, soundcloud: 1 })
    expect(uploadIds(suggestions[0] as RemixSuggestion)).toEqual(['soundcloud:MU5FD_0iWHk'])
  })

  it(`lists at most ${MAX_REMIX_UPLOADS} uploads per version, the most played`, () => {
    const uploads = [1, 6, 3, 2, 5, 4].map((plays) =>
      yt('Moby - Porcelain (Arty Remix)', { plays }),
    )
    const [arty] = suggestRemixes(PORCELAIN, { youtube: uploads }).suggestions
    expect(arty?.uploads.map((upload) => upload.plays)).toEqual([6, 5, 4, 3, 2])
    expect(arty?.plays).toBe(6)
  })

  it('takes the remixer as the most played upload that names one spells it', () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [
        yt('Moby - Porcelain (ARTY Remix)', { plays: 1 }),
        yt('Moby - Porcelain (Arty Remix)', { plays: 2 }),
      ],
    })
    expect(suggestions[0]?.remixer).toBe('Arty')
  })

  it("prefers a SoundCloud uploader's genre to a guess from a more played upload's title", () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [yt('Moby - Porcelain (Arty Remix) [Trance]', { plays: 100 })],
      soundcloud: [sc('Moby - Porcelain (Arty Remix)', { plays: 1, platformGenre: 'Techno' })],
    })
    expect(suggestions[0]?.genre).toEqual({ name: 'Techno', source: 'platform' })
  })

  it("takes the most played upload's text genre when no uploader set one", () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      youtube: [yt('Moby - Porcelain (Arty Remix)', { plays: 100, tags: ['Trance'] })],
      soundcloud: [sc('Moby - Porcelain (Arty Remix)', { plays: 1, tags: ['Techno'] })],
    })
    expect(suggestions[0]?.genre).toEqual({ name: 'Trance', source: 'text' })
  })

  it("names no genre from the song's own name", () => {
    const party = song({ title: 'Techno Party', artist: 'Someone' })
    const { suggestions } = suggestRemixes(party, {
      youtube: [yt('Someone - Techno Party (Arty Remix)')],
    })
    expect(suggestions[0]?.genre).toBeUndefined()
  })
})

describe('suggestRemixes: order and caps', () => {
  it('sorts by plays, unknown plays last, ties in search order with YouTube first', () => {
    const { suggestions } = suggestRemixes(PORCELAIN, {
      soundcloud: [
        sc('Moby - Porcelain (S1 Remix)', { plays: 5 }),
        sc('Moby - Porcelain (S2 Remix)'),
        sc('Moby - Porcelain (S3 Remix)', { plays: 9 }),
      ],
      youtube: [
        yt('Moby - Porcelain (Y1 Remix)'),
        yt('Moby - Porcelain (Y2 Remix)', { plays: 5 }),
        yt('Moby - Porcelain (Y3 Remix)', { plays: 0 }),
      ],
    })
    expect(suggestions.map((suggestion) => suggestion.remixer)).toEqual([
      'S3',
      'Y2',
      'S1',
      'Y3',
      'Y1',
      'S2',
    ])
    expect(suggestions.at(-1)?.plays).toBeUndefined()
  })

  it(`keeps the ${MAX_REMIX_SUGGESTIONS} most played versions`, () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      yt(`Moby - Porcelain (Remixer${index} Remix)`, { plays: index }),
    )
    const { suggestions, found } = suggestRemixes(PORCELAIN, { youtube: many })
    expect(found).toEqual({ youtube: 25, soundcloud: 0 })
    expect(suggestions).toHaveLength(MAX_REMIX_SUGGESTIONS)
    expect(suggestions[0]?.plays).toBe(24)
    expect(suggestions.at(-1)?.plays).toBe(5)
  })

  it('answers nothing for no results', () => {
    expect(suggestRemixes(PORCELAIN, {})).toEqual({
      suggestions: [],
      found: { youtube: 0, soundcloud: 0 },
    })
  })
})
