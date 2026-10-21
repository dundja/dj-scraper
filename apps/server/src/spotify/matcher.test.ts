import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyUrl, type ValidUrl } from '@dj-scraper/shared'
import { describe, expect, it, vi } from 'vitest'
import { type RunResult, type run, SpawnError } from '../engine/run.ts'
import { searchArgs } from '../engine/ytdlp-args.ts'
import { CANCELED } from '../resolve/ytdlp-call.ts'
import {
  SPOTIFY_NOT_FOUND,
  SPOTIFY_RATE_LIMITED,
  type SpotifyClient,
  SpotifyError,
} from './client.ts'
import { parseEmbedPage, type SpotifyEntity, type SpotifyTrack } from './embed.ts'
import { SEARCH_RESULTS } from './match.ts'
import { createSpotifyDownloads, NO_MATCH, SEARCH_TIMEOUT_MS } from './matcher.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures')
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')
/** The recorded search for the recorded track (test/fixtures/youtube/search.json). */
const SEARCH_JSON = fixture('youtube/search.json')
const TRACK_ENTITY = parseEmbedPage(fixture('spotify/track.html'))
const ALBUM_ENTITY = parseEmbedPage(fixture('spotify/album.html'))

const NODE = '/opt/homebrew/bin/node'
const YTDLP = '/opt/homebrew/bin/yt-dlp'
const JOB_ID = '0b7c1a52-8f0e-4c1e-9d38-2a3a6c1f5e11'

function classified(url: string): ValidUrl {
  const result = classifyUrl(url)
  if (!result.ok) throw new Error(`not a valid URL: ${url}`)
  return result
}

const TRACK_URL = classified('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: SEARCH_JSON,
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 1400,
  ...overrides,
})

