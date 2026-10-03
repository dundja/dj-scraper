import { ApiErrorBodySchema, ResolveEntriesRequestSchema } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { onError } from './errors.ts'
import {
  describeIssues,
  JSON_BODY_LIMIT_BYTES,
  jsonBodyLimit,
  jsonBodyLimitOf,
  readJson,
} from './json.ts'

const Schema = z.object({
  url: z.string(),
  mode: z.enum(['auto', 'track']).default('auto'),
})

function makeApp() {
  const app = new Hono()
  app.post('/echo', jsonBodyLimit, async (c) => c.json(await readJson(c, Schema)))
  app.post('/entries', jsonBodyLimit, async (c) =>
    c.json(await readJson(c, ResolveEntriesRequestSchema)),
  )
  app.onError(onError)
  return app
}

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  Promise.resolve(
    makeApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  )

async function errorOf(res: Response) {
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

describe('readJson', () => {
  it('returns the parsed output with schema defaults applied', async () => {
    const res = await post('/echo', JSON.stringify({ url: 'https://youtu.be/x', extra: 1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://youtu.be/x', mode: 'auto' })
  })

  it.each([
    ['malformed JSON', '{"url":'],
    ['an empty body', ''],
  ])('answers %s with 400 invalid_request', async (_label, body) => {
    expect(await errorOf(await post('/echo', body))).toEqual({
      status: 400,
      code: 'invalid_request',
      message: 'The request body must be JSON',
    })
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"https://youtu.be/x"'],
    ['a number', '42'],
  ])('answers %s with 400 invalid_request', async (_label, body) => {
    expect(await errorOf(await post('/echo', body))).toEqual({
      status: 400,
      code: 'invalid_request',
      message: 'The request body must be a JSON object',
    })
  })

  it('answers a failed schema check with 400 and a short message naming the field', async () => {
    const error = await errorOf(await post('/echo', JSON.stringify({ mode: 'video' })))
    expect(error.status).toBe(400)
    expect(error.code).toBe('invalid_request')
    expect(error.message).toMatch(/^url: .+; mode: .+$/)
    expect(error.message).not.toContain('\n')
  })

  it('names array elements by index', async () => {
    const body = JSON.stringify({
      entries: [{ platform: 'soundcloud', id: '1', url: 'ftp://soundcloud.com/x' }],
    })
    const error = await errorOf(await post('/entries', body))
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' })
    expect(error.message).toMatch(/^entries\[0\]\.url: /)
  })
})

describe('describeIssues', () => {
  it('shows the first three issues and counts the rest', () => {
    const result = z
      .object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string() })
      .safeParse({})
    if (result.success) throw new Error('expected a failure')
    const message = describeIssues(result.error.issues)
    expect(message.split('; ')).toHaveLength(3)
    expect(message).toMatch(/^a: .+; b: .+; c: .+ \(and 2 more\)$/)
  })

  it('omits the path for an issue at the root', () => {
    const result = z.string().safeParse(1)
    if (result.success) throw new Error('expected a failure')
    expect(describeIssues(result.error.issues)).not.toMatch(/^:/)
  })
})

describe('jsonBodyLimit', () => {
  it('answers a body over 64 KiB with 413 invalid_request before reading it', async () => {
    const body = JSON.stringify({ url: 'x'.repeat(JSON_BODY_LIMIT_BYTES) })
    expect(await errorOf(await post('/echo', body))).toEqual({
      status: 413,
      code: 'invalid_request',
      message: 'The request body is larger than 64 KiB',
    })
  })

  it('also stops a chunked body without Content-Length once it passes the limit', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await makeApp().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body,
      duplex: 'half',
    })
    expect(await errorOf(res)).toMatchObject({ status: 413, code: 'invalid_request' })
  })

  it('lets a body at the limit through to the schema check', async () => {
    const padding = JSON_BODY_LIMIT_BYTES - JSON.stringify({ url: '' }).length
    const body = JSON.stringify({ url: 'x'.repeat(padding) })
    expect(body.length).toBe(JSON_BODY_LIMIT_BYTES)
    expect((await post('/echo', body)).status).toBe(200)
  })
})

describe('jsonBodyLimitOf', () => {
  const MIB = 1024 * 1024

  /** An app with one JSON route limited to `maxBytes`. */
  const limitedApp = (maxBytes: number) => {
    const app = new Hono()
    app.post('/echo', jsonBodyLimitOf(maxBytes), async (c) => c.json(await readJson(c, Schema)))
    app.onError(onError)
    return app
  }
  const postTo = async (app: Hono, body: string) =>
    app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  /** A valid /echo body of exactly `bytes` bytes. */
  const bodyOf = (bytes: number) =>
    JSON.stringify({ url: 'x'.repeat(bytes - JSON.stringify({ url: '' }).length) })

  it('lets an 8 MiB body (POST /api/downloads) through and answers one byte more with 413', async () => {
    const app = limitedApp(8 * MIB)
    expect((await postTo(app, bodyOf(8 * MIB))).status).toBe(200)
    expect(await errorOf(await postTo(app, bodyOf(8 * MIB + 1)))).toEqual({
      status: 413,
      code: 'invalid_request',
      message: 'The request body is larger than 8 MiB',
    })
  })

  it.each([
    [8 * MIB, '8 MiB'],
    [MIB, '1 MiB'],
    [1536 * 1024, '1536 KiB'],
    [JSON_BODY_LIMIT_BYTES, '64 KiB'],
    [2048, '2 KiB'],
    [1500, '1500 bytes'],
    [100, '100 bytes'],
  ])('names a limit of %i bytes as %s', async (maxBytes, named) => {
    const res = await postTo(limitedApp(maxBytes), bodyOf(maxBytes + 1))
    expect(await errorOf(res)).toEqual({
      status: 413,
      code: 'invalid_request',
      message: `The request body is larger than ${named}`,
    })
  })

  it('keeps each limit to its own route', async () => {
    const app = new Hono()
    app.post('/small', jsonBodyLimitOf(1024), async (c) => c.json(await readJson(c, Schema)))
    app.post('/large', jsonBodyLimitOf(MIB), async (c) => c.json(await readJson(c, Schema)))
    app.onError(onError)
    const body = bodyOf(4096)
    const send = (route: string) =>
      app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect((await send('/small')).status).toBe(413)
    expect((await send('/large')).status).toBe(200)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a limit of %s bytes',
    (maxBytes) => {
      expect(() => jsonBodyLimitOf(maxBytes)).toThrow(RangeError)
    },
  )
})
