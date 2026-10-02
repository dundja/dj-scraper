import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  type EntryRef,
  type EntryResult,
  MAX_ENTRIES_PER_REQUEST,
  MAX_ID_LENGTH,
  ResolveEntriesResponseSchema,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeTempDir } from './helpers.ts'
import {
  jsonBody,
  type ResolveApp,
  startResolveApp,
  stopResolveApps,
  waitForExit,
  waitForLog,
} from './resolve-app.ts'

// POST /api/resolve/entries end to end: the real app and enricher filling partial rows through the
// fake yt-dlp, which replays recorded fixtures. Offline.

/** Row 6 of soundcloud/set.json, listed by its API URL; served from soundcloud/entry.json. */
const ENTRY: EntryRef = {
  platform: 'soundcloud',
  id: '47127631',
  url: 'https://api-v2.soundcloud.com/tracks/47127631',
}
/** Row 1 of the same set: a Go+ track that only has its 30 s preview for us. */
const PREVIEW: EntryRef = {
  platform: 'soundcloud',
  id: '75206121',
  url: 'https://soundcloud.com/the-concept-band/world-on-fire-1',
}
const MISSING: EntryRef = {
  platform: 'soundcloud',
  id: '404404',
  url: 'https://soundcloud.com/ethmusic/this-track-does-not-exist-dj-scraper',
}
const RATE_LIMITED: EntryRef = {
  platform: 'soundcloud',
  id: '429429',
  url: 'https://soundcloud.com/dj-scraper-fake/rate-limited-info',
}
const VIDEO: EntryRef = {
  platform: 'youtube',
  id: 'jNQXAC9IVRw',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
}
const DRM: EntryRef = {
  platform: 'other',
  id: '4uLU6hMCjMI75M1A2tKUQC',
  url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
}
const SET: EntryRef = {
  platform: 'soundcloud',
  id: '2284613',
  url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
}

