import {
  ApiErrorBodySchema,
  type ErrorCode,
  type Health,
  MAX_TRACK_TEXT_LENGTH,
  type RemixSuggestions,
  RemixSuggestionsSchema,
} from '@dj-scraper/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { ApiError, ERROR_STATUS } from '../http/errors.ts'
import { JSON_BODY_LIMIT_BYTES } from '../http/json.ts'
import type { RemixFinder } from '../remix/finder.ts'
import { UNUSED_DEPS } from '../stubs.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

const health: Health = {
  ok: false,
  checkedAt: '2026-10-25T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

const ANSWER: RemixSuggestions = {
  song: { title: 'Porcelain', artist: 'Moby' },
  suggestions: [
    {
      kind: 'remix',
      remixer: 'Arty',
      plays: 908188,
      uploads: [
        {
          platform: 'youtube',
          id: 'MU5FD_0iWHk',
          url: 'https://www.youtube.com/watch?v=MU5FD_0iWHk',
          title: 'Porcelain (Arty Remix)',
          uploader: 'Moby',
          durationSec: 212,
          plays: 908188,
        },
      ],
    },
  ],
  searches: {
    youtube: { status: 'ok', found: 1 },
    soundcloud: {
      status: 'error',
      error: { code: 'rate_limited', message: 'SoundCloud is limiting requests.' },
    },
  },
}

function setup(find: RemixFinder['find'] = async () => ANSWER) {
  const remixes = { find: vi.fn<RemixFinder['find']>(find) }
  const app = createApp({
    port: PORT,
    health: { current: async () => health, recheck: async () => health },
    ...UNUSED_DEPS,
    remixes,
  })
  return { app, remixes }
}

/** app.request sends no Host, so add ours (absolute URL, since the guard checks the URL too). */
const send = (app: ReturnType<typeof createApp>, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}/api/remixes`, { ...init, headers }))
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

describe('POST /api/remixes', () => {
  it("answers the finder's suggestions for the request, with the request's abort signal", async () => {
    const { app, remixes } = setup()
    const request = {
      title: 'Porcelain (Arty Remix)',
      artist: 'Moby',
      uploader: 'Moby - Topic',
      exclude: { platform: 'youtube', id: 'MU5FD_0iWHk' },
      platforms: ['youtube'],
    }
    const res = await send(app, postJson(request))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(RemixSuggestionsSchema.parse(await res.json())).toStrictEqual(ANSWER)
    expect(remixes.find).toHaveBeenCalledWith(request, expect.any(AbortSignal))
  })

  it('takes a title alone: the platforms default to both in the finder', async () => {
    const { app, remixes } = setup()
    expect((await send(app, postJson({ title: 'Porcelain' }))).status).toBe(200)
    expect(remixes.find).toHaveBeenCalledWith({ title: 'Porcelain' }, expect.any(AbortSignal))
  })

  it('accepts a title of exactly MAX_TRACK_TEXT_LENGTH', async () => {
    const { app } = setup()
    const title = 'x'.repeat(MAX_TRACK_TEXT_LENGTH)
    expect((await send(app, postJson({ title }))).status).toBe(200)
  })

  it.each([
    ['no title', { artist: 'Moby' }],
    ['an empty title', { title: '' }],
    ['a title that is not a string', { title: 42 }],
    ['a title over the length limit', { title: 'x'.repeat(MAX_TRACK_TEXT_LENGTH + 1) }],
    ['an empty artist', { title: 'Porcelain', artist: '' }],
    ['an uploader over the length limit', { title: 'Porcelain', uploader: 'x'.repeat(1001) }],
    ['an unknown platform', { title: 'Porcelain', platforms: ['spotify'] }],
    ['no platforms', { title: 'Porcelain', platforms: [] }],
    [
      'more platforms than there are',
      { title: 'Porcelain', platforms: ['youtube', 'soundcloud', 'youtube'] },
    ],
    ['platforms that are not a list', { title: 'Porcelain', platforms: 'youtube' }],
    ['an exclude without an id', { title: 'Porcelain', exclude: { platform: 'youtube' } }],
    [
      'an exclude on an unknown platform',
      { title: 'Porcelain', exclude: { platform: 'bandcamp', id: 'x' } },
    ],
    [
      'an exclude with an empty id',
      { title: 'Porcelain', exclude: { platform: 'youtube', id: '' } },
    ],
    ['malformed JSON', '{"title": '],
    ['a JSON array', '[]'],
    ['a JSON string', '"Porcelain"'],
  ])('answers %s with 400 invalid_request without searching', async (_label, body) => {
    const { app, remixes } = setup()
    expect(await errorOf(await send(app, postJson(body)))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(remixes.find).not.toHaveBeenCalled()
  })

  it('refuses a request without a JSON Content-Type with 415', async () => {
    const { app, remixes } = setup()
    const res = await send(app, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'Porcelain' }),
    })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(remixes.find).not.toHaveBeenCalled()
  })

  it('refuses a body over the JSON limit with 413', async () => {
    const { app, remixes } = setup()
    const body = JSON.stringify({ title: 'Porcelain', pad: 'x'.repeat(JSON_BODY_LIMIT_BYTES) })
    expect(await errorOf(await send(app, postJson(body)))).toMatchObject({
      status: 413,
      code: 'invalid_request',
    })
    expect(remixes.find).not.toHaveBeenCalled()
  })

  it('refuses a cross-site request before searching', async () => {
    const { app, remixes } = setup()
    const res = await send(app, postJson({ title: 'Porcelain' }, { origin: 'https://evil.test' }))
    expect(await errorOf(res)).toMatchObject({ status: 403, code: 'forbidden' })
    expect(remixes.find).not.toHaveBeenCalled()
  })

  it('answers GET with 404, as an unknown route', async () => {
    const { app } = setup()
    expect((await send(app, { method: 'GET' })).status).toBe(404)
  })

  it.each<[ErrorCode, string]>([
    ['engine_missing', 'yt-dlp is not on PATH.'],
    ['invalid_request', 'The title has no words to search for remixes of.'],
    ['canceled', 'The request was canceled.'],
    ['unknown', 'yt-dlp returned data DJ Scraper could not read.'],
  ])("answers the finder's %s with its status and message", async (code, message) => {
    const { app } = setup(async () => {
      throw new ApiError(code, message)
    })
    expect(await errorOf(await send(app, postJson({ title: 'Porcelain' })))).toEqual({
      status: ERROR_STATUS[code],
      code,
      message,
    })
  })

  it('answers an unexpected failure as 500 unknown, without its message', async () => {
    const { app } = setup(async () => {
      throw new Error('boom at /Users/someone/Music')
    })
    const error = await errorOf(await send(app, postJson({ title: 'Porcelain' })))
    expect(error).toMatchObject({ status: 500, code: 'unknown' })
    expect(error.message).not.toContain('/Users')
  })
})
