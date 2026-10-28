import { constants } from 'node:fs'
import { open, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  type Health,
  PreviewReadySchema,
  SECURITY_HEADERS,
} from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeTempDir } from '../../test/helpers.ts'
import { createApp } from '../app.ts'
import { ApiError } from '../http/errors.ts'
import type { PreviewStore } from '../preview/store.ts'
import { UNUSED_DEPS } from '../stubs.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`
const ID = 'ab'.repeat(16)

const health: Health = {
  ok: false,
  checkedAt: '2026-10-28T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

/** 1000 bytes, byte i = i % 251: any slice tells which bytes it is. */
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))

let dir: string
beforeAll(async () => {
  dir = await makeTempDir('previews-route')
  await writeFile(path.join(dir, 'a.m4a'), BODY)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

function setup(overrides: Partial<PreviewStore> = {}) {
  const previews = {
    prepare: vi.fn<PreviewStore['prepare']>(async () => ({
      id: ID,
      src: `/api/previews/${ID}`,
      mime: 'audio/mp4',
      sizeBytes: BODY.length,
    })),
    open: vi.fn<PreviewStore['open']>(async (id) =>
      id === ID
        ? {
            handle: await open(path.join(dir, 'a.m4a'), constants.O_RDONLY),
            size: BODY.length,
            mime: 'audio/mp4',
          }
        : undefined,
    ),
    close: vi.fn<PreviewStore['close']>(async () => {}),
    ...overrides,
  }
  const app = createApp({
    port: PORT,
    health: { current: async () => health, recheck: async () => health },
    ...UNUSED_DEPS,
    previews,
  })
  return { app, previews }
}

const send = (app: ReturnType<typeof createApp>, route: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}${route}`, { ...init, headers }))
}
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const REQUEST = {
  platform: 'youtube',
  id: 'jNQXAC9IVRw',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
}
const errorOf = async (res: Response) => ({
  status: res.status,
  ...ApiErrorBodySchema.parse(await res.json()).error,
})
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer())

describe('POST /api/previews', () => {
  it("answers the store's PreviewReady, with the request's abort signal", async () => {
    const { app, previews } = setup()
    const res = await send(app, '/api/previews', post(REQUEST))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(PreviewReadySchema.parse(await res.json()).src).toBe(`/api/previews/${ID}`)
    expect(previews.prepare).toHaveBeenCalledWith(REQUEST, expect.any(AbortSignal))
  })

  it.each([
    ['no url', { platform: 'youtube', id: 'x' }],
    ['no id', { platform: 'youtube', url: REQUEST.url }],
    ['an empty id', { ...REQUEST, id: '' }],
    ['Spotify as the platform', { ...REQUEST, platform: 'spotify' }],
    ['a url that is not http(s)', { ...REQUEST, url: 'file:///etc/passwd' }],
    [
      'an over-long url',
      { ...REQUEST, url: `https://www.youtube.com/watch?v=${'a'.repeat(3000)}` },
    ],
    ['malformed JSON', '{"platform": '],
    ['a JSON array', '[]'],
  ])('refuses %s with 400 invalid_request, never calling the store', async (_name, body) => {
    const { app, previews } = setup()
    const error = await errorOf(await send(app, '/api/previews', post(body)))
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(previews.prepare).not.toHaveBeenCalled()
  })

  it('refuses a body over the JSON limit with 413', async () => {
    const { app } = setup()
    const res = await send(app, '/api/previews', post({ ...REQUEST, junk: 'x'.repeat(70_000) }))
    expect(res.status).toBe(413)
  })

  it('answers a store failure with its code and status', async () => {
    const { app } = setup({
      prepare: async () => {
        throw new ApiError('preview_only', 'Only a 30-second preview is available.')
      },
    })
    expect(await errorOf(await send(app, '/api/previews', post(REQUEST)))).toMatchObject({
      status: 422,
      code: 'preview_only',
    })
  })

  it('needs application/json like every mutation (415), and refuses a foreign Origin', async () => {
    const { app, previews } = setup()
    const text = await send(app, '/api/previews', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(REQUEST),
    })
    expect(text.status).toBe(415)
    const foreign = await send(app, '/api/previews', post(REQUEST, { origin: 'https://evil.test' }))
    expect(foreign.status).toBe(403)
    expect(previews.prepare).not.toHaveBeenCalled()
  })
})