function setup({
  entity = TRACK_ENTITY,
  run: runImpl = async () => result(),
}: {
  entity?: SpotifyEntity | Error
  run?: typeof run
} = {}) {
  const client = {
    entity: vi.fn<SpotifyClient['entity']>(async () => {
      if (entity instanceof Error) throw entity
      return entity
    }),
    cover: vi.fn<SpotifyClient['cover']>(async () => new Uint8Array([0xff, 0xd8, 0xff])),
  }
  const runFn = vi.fn<typeof run>(runImpl)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const downloads = createSpotifyDownloads({ client, run: runFn, jsRuntime: NODE, log })
  const signal = new AbortController().signal
  const match = (input: ValidUrl = TRACK_URL) => downloads.match(input, YTDLP, signal, JOB_ID)
  const logged = () =>
    [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')
  return { downloads, client, run: runFn, log, logged, match, signal }
}

const withTrack = (fields: Partial<SpotifyTrack>): SpotifyEntity => {
  if (TRACK_ENTITY.type !== 'track') throw new Error('the fixture is a track')
  return { type: 'track', track: { ...TRACK_ENTITY.track, ...fields } }
}

describe('spotifyDownloads.match', () => {
  it('reads the track from Spotify, searches YouTube for it, and picks the official upload', async () => {
    const { match, client, run, signal } = setup()
    const outcome = await match()
    if (!outcome.ok) throw new Error(`no match: ${outcome.error.code}`)
    expect(outcome.matched).toStrictEqual({
      track: {
        id: '4uLU6hMCjMI75M1A2tKUQC',
        title: 'Never Gonna Give You Up',
        artists: ['Rick Astley'],
        durationSec: 213.573,
        releaseYear: 1987,
        coverUrl:
          'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673',
      },
      match: {
        platform: 'youtube',
        id: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
        uploader: 'Rick Astley',
        durationSec: 214,
      },
      // The only URL the download gets: the matched video, classified.
      input: classified('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      // The next-best two, best first: tried when YouTube refuses the one before.
      alternatives: [
        {
          match: {
            platform: 'youtube',
            id: 'LLFhKaqnWwk',
            url: 'https://www.youtube.com/watch?v=LLFhKaqnWwk',
            title: 'Rick Astley - Never Gonna Give You Up (Official Animated Video)',
            uploader: 'Rick Astley',
            durationSec: 213,
          },
          input: classified('https://www.youtube.com/watch?v=LLFhKaqnWwk'),
        },
        {
          match: {
            platform: 'youtube',
            id: '3BFTio5296w',
            url: 'https://www.youtube.com/watch?v=3BFTio5296w',
            title: 'Never Gonna Give You Up (2022 Remaster)',
            uploader: 'Rick Astley',
            durationSec: 214,
          },
          input: classified('https://www.youtube.com/watch?v=3BFTio5296w'),
        },
      ],
    })
    expect(outcome.matched.input).toMatchObject({ platform: 'youtube', kind: 'youtube_video' })

    expect(client.entity).toHaveBeenCalledExactlyOnceWith(TRACK_URL, signal)
    expect(run).toHaveBeenCalledExactlyOnceWith(
      YTDLP,
      searchArgs({
        query: 'Rick Astley - Never Gonna Give You Up',
        count: SEARCH_RESULTS,
        jsRuntime: NODE,
      }),
      { timeoutMs: SEARCH_TIMEOUT_MS, signal, maxOutputBytes: 4 * 1024 * 1024 },
    )
  })

  it('logs the job id, the rank, the score and the gap, never a name, URL or video id', async () => {
    const { match, log, logged } = setup()
    await match()
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      '[match] 0b7c1a52: result 1 of 10 (score 123, 0.4 s apart)',
    )
    for (const secret of ['Rick', 'Never Gonna', 'dQw4w9WgXcQ', 'http', 'ytsearch']) {
      expect(logged()).not.toContain(secret)
    }
  })

  it('never passes the Spotify URL to yt-dlp, only the search after --', async () => {
    const { match, run } = setup()
    await match()
    const argv = run.mock.calls[0]?.[1] ?? []
    expect(argv.join(' ')).not.toContain('spotify')
    expect(argv.slice(-2)).toEqual(['--', 'ytsearch10:Rick Astley - Never Gonna Give You Up'])
    expect(argv).toContain('--ignore-config')
  })

  it('searches with the names from Spotify, never from the request', async () => {
    const { match, run } = setup({
      entity: withTrack({ title: 'Real Title', artists: ['Real Artist'], durationSec: 214 }),
    })
    await match(classified('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=Fake+Title'))
    expect(run.mock.calls[0]?.[1].at(-1)).toBe('ytsearch10:Real Artist - Real Title')
  })

  it.each([
    'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4',
    'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
  ])('refuses %s: a job is one track', async (url) => {
    const { match, client, run } = setup()
    expect(await match(classified(url))).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'This link is a list: open it to pick tracks.' },
    })
    expect(client.entity).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a track link whose page holds a list', async () => {
    const { match, run } = setup({ entity: ALBUM_ENTITY })
    expect(await match()).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(run).not.toHaveBeenCalled()
  })

  it("passes Spotify's failure on, logging its code and detail", async () => {
    const { match, run, log } = setup({ entity: new SpotifyError(SPOTIFY_NOT_FOUND, 'HTTP 404') })
    expect(await match()).toEqual({ ok: false, error: SPOTIFY_NOT_FOUND })
    expect(run).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[match] 0b7c1a52: Spotify → unavailable (HTTP 404)',
    )
  })

  it("returns Spotify's rate limit as network, so it never pauses YouTube's downloads", async () => {
    const { match, run } = setup({ entity: new SpotifyError(SPOTIFY_RATE_LIMITED, 'HTTP 429') })
    expect(await match()).toEqual({
      ok: false,
      error: { code: 'network', message: SPOTIFY_RATE_LIMITED.message },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("names the attempt's job dir in the search's argv, so the startup sweep finds it", async () => {
    const { downloads, run, signal } = setup()
    const jobDir = `/Users/dj/Library/Application Support/DJ Scraper/jobs/${JOB_ID}`
    await downloads.match(TRACK_URL, YTDLP, signal, JOB_ID, jobDir)
    const argv = run.mock.calls[0]?.[1] ?? []
    expect(argv).toEqual(
      searchArgs({
        query: 'Rick Astley - Never Gonna Give You Up',
        count: SEARCH_RESULTS,
        jsRuntime: NODE,
        jobDir,
      }),
    )
    expect(argv.slice(-4)).toEqual([
      '-P',
      jobDir,
      '--',
      'ytsearch10:Rick Astley - Never Gonna Give You Up',
    ])
  })

  it('offers no alternatives when only one result passes', async () => {
    const only = JSON.stringify({
      _type: 'playlist',
      entries: [
        {
          id: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Rick Astley - Never Gonna Give You Up',
          channel: 'Rick Astley',
          duration: 214,
        },
      ],
    })
    const { match } = setup({ run: async () => result({ stdout: only }) })
    const outcome = await match()
    if (!outcome.ok) throw new Error(`no match: ${outcome.error.code}`)
    expect(outcome.matched).not.toHaveProperty('alternatives')
    expect(outcome.matched.match.id).toBe('dQw4w9WgXcQ')
  })

  it('answers canceled when the read of the page was aborted', async () => {
    const { match } = setup({ entity: new SpotifyError(CANCELED, 'aborted') })
    expect(await match()).toEqual({ ok: false, error: CANCELED })
  })

  it('lets a client bug through as is', async () => {
    const bug = new TypeError('a bug')
    const { match } = setup({ entity: bug })
    await expect(match()).rejects.toBe(bug)
  })

  it.each([
    ['no length', { durationSec: undefined }],
    ['nothing to search for', { title: '\u0007', artists: [] }],
  ])('answers no_match without searching for a track with %s', async (_label, fields) => {
    const { match, run } = setup({ entity: withTrack(fields) })
    expect(await match()).toEqual({ ok: false, error: NO_MATCH })
    expect(run).not.toHaveBeenCalled()
  })

  it('answers no_match when no result passes, logging how many there were', async () => {
    const { match, log, logged } = setup({
      entity: withTrack({ title: 'Patient Zero', artists: ['Taylor Swift'], durationSec: 225.9 }),
    })
    expect(await match()).toEqual({
      ok: false,
      error: {
        code: 'no_match',
        message: "No YouTube upload matches this Spotify track's artist, title and length.",
      },
    })
    expect(log.info).toHaveBeenCalledExactlyOnceWith('[match] 0b7c1a52: none of 10 results matches')
    expect(logged()).not.toContain('Patient')
  })

  it('answers no_match for an empty search', async () => {
    const empty = JSON.stringify({ _type: 'playlist', entries: [] })
    const { match, log } = setup({ run: async () => result({ stdout: empty }) })
    expect(await match()).toEqual({ ok: false, error: NO_MATCH })
    expect(log.info).toHaveBeenCalledWith('[match] 0b7c1a52: none of 0 results matches')
  })

  it("maps a failed search like any yt-dlp call (YouTube's bot check)", async () => {
    const stderr = fixture('errors/youtube-bot-check.log')
    const { match } = setup({ run: async () => result({ exitCode: 1, stdout: '', stderr }) })
    expect(await match()).toMatchObject({ ok: false, error: { code: 'bot_check' } })
  })

  it.each([
    ['timed out', { timedOut: true, exitCode: null }, 'network'],
    ['was aborted', { aborted: true, exitCode: null, signal: 'SIGINT' as const }, 'canceled'],
    ['printed no JSON', { stdout: 'Rick Astley - not json' }, 'unknown'],
  ])('answers the search that %s with %s', async (_label, overrides, code) => {
    const { match, logged } = setup({ run: async () => result(overrides) })
    expect(await match()).toMatchObject({ ok: false, error: { code } })
    expect(logged()).not.toContain('Rick')
  })

  it("answers engine_missing when yt-dlp can't start", async () => {
    const { match } = setup({
      run: async () => {
        throw new SpawnError(YTDLP, Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      },
    })
    expect(await match()).toMatchObject({ ok: false, error: { code: 'engine_missing' } })
  })

  it('lets a bug in the run through as is', async () => {
    const bug = new RangeError('a bug')
    const { match } = setup({
      run: async () => {
        throw bug
      },
    })
    await expect(match()).rejects.toBe(bug)
  })
})

describe('spotifyDownloads.cover', () => {
  it("is the client's cover fetch", async () => {
    const { downloads, client } = setup()
    expect(downloads.cover).toBe(client.cover)
  })
})
