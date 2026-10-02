import { ApiErrorBodySchema, type Health, HealthSchema } from '@dj-scraper/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import type { HealthCheck } from './engine/health.ts'
import { ApiError } from './http/errors.ts'
import { SECURITY_HEADERS } from './http/security-headers.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

const cached: Health = {
  ok: true,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: {
    status: 'ok',
    path: '/opt/homebrew/bin/yt-dlp',
    source: 'path',
    version: '2026.08.19',
    releaseDate: '2026-08-19',
    ageDays: 44,
    stale: false,
    meetsMinimum: true,
  },
  ffmpeg: {
    status: 'ok',
    path: '/opt/homebrew/bin/ffmpeg',
    source: 'path',
    version: '8.0',
    major: 8,
    meetsMinimum: true,
    mp3: true,
  },
  ffprobe: {
    status: 'ok',
    path: '/opt/homebrew/bin/ffprobe',
    source: 'path',
    version: '8.0',
    major: 8,
    meetsMinimum: true,
  },
  jsRuntimes: [
    { name: 'deno', path: '/opt/homebrew/bin/deno', version: '2.9.7', supported: true },
    { name: 'node', path: '/opt/homebrew/bin/node', version: '24.12.0', supported: true },
  ],
}

/** What a recheck finds after the user ran `brew uninstall yt-dlp`. */
const rechecked: Health = {
  ...cached,
  ok: false,
  checkedAt: '2026-10-02T08:05:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
}

function stubHealth(overrides: Partial<HealthCheck> = {}) {
  const health = {
    current: vi.fn<HealthCheck['current']>(async () => cached),
    recheck: vi.fn<HealthCheck['recheck']>(async () => rechecked),
    ...overrides,
  }
  return { health, app: createApp({ port: PORT, health }) }
}

/** app.request sends no Host, so add ours (absolute URL, since the guard checks the URL too). */
const send = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}${path}`, { ...init, headers }))
}

const postJson = { method: 'POST', headers: { 'content-type': 'application/json' } }

async function errorOf(res: Response) {
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/health', () => {
  it('returns the current Health as JSON matching the contract', async () => {
    const { app, health } = stubHealth()
    const res = await send(app, '/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(HealthSchema.parse(await res.json())).toStrictEqual(cached)
    expect(health.current).toHaveBeenCalledOnce()
    expect(health.recheck).not.toHaveBeenCalled()
  })

  it('answers HEAD with the GET status and no body', async () => {
    const { app } = stubHealth()
    const res = await send(app, '/api/health', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers an ApiError from the health check with its status and code', async () => {
    const { app } = stubHealth({
      current: async () => {
        throw new ApiError('engine_missing', 'yt-dlp is not installed.')
      },
    })
    expect(await errorOf(await send(app, '/api/health'))).toEqual({
      status: 503,
      code: 'engine_missing',
      message: 'yt-dlp is not installed.',
    })
  })

  it('answers an unexpected failure with 500 unknown, without leaking the error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app } = stubHealth({
      current: async () => {
        throw new Error('EMFILE: too many open files, /Users/dj/secret')
      },
    })
    expect(await errorOf(await send(app, '/api/health'))).toEqual({
      status: 500,
      code: 'unknown',
      message: 'Internal server error',
    })
    expect(log).toHaveBeenCalledOnce()
  })
})

describe('POST /api/health/recheck', () => {
  it('runs a new check and returns its result', async () => {
    const { app, health } = stubHealth()
    const res = await send(app, '/api/health/recheck', postJson)
    expect(res.status).toBe(200)
    expect(HealthSchema.parse(await res.json())).toStrictEqual(rechecked)
    expect(health.recheck).toHaveBeenCalledOnce()
    expect(health.current).not.toHaveBeenCalled()
  })

  it('accepts a JSON body, which a client may send', async () => {
    const { app, health } = stubHealth()
    const res = await send(app, '/api/health/recheck', { ...postJson, body: '{}' })
    expect(res.status).toBe(200)
    expect(health.recheck).toHaveBeenCalledOnce()
  })

  it('does not spawn anything for a request without a JSON Content-Type', async () => {
    const { app, health } = stubHealth()
    const res = await send(app, '/api/health/recheck', { method: 'POST' })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(health.recheck).not.toHaveBeenCalled()
  })

  it('cannot be triggered with GET (an <img> or link)', async () => {
    const { app, health } = stubHealth()
    expect(await errorOf(await send(app, '/api/health/recheck'))).toMatchObject({
      status: 404,
      code: 'not_found',
    })
    expect(health.recheck).not.toHaveBeenCalled()
  })
})

describe('unknown routes', () => {
  it.each([
    ['an unknown API path', 'GET', '/api/nope'],
    ['the root when no UI is served (--dev, where Vite serves it)', 'GET', '/'],
    ['POST to a GET-only route (Hono has no 405)', 'POST', '/api/health'],
  ])('answer %s with 404 not_found', async (_label, method, path) => {
    const { app } = stubHealth()
    const init = method === 'POST' ? postJson : { method }
    expect(await errorOf(await send(app, path, init))).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Not found',
    })
  })
})

describe('CORS', () => {
  it('sends no Access-Control-* header on any response, allowed or rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app } = stubHealth()
    const { app: failing } = stubHealth({
      current: async () => {
        throw new Error('boom')
      },
    })
    const responses = [
      await send(app, '/api/health'),
      await send(app, '/api/health', { headers: { origin: `http://${HOST}` } }),
      await send(app, '/api/health/recheck', postJson),
      await send(app, '/api/health', { headers: { origin: 'http://evil.test' } }),
      await send(app, '/api/health/recheck', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://evil.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
      await send(app, '/api/health/recheck', {
        method: 'OPTIONS',
        headers: { origin: `http://${HOST}`, 'access-control-request-method': 'POST' },
      }),
      await send(app, '/api/health/recheck', { method: 'POST' }),
      await send(app, '/api/nope'),
      await send(failing, '/api/health'),
    ]
    expect(responses.map((res) => res.status)).toEqual([
      200, 200, 200, 403, 403, 404, 415, 404, 500,
    ])
    for (const res of responses) {
      expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual(
        [],
      )
    }
  })
})

describe('security headers', () => {
  it('are on every response: allowed, rejected by the guard, 404 and 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app } = stubHealth()
    const { app: failing } = stubHealth({
      current: async () => {
        throw new Error('boom')
      },
    })
    const responses = [
      await send(app, '/api/health'),
      await send(app, '/api/health', { method: 'HEAD' }),
      await send(app, '/api/health/recheck', postJson),
      await send(app, '/api/health', { headers: { origin: 'http://evil.test' } }),
      await Promise.resolve(app.request('http://evil.test/api/health')),
      await send(app, '/api/health/recheck', { method: 'POST' }),
      await send(app, '/api/nope'),
      await send(failing, '/api/health'),
    ]
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 403, 403, 415, 404, 500])
    for (const res of responses) {
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
    }
  })

  it('are exactly the four anti-framing, no-sniff and no-referrer headers', () => {
    expect(SECURITY_HEADERS).toStrictEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
  })
})
