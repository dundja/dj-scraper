import { lstat, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ApiErrorBodySchema,
  type Health,
  type PreviewReady,
  PreviewReadySchema,
  type PreviewRequest,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { prepareDataDir } from '../src/data-dir.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { createTokenBucket } from '../src/pacing/token-bucket.ts'
import { previewId } from '../src/preview/plan.ts'
import { createPreviewStore, type PreviewStore } from '../src/preview/store.ts'
import { type RunningServer, startServer } from '../src/server.ts'
import { UNUSED_DEPS } from '../src/stubs.ts'
import { type FakeYtdlp, type FakeYtdlpKnobs, makeTempDir, writeFakeYtdlp } from './helpers.ts'
import { waitForExit } from './resolve-app.ts'

// POST /api/previews and GET /api/previews/:id end to end (ADR-029): the real app and preview
// store, the fake yt-dlp writing a synthetic stream (byte i is i % 251) for the `preview` rules of
// fixtures/fake-yt-dlp.json.

const health: Health = {
  ok: false,
  checkedAt: '2026-10-28T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

const YOUTUBE: PreviewRequest = {
  platform: 'youtube',
  id: 'jNQXAC9IVRw',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
}
const YOUTUBE_WEBM: PreviewRequest = {
  platform: 'youtube',
  id: 'PREVIEWWEBM',
  url: 'https://www.youtube.com/watch?v=PREVIEWWEBM',
}
const SOUNDCLOUD_MP3: PreviewRequest = {
  platform: 'soundcloud',
  id: '1100000001',
  url: 'https://soundcloud.com/dj-scraper-fake/hls-mp3',
}
const SOUNDCLOUD_GO_PLUS: PreviewRequest = {
  platform: 'soundcloud',
  id: '1100000002',
  url: 'https://soundcloud.com/dj-scraper-fake/go-plus-preview',
}
const YOUTUBE_GEO: PreviewRequest = {
  platform: 'youtube',
  id: 'GEOBLOCKED1',
  url: 'https://www.youtube.com/watch?v=GEOBLOCKED1',
}
const YOUTUBE_RATE_LIMITED: PreviewRequest = {
  platform: 'youtube',
  id: 'RATELIMITED',
  url: 'https://www.youtube.com/watch?v=RATELIMITED',
}

const HEADER_BYTES = 6000
let root = ''
beforeAll(async () => {
  root = await makeTempDir('previews')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

type App = {
  port: number
  fake: FakeYtdlp
  store: PreviewStore
  /** The data dir's `previews/`. */
  dir: string
  logs: string[]
  post: (body: unknown) => Promise<Response>
  get: (route: string, headers?: Record<string, string>) => Promise<Response>
  /** The fake's yt-dlp runs (not --version), in order. */
  fetches: () => Promise<{ argv: string[]; url: string | null; pid: number; time: number }[]>
}

const servers: RunningServer[] = []
const stores: PreviewStore[] = []
let count = 0

async function start(
  options: {
    env?: FakeYtdlpKnobs
    soundcloudBudget?: ReturnType<typeof createTokenBucket>
    limits?: { maxFiles: number; maxBytes: number }
    concurrency?: number
    engine?: { YTDLP_PATH: string }
  } = {},
): Promise<App> {
  const base = path.join(root, `app-${++count}`)
  const fake = await writeFakeYtdlp(path.join(base, 'bin'), {
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const dataDir = await prepareDataDir(path.join(base, 'data'))
  const logs: string[] = []
  const write = (...data: unknown[]) => {
    logs.push(data.map(String).join(' '))
  }
  const store = createPreviewStore({
    engine: options.engine ?? { YTDLP_PATH: fake.path },
    dataDirReal: dataDir,
    log: { info: write, warn: write, error: write },
    ...(options.soundcloudBudget === undefined
      ? {}
      : { soundcloudBudget: options.soundcloudBudget }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  })
  stores.push(store)
  const server = await startServer(0, (port) =>
    createApp({
      port,
      health: { current: async () => health, recheck: async () => health },
      ...UNUSED_DEPS,
      previews: store,
    }),
  )
  servers.push(server)
  const origin = `http://127.0.0.1:${server.port}`
  return {
    port: server.port,
    fake,
    store,
    dir: path.join(dataDir, 'previews'),
    logs,
    post: (body) =>
      fetch(`${origin}/api/previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    get: (route, headers = {}) => fetch(`${origin}${route}`, { headers }),
    fetches: async () => (await fake.calls()).filter((call) => call.url !== null),
  }
}

afterEach(async () => {
  killActiveGroups()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function ready(app: App, request: PreviewRequest): Promise<PreviewReady> {
  const res = await app.post(request)
  const json: unknown = await res.json()
  expect(res.status, JSON.stringify(json)).toBe(200)
  return PreviewReadySchema.parse(json)
}

async function failure(app: App, request: unknown) {
  const res = await app.post(request)
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

/** The fake stream's body after the FAKEAUDIO header: byte i is i % 251. */
const patternAt = (i: number) => i % 251

describe('POST /api/previews', () => {
  it('fetches the stream as it is and answers a same-origin src', async () => {
    const app = await start()
    const answer = await ready(app, YOUTUBE)
    const id = previewId('youtube', 'jNQXAC9IVRw')
    expect(answer).toEqual({
      id,
      src: `/api/previews/${id}`,
      mime: 'audio/mp4',
      sizeBytes: expect.any(Number),
    })
    // The file is the fake's stream, untouched, in the cache dir under its id.
    const file = await readFile(path.join(app.dir, `${id}.m4a`))
    expect(file.length).toBe(answer.sizeBytes)
    expect(file.subarray(-HEADER_BYTES).every((byte, i) => byte === patternAt(i))).toBe(true)
    // Its temp dir is gone: only the cache file is left.
    expect(await readdir(app.dir)).toEqual([`${id}.m4a`])
  })

  it('runs yt-dlp once, with the preview argv: URL after --, -P inside previews/, no -x', async () => {
    const app = await start()
    await ready(app, YOUTUBE)
    const calls = await app.fetches()
    expect(calls).toHaveLength(1)
    const argv: string[] = calls[0]?.argv ?? []
    expect(argv.slice(-2)).toEqual(['--', YOUTUBE.url])
    expect(argv).toContain('--ignore-config')
    expect(argv).not.toContain('-x')
    const temp = argv[argv.indexOf('-P') + 1] ?? ''
    expect(path.dirname(temp)).toBe(app.dir)
    expect(path.basename(temp)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('serves a cached file at once, spawning nothing, and touches it', async () => {
    const app = await start()
    const first = await ready(app, YOUTUBE)
    const file = path.join(app.dir, `${first.id}.m4a`)
    const old = new Date(Date.now() - 3_600_000)
    await utimes(file, old, old)
    const second = await ready(app, YOUTUBE)
    expect(second).toEqual(first)
    expect(await app.fetches()).toHaveLength(1)
    expect((await lstat(file)).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('names the mime by the stream: MP3 as audio/mpeg, WebM as audio/webm', async () => {
    const app = await start()
    expect((await ready(app, SOUNDCLOUD_MP3)).mime).toBe('audio/mpeg')
    expect((await ready(app, YOUTUBE_WEBM)).mime).toBe('audio/webm')
  })

  it('shares one fetch between concurrent requests for the same upload (single flight)', async () => {
    const app = await start({ env: { FAKE_YTDLP_DELAY_MS: '300' } })
    const answers = await Promise.all([
      ready(app, YOUTUBE),
      ready(app, YOUTUBE),
      ready(app, YOUTUBE),
    ])
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(1)
    expect(await app.fetches()).toHaveLength(1)
  })

  it('keeps fetching while one waiter is left, and stops yt-dlp when none is', async () => {
    const app = await start({ env: { FAKE_YTDLP_HANG: '1' } })
    const url = `http://127.0.0.1:${app.port}/api/previews`
    const post = (signal: AbortSignal) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(YOUTUBE),
        signal,
      }).catch(() => undefined)
    const first = new AbortController()
    const second = new AbortController()
    const requests = [post(first.signal), post(second.signal)]
    const [call] = await app.fake.waitForCalls(1)
    const pid = call?.pid ?? 0
    // One waiter leaves: the other still waits, so yt-dlp runs on.
    first.abort()
    await delay(150)
    expect(() => process.kill(pid, 0)).not.toThrow()
    // The last one leaves: yt-dlp is stopped, and nothing is cached.
    second.abort()
    await Promise.all(requests)
    await waitForExit(pid)
    await delay(50)
    expect(await readdir(app.dir)).toEqual([])
    expect(await app.fetches()).toHaveLength(1)
  })

  it('runs at most 2 fetches at a time', async () => {
    const app = await start({ env: { FAKE_YTDLP_DELAY_MS: '400' } })
    const all = Promise.all([
      ready(app, YOUTUBE),
      ready(app, YOUTUBE_WEBM),
      ready(app, SOUNDCLOUD_MP3),
    ])
    await app.fake.waitForCalls(2)
    await delay(150)
    expect(await app.fetches()).toHaveLength(2)
    await all
    expect(await app.fetches()).toHaveLength(3)
  })

  it('takes a SoundCloud token from the shared bucket, and none for YouTube', async () => {
    const bucket = createTokenBucket({ burst: 1, refillMs: 600_000 })
    const app = await start({ soundcloudBudget: bucket })
    await ready(app, YOUTUBE)
    expect(bucket.waitMs(performance.now())).toBeLessThanOrEqual(0)
    await ready(app, SOUNDCLOUD_MP3)
    expect(bucket.waitMs(performance.now())).toBeGreaterThan(0)
  })

  it('waits for a SoundCloud token when the bucket is empty, and leaves when asked to', async () => {
    const bucket = createTokenBucket({ burst: 1, refillMs: 600_000 })
    bucket.take(performance.now())
    const app = await start({ soundcloudBudget: bucket })
    const controller = new AbortController()
    const waiting = fetch(`http://127.0.0.1:${app.port}/api/previews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SOUNDCLOUD_MP3),
      signal: controller.signal,
    }).catch(() => undefined)
    await delay(200)
    expect(await app.fetches()).toHaveLength(0)
    controller.abort()
    await waiting
    expect(await app.fetches()).toHaveLength(0)
  })

  it('answers a SoundCloud Go+ preview (exit 101, silent) with 422 preview_only, caching nothing', async () => {
    const app = await start()
    expect(await failure(app, SOUNDCLOUD_GO_PLUS)).toMatchObject({
      status: 422,
      code: 'preview_only',
    })
    expect(await readdir(app.dir)).toEqual([])
    expect(app.logs.join('\n')).toMatch(/failed \(preview_only\)/)
  })

  it('maps yt-dlp failures through the shared error table', async () => {
    const app = await start()
    expect(await failure(app, YOUTUBE_GEO)).toMatchObject({ status: 422, code: 'geo_blocked' })
    expect(await failure(app, YOUTUBE_RATE_LIMITED)).toMatchObject({
      status: 429,
      code: 'rate_limited',
    })
    expect(await readdir(app.dir)).toEqual([])
  })

  it('does not cache a failure: the next request fetches again', async () => {
    const app = await start()
    await failure(app, YOUTUBE_GEO)
    await failure(app, YOUTUBE_GEO)
    expect(await app.fetches()).toHaveLength(2)
  })

  it('answers 503 engine_missing when yt-dlp is not there', async () => {
    const app = await start({ engine: { YTDLP_PATH: path.join(root, 'no-such-yt-dlp') } })
    expect(await failure(app, YOUTUBE)).toMatchObject({ status: 503, code: 'engine_missing' })
  })

  describe('what is refused before yt-dlp runs', () => {
    it('answers 422 when the link is not on the platform the request names', async () => {
      const app = await start()
      expect(await failure(app, { ...YOUTUBE, platform: 'soundcloud' })).toMatchObject({
        status: 422,
        code: 'unsupported_url',
      })
      expect(await failure(app, { ...SOUNDCLOUD_MP3, platform: 'youtube' })).toMatchObject({
        status: 422,
        code: 'unsupported_url',
      })
      expect(await app.fetches()).toHaveLength(0)
    })

    it('never fetches from Spotify, another site or a DRM service', async () => {
      const app = await start()
      for (const [platform, url] of [
        ['youtube', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
        ['soundcloud', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
        ['youtube', 'https://vimeo.com/123456'],
        ['youtube', 'https://tidal.com/browse/track/123'],
        ['youtube', 'https://music.apple.com/us/album/x/1'],
      ] as const) {
        const error = await failure(app, { platform, id: 'abcdefghijk', url })
        expect(error.status, url).toBe(422)
        expect(error.code, url).toBe('unsupported_url')
      }
      // Spotify is not even a platform a request can name.
      expect(await failure(app, { ...YOUTUBE, platform: 'spotify' })).toMatchObject({
        status: 400,
        code: 'invalid_request',
      })
      expect(await app.fetches()).toHaveLength(0)
    })

    it("refuses a list, a bad link and an id that is not the link's", async () => {
      const app = await start()
      const list = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'
      expect(await failure(app, { ...YOUTUBE, url: list })).toMatchObject({
        status: 422,
        code: 'unsupported_url',
      })
      const set = 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep'
      expect(await failure(app, { ...SOUNDCLOUD_MP3, url: set })).toMatchObject({
        status: 422,
        code: 'unsupported_url',
      })
      expect(await failure(app, { ...YOUTUBE, url: 'ftp://x.test/a' })).toMatchObject({
        status: 400,
      })
      expect(await failure(app, { ...YOUTUBE, id: 'someoneelse1' })).toMatchObject({
        status: 400,
        code: 'invalid_request',
      })
      expect(await app.fetches()).toHaveLength(0)
    })
  })
})

describe('GET /api/previews/:id', () => {
  /** Prepares YOUTUBE and returns the file's size and its bytes. */
  async function prepared(app: App) {
    const answer = await ready(app, YOUTUBE)
    const body = await readFile(path.join(app.dir, `${answer.id}.m4a`))
    return { answer, body }
  }

  it('serves the whole file, as the src says', async () => {
    const app = await start()
    const { answer, body } = await prepared(app)
    const res = await app.get(answer.src)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-length')).toBe(String(body.length))
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body)
  })

  it('serves ranges: 206 with a-b, a- and -n; 416 past the end', async () => {
    const app = await start()
    const { answer, body } = await prepared(app)
    const size = body.length
    const range = (value: string) => app.get(answer.src, { range: value })

    const partial = await range('bytes=10-49')
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 10-49/${size}`)
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(body.subarray(10, 50))

    const open = await range(`bytes=${size - 20}-`)
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe(`bytes ${size - 20}-${size - 1}/${size}`)
    expect(Buffer.from(await open.arrayBuffer())).toEqual(body.subarray(size - 20))

    const suffix = await range('bytes=-7')
    expect(suffix.status).toBe(206)
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(body.subarray(size - 7))

    const past = await range(`bytes=${size}-`)
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${size}`)
  })

  it('answers 404 for an id with no file and for a malformed id', async () => {
    const app = await start()
    for (const id of [previewId('youtube', 'nothing-here'), 'nope', `${'a'.repeat(32)}.m4a`]) {
      const res = await app.get(`/api/previews/${id}`)
      expect(res.status, id).toBe(404)
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('not_found')
    }
  })

  it('never follows a symlink planted in the cache dir', async () => {
    const app = await start()
    const secret = path.join(root, 'secret.m4a')
    await writeFile(secret, 'not for the player')
    const id = previewId('youtube', 'planted')
    await symlink(secret, path.join(app.dir, `${id}.m4a`))
    const res = await app.get(`/api/previews/${id}`)
    expect(res.status).toBe(404)
  })

  it('refuses a cross-site request with 403, and serves a same-origin <audio> one', async () => {
    const app = await start()
    const { answer } = await prepared(app)
    const cross = await app.get(answer.src, {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-dest': 'audio',
    })
    expect(cross.status).toBe(403)
    const same = await app.get(answer.src, {
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'audio',
    })
    expect(same.status).toBe(200)
  })
})

describe('the cache', () => {
  it('evicts the least recently used file past its file limit', async () => {
    const app = await start({ limits: { maxFiles: 2, maxBytes: 1e9 } })
    const first = await ready(app, YOUTUBE)
    await delay(20)
    const second = await ready(app, YOUTUBE_WEBM)
    await delay(20)
    // Using the first again makes the second the least recently used.
    await ready(app, YOUTUBE)
    await delay(20)
    const third = await ready(app, SOUNDCLOUD_MP3)
    expect((await readdir(app.dir)).sort()).toEqual([`${first.id}.m4a`, `${third.id}.mp3`].sort())
    expect((await app.get(second.src)).status).toBe(404)
    expect((await app.get(first.src)).status).toBe(200)
  })

  it('evicts past its byte limit but keeps the file just made', async () => {
    const app = await start({ limits: { maxFiles: 20, maxBytes: 1 } })
    await ready(app, YOUTUBE)
    const second = await ready(app, YOUTUBE_WEBM)
    expect(await readdir(app.dir)).toEqual([`${second.id}.webm`])
  })

  it('empties the cache and refuses new requests once closed', async () => {
    const app = await start()
    await ready(app, YOUTUBE)
    await app.store.close()
    expect(await readdir(app.dir)).toEqual([])
    expect(await failure(app, YOUTUBE)).toMatchObject({ status: 503, code: 'canceled' })
  })

  it('stops a fetch in progress when closed', async () => {
    const app = await start({ env: { FAKE_YTDLP_HANG: '1' } })
    const pending = app.post(YOUTUBE)
    const [call] = await app.fake.waitForCalls(1)
    await app.store.close()
    await waitForExit(call?.pid ?? 0)
    expect((await pending).status).toBe(409)
    expect(await readdir(app.dir)).toEqual([])
  })

  it('logs ids, platforms, codes and sizes, never a URL or a path', async () => {
    const app = await start()
    await ready(app, SOUNDCLOUD_MP3)
    await failure(app, YOUTUBE_GEO)
    const text = app.logs.join('\n')
    expect(text).toMatch(/\[previews\] [0-9a-f]{8} soundcloud mp3/)
    expect(text).toMatch(/youtube: failed \(geo_blocked\)/)
    expect(text).not.toMatch(/https?:|soundcloud\.com|GEOBLOCKED1|\/previews\//)
  })
})
