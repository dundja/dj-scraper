import { rm } from 'node:fs/promises'
import {
  ApiErrorBodySchema,
  type RemixRequest,
  type RemixSuggestions,
  RemixSuggestionsSchema,
  ResolveResultSchema,
  type Track,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { searchArgs } from '../src/engine/ytdlp-args.ts'
import { makeTempDir, startSpotifyFixtures } from './helpers.ts'
import {
  jsonBody,
  type ResolveApp,
  startResolveApp,
  stopResolveApps,
  waitForExit,
  waitForLog,
} from './resolve-app.ts'

// POST /api/remixes end to end (ADR-027): the real app and remix finder, the fake yt-dlp
// answering the recorded searches (fixtures/youtube and soundcloud/search-remixes-*.json).

/** The YouTube mix whose seed video the e2e specs paste ("This track": Rick Astley). */
const MIX = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'
/** The recorded Spotify track: the same song, so the same searches. */
const SPOTIFY_TRACK = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'

const PORCELAIN: RemixRequest = { title: 'Porcelain', artist: 'Moby' }

let root = ''
beforeAll(async () => {
  root = await makeTempDir('remixes')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(stopResolveApps)

const start = (options?: Parameters<typeof startResolveApp>[1]) => startResolveApp(root, options)

/** POST /api/remixes that must succeed; the body must match the contract. */
async function remixesOk(app: ResolveApp, body: RemixRequest): Promise<RemixSuggestions> {
  const res = await app.post('/api/remixes', body)
  const json = await jsonBody(res)
  expect(res.status, JSON.stringify(json)).toBe(200)
  return RemixSuggestionsSchema.parse(json)
}

/** What the web sends for a pasted track (apps/web remix-request.ts). */
const requestFor = (track: Track): RemixRequest => ({
  title: track.title,
  ...(track.artist === undefined ? {} : { artist: track.artist }),
  ...(track.uploader === undefined ? {} : { uploader: track.uploader }),
  exclude: { platform: track.platform, id: track.id },
})

/** The search each yt-dlp call ran (the text after `--`), in the order they started. */
const searches = async (app: ResolveApp) => (await app.lookups()).map((call) => call.url)
/**
 * The same, sorted: a request's two searches start together, so the fake may log either first.
 * `scsearch…` sorts before `ytsearch…`.
 */
const sortedSearches = async (app: ResolveApp) => (await searches(app)).toSorted()

const search = (site: 'youtube' | 'soundcloud', query: string) =>
  searchArgs({ query, count: 30, jsRuntime: process.execPath, site })

describe('POST /api/remixes on the fake yt-dlp', () => {
  it('suggests the recorded remixes of Porcelain from both platforms', async () => {
    const app = await start()
    const answer = await remixesOk(app, PORCELAIN)

    expect(answer.song).toEqual({ title: 'Porcelain', artist: 'Moby' })
    expect(answer.searches).toEqual({
      youtube: { status: 'ok', found: 22 },
      soundcloud: { status: 'ok', found: 27 },
    })
    expect(answer.suggestions).toHaveLength(20)
    expect(answer.suggestions[0]).toMatchObject({ kind: 'remix', remixer: 'Arty', plays: 908188 })
    expect(answer.suggestions[0]?.uploads.map((upload) => upload.platform)).toEqual([
      'youtube',
      'youtube',
      'soundcloud',
      'soundcloud',
    ])
    expect(
      answer.suggestions.find((suggestion) => suggestion.remixer === 'Pola & Bryson')?.genre,
    ).toEqual({ name: 'Drum & Bass', source: 'platform' })

    // Exactly the argv searchArgs builds, one search per platform (started together).
    const calls = await app.lookups()
    expect(
      calls.map((call) => call.argv).toSorted((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([
      search('soundcloud', 'Moby Porcelain remix'),
      search('youtube', 'Moby Porcelain remix'),
    ])
    // The log line counts; it names no song, query or URL.
    const line = await waitForLog(app.logs, /^\[remixes\] /)
    expect(line).toMatch(/^\[remixes\] youtube 22, soundcloud 27 → 20 in \d+\.\d s$/)
    for (const name of ['Porcelain', 'Moby', 'youtube.com', 'soundcloud.com']) {
      expect(app.logs.join('\n')).not.toContain(name)
    }
  })

  it('searches YouTube once for the web’s YouTube-first request and its full one', async () => {
    const app = await start()
    const youtubeFirst = await remixesOk(app, { ...PORCELAIN, platforms: ['youtube'] })
    expect(youtubeFirst.searches).toEqual({
      youtube: { status: 'ok', found: 22 },
      soundcloud: { status: 'skipped' },
    })
    const both = await remixesOk(app, PORCELAIN)
    expect(both.searches.soundcloud).toEqual({ status: 'ok', found: 27 })
    expect(await searches(app)).toEqual([
      'ytsearch30:Moby Porcelain remix',
      'scsearch30:Moby Porcelain remix',
    ])
    // A paste of the same song (here, one of its remixes) searches nothing.
    await remixesOk(app, { title: 'Porcelain (Arty Remix)', artist: 'Moby' })
    expect(await searches(app)).toHaveLength(2)
  })

  it("suggests remixes for the e2e specs' track: the YouTube mix's seed video", async () => {
    const app = await start()
    const res = await app.post('/api/resolve', { url: MIX, mode: 'track' })
    const resolved = ResolveResultSchema.parse(await jsonBody(res))
    if (resolved.kind !== 'track') throw new Error(`expected a track, got ${resolved.kind}`)
    expect(resolved.track).toMatchObject({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up (Official Video) (4K Remaster)',
      artist: 'Rick Astley',
    })

    const answer = await remixesOk(app, requestFor(resolved.track))
    expect(answer.song).toEqual({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' })
    expect(answer.searches).toEqual({
      youtube: { status: 'ok', found: 15 },
      soundcloud: { status: 'ok', found: 25 },
    })
    expect(answer.suggestions[0]).toMatchObject({ remixer: 'Krysiek', plays: 578820 })
    expect((await searches(app))[0]).toBe(MIX)
    expect((await searches(app)).slice(1).toSorted()).toEqual([
      'scsearch30:Rick Astley Never Gonna Give You Up remix',
      'ytsearch30:Rick Astley Never Gonna Give You Up remix',
    ])
  })

  it('searches the same song for the recorded Spotify track', async () => {
    const spotify = await startSpotifyFixtures()
    try {
      const app = await start({ spotifyOrigin: spotify.origin })
      const resolved = ResolveResultSchema.parse(
        await jsonBody(await app.post('/api/resolve', { url: SPOTIFY_TRACK })),
      )
      if (resolved.kind !== 'track') throw new Error(`expected a track, got ${resolved.kind}`)
      const answer = await remixesOk(app, requestFor(resolved.track))
      expect(answer.song).toEqual({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' })
      expect(answer.suggestions[0]).toMatchObject({ remixer: 'Krysiek' })
      expect(await sortedSearches(app)).toEqual([
        'scsearch30:Rick Astley Never Gonna Give You Up remix',
        'ytsearch30:Rick Astley Never Gonna Give You Up remix',
      ])
    } finally {
      await spotify.close()
    }
  })

  it("answers 200 with each platform's error when its search fails", async () => {
    // The fake has no recording of this song's searches: it exits 2 for both.
    const app = await start()
    const answer = await remixesOk(app, { title: 'Nothing Recorded', artist: 'Nobody' })
    expect(answer.suggestions).toEqual([])
    expect(answer.searches).toEqual({
      youtube: { status: 'error', error: expect.objectContaining({ code: 'unknown' }) },
      soundcloud: { status: 'error', error: expect.objectContaining({ code: 'unknown' }) },
    })
  })

  it('answers 400 invalid_request for a title with no words, running nothing', async () => {
    const app = await start()
    const res = await app.post('/api/remixes', { title: '(Official Video)', artist: 'Moby' })
    expect(res.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await jsonBody(res)).error.code).toBe('invalid_request')
    expect(await app.lookups()).toEqual([])
  })

  it('answers 503 engine_missing when yt-dlp is not there', async () => {
    const app = await start({ engine: { YTDLP_PATH: `${root}/no-such-yt-dlp` } })
    const res = await app.post('/api/remixes', PORCELAIN)
    expect(res.status).toBe(503)
    expect(ApiErrorBodySchema.parse(await jsonBody(res)).error.code).toBe('engine_missing')
  })
})

describe('POST /api/remixes: a client that goes away', () => {
  it('stops the yt-dlp searching for it', async () => {
    const app = await start({ env: { FAKE_YTDLP_HANG: '1' } })
    const controller = new AbortController()
    const request = app.post(
      '/api/remixes',
      { ...PORCELAIN, platforms: ['youtube'] },
      { signal: controller.signal },
    )
    const [call] = await app.fake.waitForCalls(1)
    expect(call?.url).toBe('ytsearch30:Moby Porcelain remix')
    controller.abort()
    await expect(request).rejects.toThrow()
    await waitForExit(call?.pid ?? 0)
  })
})