let root = ''
beforeAll(async () => {
  root = await makeTempDir('entries')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(stopResolveApps)

const start = (options?: Parameters<typeof startResolveApp>[1]) => startResolveApp(root, options)

async function enrich(app: ResolveApp, entries: EntryRef[], init?: RequestInit) {
  const res = await app.post('/api/resolve/entries', { entries }, init)
  const body = await jsonBody(res)
  expect(res.status, JSON.stringify(body)).toBe(200)
  return ResolveEntriesResponseSchema.parse(body).results
}

async function enrichError(app: ResolveApp, body: unknown) {
  const res = await app.post('/api/resolve/entries', body)
  const { error } = ApiErrorBodySchema.parse(await jsonBody(res))
  return { status: res.status, ...error }
}

/** `platform:id → ok | error code`, in response order. */
const outcomes = (results: readonly EntryResult[]) =>
  results.map(
    (result) =>
      `${result.platform}:${result.id} → ${result.status === 'ok' ? 'ok' : result.error.code}`,
  )

/** The URLs yt-dlp was asked for, sorted. */
const urlsOf = (calls: readonly { url: string | null }[]) =>
  calls.map((call) => call.url ?? '').sort()

function trackOf(results: readonly EntryResult[], id: string) {
  const result = results.find((entry) => entry.id === id)
  if (result?.status !== 'ok') throw new Error(`expected a track for ${id}`)
  return result.track
}

describe('POST /api/resolve/entries', () => {
  it('fills each row with a full Track and fails bad rows on their own, in request order', async () => {
    const app = await start()
    const results = await enrich(app, [ENTRY, PREVIEW, MISSING, VIDEO, DRM, SET])
    expect(outcomes(results)).toEqual([
      'soundcloud:47127631 → ok',
      'soundcloud:75206121 → ok',
      'soundcloud:404404 → unavailable',
      'youtube:jNQXAC9IVRw → ok',
      'other:4uLU6hMCjMI75M1A2tKUQC → unsupported_url',
      'soundcloud:2284613 → invalid_request',
    ])
    expect(trackOf(results, ENTRY.id)).toMatchObject({
      id: '47127631',
      platform: 'soundcloud',
      // The page URL replaces the API URL the listing had.
      url: 'https://soundcloud.com/the-concept-band/knocked-up-mastered',
      title: 'Knocked Up',
      uploader: 'The Royal Concept',
      availability: 'available',
      source: { codec: 'mp4a.40.2', bitrateKbps: 160 },
    })
    expect(trackOf(results, PREVIEW.id)).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'preview_only',
    })
    expect(trackOf(results, VIDEO.id).title).toBe('Me at the zoo')

    // A DRM service and a whole set never reach yt-dlp. Platforms are paced apart, so only the
    // set of lookups is fixed, not their order across platforms.
    const lookups = await app.lookups()
    expect(urlsOf(lookups)).toEqual([ENTRY.url, PREVIEW.url, MISSING.url, VIDEO.url].sort())
    for (const { argv } of lookups) {
      expect(argv).toEqual(expect.arrayContaining(['-J', '--flat-playlist', '--no-playlist']))
    }
  })

  it('answers a repeated platform + id once, from one lookup', async () => {
    const app = await start()
    const samePage = {
      ...ENTRY,
      url: 'https://soundcloud.com/the-concept-band/knocked-up-mastered',
    }
    const results = await enrich(app, [ENTRY, samePage, ENTRY])
    expect(outcomes(results)).toEqual(['soundcloud:47127631 → ok'])
    expect((await app.lookups()).map((call) => call.url)).toEqual([ENTRY.url])
  })

  it('passes yt-dlp the normalized URL of a row, not the one the request sent', async () => {
    const app = await start()
    const shouting = { ...ENTRY, url: 'https://API-V2.SoundCloud.COM/tracks/47127631' }
    expect(outcomes(await enrich(app, [shouting]))).toEqual(['soundcloud:47127631 → ok'])
    expect((await app.lookups()).map((call) => call.url)).toEqual([ENTRY.url])
  })

  it('answers rows it filled before from its cache, without starting yt-dlp', async () => {
    const app = await start()
    const first = await enrich(app, [ENTRY, VIDEO])
    expect(await app.lookups()).toHaveLength(2)
    const second = await enrich(app, [VIDEO, ENTRY])
    expect(outcomes(second)).toEqual(['youtube:jNQXAC9IVRw → ok', 'soundcloud:47127631 → ok'])
    expect(trackOf(second, ENTRY.id)).toEqual(trackOf(first, ENTRY.id))
    expect(await app.lookups()).toHaveLength(2)
  })

  it('pauses a rate-limited platform: its other rows fail at once, other platforms go on', async () => {
    const app = await start()
    const results = await enrich(app, [RATE_LIMITED, ENTRY, VIDEO])
    expect(outcomes(results)).toEqual([
      'soundcloud:429429 → rate_limited',
      'soundcloud:47127631 → rate_limited',
      'youtube:jNQXAC9IVRw → ok',
    ])
    const waiting = results[1]
    expect(waiting?.status === 'error' && waiting.error.message).toMatch(
      /^SoundCloud is limiting requests\. Try again in 1 minute\.$/,
    )
    expect(urlsOf(await app.lookups())).toEqual([RATE_LIMITED.url, VIDEO.url].sort())

    // A later request for the platform fails fast too, without spawning.
    const later = await enrich(app, [PREVIEW])
    expect(outcomes(later)).toEqual(['soundcloud:75206121 → rate_limited'])
    expect(await app.lookups()).toHaveLength(2)
  })

  it('logs counts and codes only, never a URL or a title', async () => {
    const app = await start()
    await enrich(app, [ENTRY, MISSING, VIDEO])
    expect(app.logs).toEqual([
      expect.stringMatching(/^\[resolve\/entries\] 3 rows → 2 ok, 1 failed \(unavailable 1\) in /),
    ])
  })

  it('stops the yt-dlp lookups of a client that goes away', async () => {
    const app = await start({ env: { FAKE_YTDLP_HANG: '1' } })
    const controller = new AbortController()
    const request = app.post(
      '/api/resolve/entries',
      { entries: [ENTRY] },
      { signal: controller.signal },
    )
    const [call] = await app.fake.waitForCalls(1)
    controller.abort()
    await expect(request).rejects.toThrow()
    await waitForExit(call?.pid ?? 0)
    await waitForLog(app.logs, /^\[resolve\/entries\] 1 row → canceled/)
  })

  it('fails the whole request with 503 engine_missing when YTDLP_PATH points at nothing', async () => {
    const app = await start({ engine: { YTDLP_PATH: path.join(root, 'no-such-dir', 'yt-dlp') } })
    expect(await enrichError(app, { entries: [ENTRY, VIDEO] })).toMatchObject({
      status: 503,
      code: 'engine_missing',
    })
  })

  it.each([
    ['no rows', { entries: [] }, /^entries: /],
    [
      'more rows than a screenful',
      {
        entries: Array.from({ length: MAX_ENTRIES_PER_REQUEST + 1 }, (_, i) => ({
          ...ENTRY,
          id: String(i),
        })),
      },
      /^entries: /,
    ],
    [
      'a row without an http(s) URL',
      { entries: [{ ...ENTRY, url: 'javascript:alert(1)' }] },
      /^entries\[0\]\.url: /,
    ],
    [
      'a row of an unknown platform',
      { entries: [{ ...ENTRY, platform: 'spotify' }] },
      /^entries\[0\]\.platform: /,
    ],
    ['a row without an id', { entries: [{ ...ENTRY, id: '' }] }, /^entries\[0\]\.id: /],
    [
      'a row with an id over MAX_ID_LENGTH',
      { entries: [{ ...ENTRY, id: '1'.repeat(MAX_ID_LENGTH + 1) }] },
      /^entries\[0\]\.id: /,
    ],
    ['urls instead of entries', { urls: [ENTRY.url] }, /^entries: /],
  ])('answers 400 invalid_request for %s', async (_label, body, message) => {
    const app = await start()
    const error = await enrichError(app, body)
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(error.message).toMatch(message)
    expect(await app.lookups()).toEqual([])
  })

  it('answers 415 for a body that is not declared as JSON', async () => {
    const app = await start()
    const res = await app.send('/api/resolve/entries', {
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ entries: [ENTRY] }),
    })
    const { error } = ApiErrorBodySchema.parse(await jsonBody(res))
    expect({ status: res.status, code: error.code }).toEqual({
      status: 415,
      code: 'invalid_request',
    })
  })
})
