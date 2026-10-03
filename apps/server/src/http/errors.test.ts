import { ApiErrorBodySchema, ErrorCodeSchema } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ERROR_STATUS, errorResponse, onError, onNotFound } from './errors.ts'

/** A bare app with only the error handlers, so each route can fail in its own way. */
const app = new Hono()
  .get('/api-error', () => {
    throw new ApiError('engine_missing', 'yt-dlp is not installed.')
  })
  .get('/rate-limited', () => {
    throw new ApiError('rate_limited', 'SoundCloud asks us to slow down.')
  })
  .get('/disk-full', () => {
    throw new ApiError('disk_full', 'The disk is full.')
  })
  .get('/folder-unavailable', () => {
    throw new ApiError('folder_unavailable', 'The folder is gone.')
  })
  .get('/conflict', () => {
    throw new ApiError('invalid_request', 'Only failed or canceled downloads can be retried.', {
      status: 409,
    })
  })
  .get('/teapot', (c) => errorResponse(c, 'invalid_request', 'I am a teapot', 418))
  .get('/client-exception', () => {
    throw new HTTPException(413, { message: 'Payload Too Large' })
  })
  .get('/server-exception', () => {
    throw new HTTPException(502, { message: 'upstream detail' })
  })
  .get('/bug', () => {
    throw new TypeError("Cannot read properties of undefined (reading 'path')")
  })
  .post('/limited', bodyLimit({ maxSize: 4 }), (c) => c.text('ok'))
app.notFound(onNotFound)
app.onError(onError)

async function errorOf(res: Response) {
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ERROR_STATUS', () => {
  it('maps every ErrorCode, and nothing else, to an HTTP status', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCodeSchema.options].sort())
  })

  it('uses statuses that say who is at fault', () => {
    expect(ERROR_STATUS).toMatchObject({
      invalid_url: 400,
      invalid_request: 400,
      forbidden: 403,
      not_found: 404,
      rate_limited: 429,
      engine_missing: 503,
      unknown: 500,
    })
  })

  it('answers a full disk with 507 and an unusable download folder with 422', () => {
    expect(ERROR_STATUS.disk_full).toBe(507)
    expect(ERROR_STATUS.folder_unavailable).toBe(422)
  })
})

describe('ApiError', () => {
  it('carries its code, message and cause', () => {
    const cause = new Error('spawn ENOENT')
    const error = new ApiError('engine_missing', 'yt-dlp is not installed.', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'ApiError',
      code: 'engine_missing',
      message: 'yt-dlp is not installed.',
      cause,
    })
  })

  it.each(ErrorCodeSchema.options)('answers %s with its mapped status by default', (code) => {
    expect(new ApiError(code, 'message').status).toBe(ERROR_STATUS[code])
  })

  it('takes a status override next to its cause, and passes only the cause on to Error', () => {
    const cause = new Error('EEXIST')
    const error = new ApiError('invalid_request', 'Already done.', { status: 409, cause })
    expect(error).toMatchObject({ code: 'invalid_request', status: 409, cause })
    expect(Object.keys(error)).not.toContain('cause')
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false)
  })

  it('has no cause when none is given', () => {
    expect('cause' in new ApiError('not_found', 'Not found', { status: 404 })).toBe(false)
  })
})

describe('onError', () => {
  it.each([
    ['/api-error', 503, 'engine_missing', 'yt-dlp is not installed.'],
    ['/rate-limited', 429, 'rate_limited', 'SoundCloud asks us to slow down.'],
    ['/disk-full', 507, 'disk_full', 'The disk is full.'],
    ['/folder-unavailable', 422, 'folder_unavailable', 'The folder is gone.'],
  ])(
    'answers an ApiError thrown in %s with its status and code',
    async (path, status, code, message) => {
      expect(await errorOf(await app.request(path))).toEqual({ status, code, message })
    },
  )

  it('answers an ApiError with its status override instead of the mapped one', async () => {
    expect(await errorOf(await app.request('/conflict'))).toEqual({
      status: 409,
      code: 'invalid_request',
      message: 'Only failed or canceled downloads can be retried.',
    })
  })

  it('does not log an ApiError, overridden or not', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const path of ['/api-error', '/disk-full', '/conflict']) await app.request(path)
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps the status of a 4xx HTTPException from Hono middleware, in our body shape', async () => {
    expect(await errorOf(await app.request('/client-exception'))).toEqual({
      status: 413,
      code: 'invalid_request',
      message: 'Payload Too Large',
    })
  })

  it('answers a body over the limit from hono/body-limit with 413 invalid_request', async () => {
    const res = await app.request('/limited', { method: 'POST', body: 'too long' })
    expect(await errorOf(res)).toMatchObject({ status: 413, code: 'invalid_request' })
  })

  it.each([
    ['an unexpected error', '/bug'],
    ['a 5xx HTTPException', '/server-exception'],
  ])('answers %s with 500 unknown, logs it and hides its details', async (_label, path) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await errorOf(await app.request(path))).toEqual({
      status: 500,
      code: 'unknown',
      message: 'Internal server error',
    })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toBe(`[server] GET ${path} failed:`)
  })
})

describe('errorResponse', () => {
  it('uses an explicit status over the one mapped to the code', async () => {
    expect(await errorOf(await app.request('/teapot'))).toEqual({
      status: 418,
      code: 'invalid_request',
      message: 'I am a teapot',
    })
  })
})

describe('onNotFound', () => {
  it('answers an unknown route with 404 not_found', async () => {
    expect(await errorOf(await app.request('/missing'))).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Not found',
    })
  })
})
