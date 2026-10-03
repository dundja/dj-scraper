import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  type EntryRef,
  type ErrorCode,
  type Health,
  MAX_ENTRIES_PER_REQUEST,
  type ResolveEntriesResponse,
  ResolveEntriesResponseSchema,
  type ResolveResult,
  ResolveResultSchema,
} from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { ApiError, ERROR_STATUS } from '../http/errors.ts'
import type { Enricher } from '../resolve/enricher.ts'
import type { Resolver } from '../resolve/resolver.ts'
import { UNUSED_DOWNLOAD_DEPS } from '../stubs.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

const RESOLVED: ResolveResult = {
  kind: 'track',
  track: {
    id: 'jNQXAC9IVRw',
    platform: 'youtube',
    url: VIDEO_URL,
    title: 'Me at the zoo',
    availability: 'available',
  },
}

const ENTRY: EntryRef = {
  platform: 'soundcloud',
  id: '1001',
  url: 'https://api.soundcloud.com/tracks/1001',
}

const ENRICHED: ResolveEntriesResponse = {
  results: [
    {
      status: 'error',
      platform: 'soundcloud',
      id: '1001',
      error: { code: 'unavailable', message: 'Track removed.' },
    },
  ],
}

function setup({
  resolve = async () => RESOLVED,
  enrich = async () => ENRICHED,
  webRoot,
}: {
  resolve?: Resolver['resolve']
  enrich?: Enricher['enrich']
  /** A built UI to serve, as in production (pnpm start). Default none, as with --dev. */
  webRoot?: string
} = {}) {
  const resolver = { resolve: vi.fn<Resolver['resolve']>(resolve) }
  const enricher = { enrich: vi.fn<Enricher['enrich']>(enrich), peek: () => undefined }
  const stubHealth = { current: async () => health, recheck: async () => health }
  const app = createApp({
    port: PORT,
    health: stubHealth,
    resolver,
    enricher,
    webRoot,
    ...UNUSED_DOWNLOAD_DEPS,
  })
  return { app, resolver, enricher }
}