describe('GET /api/previews/:id', () => {
  it('serves the whole file with its type, Accept-Ranges and no-store', async () => {
    const { app } = setup()
    const res = await send(app, `/api/previews/${ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mp4')
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-range')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name)).toBe(value)
    }
    expect(await bytes(res)).toEqual(BODY)
  })

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=100-199', 100, 199],
    ['bytes=900-', 900, 999],
    ['bytes=-50', 950, 999],
    ['bytes=990-5000', 990, 999],
    ['bytes=0-0', 0, 0],
  ])('answers %s with 206 and exactly those bytes', async (range, start, end) => {
    const { app } = setup()
    const res = await send(app, `/api/previews/${ID}`, { headers: { range } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`)
    expect(res.headers.get('content-length')).toBe(String(end - start + 1))
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await bytes(res)).toEqual(BODY.subarray(start, end + 1))
  })

  it.each(['bytes=1000-', 'bytes=2000-3000', 'bytes=-0'])(
    'answers %s with 416 and the size',
    async (range) => {
      const { app } = setup()
      const res = await send(app, `/api/previews/${ID}`, { headers: { range } })
      expect(res.status).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */1000')
      expect(res.headers.get('cache-control')).toBe('no-store')
    },
  )

  it('ignores a Range it does not understand: the whole file', async () => {
    const { app } = setup()
    for (const range of ['items=0-5', 'bytes=0-5,10-20', 'garbage']) {
      const res = await send(app, `/api/previews/${ID}`, { headers: { range } })
      expect(res.status).toBe(200)
      expect((await bytes(res)).length).toBe(1000)
    }
  })

  it('answers HEAD with the headers and no body', async () => {
    const { app } = setup()
    const res = await send(app, `/api/previews/${ID}`, {
      method: 'HEAD',
      headers: { range: 'bytes=0-9' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('')
  })

  it.each([
    ['too short', 'ab'.repeat(15)],
    ['too long', 'ab'.repeat(17)],
    ['upper case', 'AB'.repeat(16)],
    ['not hex', 'zz'.repeat(16)],
    ['a path', '..%2f..%2fetc%2fpasswd'],
    ['a dotted name', `${ID}.m4a`],
    ['a uuid', '0b7c1a52-8f0e-4c1e-9d38-2a3a6c1f5e11'],
  ])('answers an id that is %s with 404 before the store is asked', async (_name, id) => {
    const { app, previews } = setup()
    const error = await errorOf(await send(app, `/api/previews/${id}`))
    expect(error).toMatchObject({ status: 404, code: 'not_found' })
    expect(previews.open).not.toHaveBeenCalled()
  })

  it('answers an id with no cached file with 404', async () => {
    const { app } = setup()
    const error = await errorOf(await send(app, `/api/previews/${'cd'.repeat(16)}`))
    expect(error).toMatchObject({ status: 404, code: 'not_found' })
  })

  describe('the guard still applies (nothing is relaxed for <audio>)', () => {
    it('serves a same-origin <audio> request (Sec-Fetch-Site same-origin, dest audio)', async () => {
      const { app } = setup()
      const res = await send(app, `/api/previews/${ID}`, {
        headers: {
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'audio',
        },
      })
      expect(res.status).toBe(200)
    })

    it.each([
      ['cross-site', 'audio'],
      ['same-site', 'audio'],
      ['cross-site', 'empty'],
      ['cross-site', 'document'],
    ])('refuses Sec-Fetch-Site: %s (dest %s) with 403 and no file', async (site, dest) => {
      const { app, previews } = setup()
      const res = await send(app, `/api/previews/${ID}`, {
        headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': dest },
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      expect(previews.open).not.toHaveBeenCalled()
    })

    it('refuses a foreign Origin and a foreign Host', async () => {
      const { app } = setup()
      expect(
        (await send(app, `/api/previews/${ID}`, { headers: { origin: 'https://evil.test' } }))
          .status,
      ).toBe(403)
      const foreignHost = await app.request(`http://evil.test/api/previews/${ID}`, {
        headers: { host: 'evil.test' },
      })
      expect(foreignHost.status).toBe(403)
    })
  })
})
