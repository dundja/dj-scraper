import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeApi, json, networkError, noAnswer, text } from '@/test/fake-api.ts'
import { healthWith, healthy } from '@/test/health.ts'
import { ApiError, api } from './api.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

/** The rejection of `promise`; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the request to fail, but it succeeded')
}

describe('api.health', () => {
  it('asks the same-origin GET /api/health for JSON, with no Content-Type and no body', async () => {
    server.on('GET /api/health', () => json(healthy))

    await api.health()

    const [call] = server.callsTo('GET /api/health')
    expect(call?.url).toBe('/api/health')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.headers.has('Content-Type')).toBe(false)
    expect(call?.body).toBeUndefined()
  })

  it('returns the health check when the body matches the contract', async () => {
    server.on('GET /api/health', () => json(healthy))

    await expect(api.health()).resolves.toEqual(healthy)
  })

  it('passes the AbortSignal through to fetch', async () => {
    server.on('GET /api/health', () => json(healthy))
    const controller = new AbortController()

    await api.health(controller.signal)

    expect(server.callsTo('GET /api/health')[0]?.signal).toBe(controller.signal)
  })
})

describe('api.recheckHealth', () => {
  it('posts to /api/health/recheck with Content-Type: application/json even though it has no body', async () => {
    const rechecked = healthWith({ checkedAt: '2026-10-02T08:05:00.000Z' })
    server.on('POST /api/health/recheck', () => json(rechecked))

    await expect(api.recheckHealth()).resolves.toEqual(rechecked)

    const [call] = server.callsTo('POST /api/health/recheck')
    expect(call?.url).toBe('/api/health/recheck')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBeUndefined()
  })
})

describe('API failures', () => {
  it.each([
    {
      name: 'a refused Host',
      call: () => api.health(),
      route: 'GET /api/health',
      status: 403,
      code: 'forbidden',
      message: 'Host not allowed',
    },
    {
      name: 'a mutation without a JSON Content-Type',
      call: () => api.recheckHealth(),
      route: 'POST /api/health/recheck',
      status: 415,
      code: 'invalid_request',
      message: 'Content-Type must be application/json',
    },
  ] as const)(
    'reports $name as an api error with the status, code and message from the server',
    async ({ call, route, status, code, message }) => {
      server.on(route, () => json({ error: { code, message } }, status))

      const error = await rejection(call())

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ kind: 'api', status, code, message })
    },
  )

  it('reports a success whose body breaks the contract as an invalid response', async () => {
    const { ffprobe: _, ...withoutFfprobe } = healthy
    server.on('GET /api/health', () => json(withoutFfprobe))

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'invalid_response',
      status: 200,
      code: undefined,
      message: 'Unexpected response from GET /api/health.',
    })
  })

  it('reports a success that is not JSON at all as an invalid response', async () => {
    server.on('GET /api/health', () =>
      text('<!doctype html><title>DJ Scraper</title>', 200, 'text/html'),
    )

    const error = await rejection(api.health())

    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 })
  })

  it.each([
    { name: 'the Vite proxy while the server is down (502, empty text/plain)', status: 502 },
    { name: 'an empty 500 text/plain reply', status: 500 },
  ])('reports $name as unreachable', async ({ status }) => {
    server.on('GET /api/health', () => text('', status))

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'unreachable',
      status,
      code: undefined,
      message: "Can't reach the DJ Scraper server.",
    })
  })

  it.each([
    { name: 'a text page from another app on the port', reply: () => text('404 Not Found', 404) },
    {
      name: 'JSON outside the error contract',
      reply: () => json({ error: 'Internal Server Error' }, 500),
    },
  ])('reports $name as unreachable, not as an api error', async ({ reply }) => {
    server.on('GET /api/health', reply)

    const error = await rejection(api.health())

    expect(error).toMatchObject({ kind: 'unreachable', code: undefined })
  })

  it('reports a network failure as unreachable and keeps the cause', async () => {
    server.on('GET /api/health', networkError)

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'unreachable',
      status: undefined,
      cause: expect.any(TypeError),
    })
  })

  it('rejects with the abort itself, not an ApiError, when the request is aborted', async () => {
    server.on('GET /api/health', noAnswer)
    const controller = new AbortController()

    const request = api.health(controller.signal)
    controller.abort()
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(controller.signal.reason)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('reports a connection dropped while the body is still arriving as unreachable', async () => {
    server.on('GET /api/health', () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"ok":'))
          stream.error(new TypeError('network error'))
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'unreachable', cause: expect.any(TypeError) })
  })

  it('rejects with the abort when it happens while the body is still arriving', async () => {
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<void>()
    server.on('GET /api/health', ({ signal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"ok":'))
          signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true })
        },
        // Called once the reader has taken the first chunk, i.e. response.text() is running.
        pull() {
          bodyRead.resolve()
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const request = api.health(controller.signal)
    await bodyRead.promise
    controller.abort()
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(controller.signal.reason)
  })
})