/** app.request sends no Host, so add ours (absolute URL, since the guard checks the URL too). */
const send = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}${path}`, { ...init, headers }))
}

const postJson = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

async function errorOf(res: Response) {
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

describe('POST /api/resolve', () => {
  it('resolves the URL with mode auto by default and returns the result', async () => {
    const { app, resolver } = setup()
    const res = await send(app, '/api/resolve', postJson({ url: VIDEO_URL }))
    expect(res.status).toBe(200)
    expect(ResolveResultSchema.parse(await res.json())).toStrictEqual(RESOLVED)
    expect(resolver.resolve).toHaveBeenCalledWith(
      { url: VIDEO_URL, mode: 'auto' },
      expect.any(AbortSignal),
    )
  })

  it('passes the requested mode on', async () => {
    const { app, resolver } = setup()
    await send(app, '/api/resolve', postJson({ url: VIDEO_URL, mode: 'collection' }))
    expect(resolver.resolve).toHaveBeenCalledWith(
      { url: VIDEO_URL, mode: 'collection' },
      expect.any(AbortSignal),
    )
  })

  it.each([
    ['no url', {}],
    ['a url that is not a string', { url: 42 }],
    ['an unknown mode', { url: VIDEO_URL, mode: 'video' }],
    ['malformed JSON', '{"url": '],
    ['a JSON array', '[]'],
  ])('answers %s with 400 invalid_request without resolving', async (_label, body) => {
    const { app, resolver } = setup()
    expect(await errorOf(await send(app, '/api/resolve', postJson(body)))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('answers a body over 64 KiB with 413 invalid_request without resolving', async () => {
    const { app, resolver } = setup()
    const res = await send(app, '/api/resolve', postJson({ url: 'x'.repeat(70_000) }))
    expect(await errorOf(res)).toMatchObject({ status: 413, code: 'invalid_request' })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('refuses a form post (no JSON Content-Type) with 415 before resolving', async () => {
    const { app, resolver } = setup()
    const res = await send(app, '/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(VIDEO_URL)}`,
    })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('refuses another origin with 403 before resolving', async () => {
    const { app, resolver } = setup()
    const res = await send(
      app,
      '/api/resolve',
      postJson({ url: VIDEO_URL }, { origin: 'http://evil.test' }),
    )
    expect(await errorOf(res)).toMatchObject({ status: 403, code: 'forbidden' })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it('cannot be triggered with GET', async () => {
    const { app, resolver } = setup()
    expect(await errorOf(await send(app, '/api/resolve'))).toMatchObject({ status: 404 })
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it.each([
    'invalid_url',
    'unsupported_url',
    'private',
    'geo_blocked',
    'bot_check',
    'rate_limited',
    'network',
    'engine_missing',
    'canceled',
    'unknown',
  ] as const satisfies readonly ErrorCode[])(
    'answers ApiError %s with its status and body',
    async (code) => {
      const { app } = setup({
        resolve: async () => {
          throw new ApiError(code, `Failed with ${code}.`)
        },
      })
      expect(await errorOf(await send(app, '/api/resolve', postJson({ url: VIDEO_URL })))).toEqual({
        status: ERROR_STATUS[code],
        code,
        message: `Failed with ${code}.`,
      })
    },
  )

  it('sends no Access-Control-* headers', async () => {
    const { app } = setup()
    const res = await send(
      app,
      '/api/resolve',
      postJson({ url: VIDEO_URL }, { origin: `http://${HOST}` }),
    )
    expect(res.status).toBe(200)
    expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
  })
})

describe('POST /api/resolve/entries', () => {
  it('enriches the rows and returns the per-row results', async () => {
    const { app, enricher } = setup()
    const res = await send(app, '/api/resolve/entries', postJson({ entries: [ENTRY] }))
    expect(res.status).toBe(200)
    expect(ResolveEntriesResponseSchema.parse(await res.json())).toStrictEqual(ENRICHED)
    expect(enricher.enrich).toHaveBeenCalledWith({ entries: [ENTRY] }, expect.any(AbortSignal))
  })

  it.each([
    ['no rows', { entries: [] }],
    [
      `more than ${MAX_ENTRIES_PER_REQUEST} rows`,
      { entries: Array.from({ length: MAX_ENTRIES_PER_REQUEST + 1 }, () => ENTRY) },
    ],
    ['a row with a non-http URL', { entries: [{ ...ENTRY, url: 'file:///etc/passwd' }] }],
    ['a row with an unknown platform', { entries: [{ ...ENTRY, platform: 'spotify' }] }],
    ['a row without an id', { entries: [{ ...ENTRY, id: '' }] }],
    ['the old urls shape', { urls: [ENTRY.url] }],
  ])('answers %s with 400 invalid_request without enriching', async (_label, body) => {
    const { app, enricher } = setup()
    expect(await errorOf(await send(app, '/api/resolve/entries', postJson(body)))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(enricher.enrich).not.toHaveBeenCalled()
  })

  it('refuses a request without a JSON Content-Type with 415', async () => {
    const { app, enricher } = setup()
    const res = await send(app, '/api/resolve/entries', {
      method: 'POST',
      body: JSON.stringify({ entries: [ENTRY] }),
    })
    expect(await errorOf(res)).toMatchObject({ status: 415 })
    expect(enricher.enrich).not.toHaveBeenCalled()
  })

  it('answers engine_missing from the enricher with 503', async () => {
    const { app } = setup({
      enrich: async () => {
        throw new ApiError('engine_missing', 'yt-dlp is not on PATH.')
      },
    })
    const res = await send(app, '/api/resolve/entries', postJson({ entries: [ENTRY] }))
    expect(await errorOf(res)).toEqual({
      status: 503,
      code: 'engine_missing',
      message: 'yt-dlp is not on PATH.',
    })
  })
})

describe('with the built UI served (production)', () => {
  const INDEX = '<!doctype html><html><head><title>DJ Scraper</title></head><body></body></html>\n'
  let dist = ''
  beforeAll(async () => {
    dist = await mkdtemp(path.join(tmpdir(), 'dj-scraper-resolve-dist-'))
    await writeFile(path.join(dist, 'index.html'), INDEX)
  })
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true })
  })

  it('routes POST /api/resolve to the resolver', async () => {
    const { app, resolver, enricher } = setup({ webRoot: dist })
    const res = await send(app, '/api/resolve', postJson({ url: VIDEO_URL }))
    expect(res.status).toBe(200)
    expect(ResolveResultSchema.parse(await res.json())).toStrictEqual(RESOLVED)
    expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith(
      { url: VIDEO_URL, mode: 'auto' },
      expect.any(AbortSignal),
    )
    expect(enricher.enrich).not.toHaveBeenCalled()
  })

  it('routes POST /api/resolve/entries to the enricher', async () => {
    const { app, resolver, enricher } = setup({ webRoot: dist })
    const res = await send(app, '/api/resolve/entries', postJson({ entries: [ENTRY] }))
    expect(res.status).toBe(200)
    expect(ResolveEntriesResponseSchema.parse(await res.json())).toStrictEqual(ENRICHED)
    expect(enricher.enrich).toHaveBeenCalledExactlyOnceWith(
      { entries: [ENTRY] },
      expect.any(AbortSignal),
    )
    expect(resolver.resolve).not.toHaveBeenCalled()
  })

  it.each(['/api/resolve', '/api/resolve/entries'])(
    'answers GET %s with 404 not_found JSON, not index.html',
    async (target) => {
      const { app, resolver, enricher } = setup({ webRoot: dist })
      // The same app serves the UI, so the SPA fallback is live and could have answered.
      const page = await send(app, '/')
      expect(page.status).toBe(200)
      expect(await page.text()).toBe(INDEX)

      expect(await errorOf(await send(app, target))).toEqual({
        status: 404,
        code: 'not_found',
        message: 'Not found',
      })
      expect(resolver.resolve).not.toHaveBeenCalled()
      expect(enricher.enrich).not.toHaveBeenCalled()
    },
  )
})
