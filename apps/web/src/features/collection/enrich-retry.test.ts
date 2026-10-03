import type { ErrorCode } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import {
  isTransientRequestError,
  ROW_RETRY_MAX_MS,
  ROW_RETRY_MS,
  requestBackoffMs,
  requestErrorInfo,
  rowRetryAt,
} from './enrich-retry.ts'

const apiError = (status: number, code: ErrorCode, message = 'Refused.') =>
  new ApiError({ kind: 'api', status, code, message })

describe('rowRetryAt', () => {
  it.each<ErrorCode>(['rate_limited', 'network', 'unknown', 'canceled'])(
    'asks again for a row that failed with %s 30 s later',
    (code) => {
      expect(rowRetryAt(code, 1000)).toBe(1000 + ROW_RETRY_MS)
      expect(ROW_RETRY_MS).toBe(30_000)
    },
  )

  it('waits twice as long after each failure in a row, up to 10 min', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 50].map((failures) => rowRetryAt('unknown', 0, failures))
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000])
    expect(ROW_RETRY_MAX_MS).toBe(10 * 60_000)
    expect(rowRetryAt('rate_limited', 1000, 0)).toBe(1000 + ROW_RETRY_MS)
    expect(rowRetryAt('private', 1000, 3)).toBe(Number.POSITIVE_INFINITY)
  })

  it.each<ErrorCode>([
    'unavailable',
    'private',
    'bot_check',
    'invalid_request',
    'invalid_url',
    'unsupported_url',
    'engine_missing',
  ])('never asks again for a row that failed with %s: the answer would be the same', (code) => {
    expect(rowRetryAt(code, 1000)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('requestBackoffMs', () => {
  it('waits 2 s after the first failed request, doubling up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(requestBackoffMs)).toEqual([
      2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ])
  })

  it('treats a count below one as the first failure', () => {
    expect(requestBackoffMs(0)).toBe(2000)
  })
})

describe('isTransientRequestError', () => {
  it.each([
    ['no answer from the server', new ApiError({ kind: 'unreachable', message: 'Down.' })],
    [
      "Vite's 502 while the server restarts",
      new ApiError({ kind: 'unreachable', status: 502, message: 'Down.' }),
    ],
    ['503 engine_missing', apiError(503, 'engine_missing')],
    ['500 unknown', apiError(500, 'unknown')],
    ['429 rate_limited', apiError(429, 'rate_limited')],
  ])('backs off and retries after %s', (_name, error) => {
    expect(isTransientRequestError(error)).toBe(true)
  })

  it.each([
    ['400 invalid_request', apiError(400, 'invalid_request')],
    ['415', apiError(415, 'invalid_request')],
    [
      'an answer off the contract',
      new ApiError({ kind: 'invalid_response', status: 200, message: 'Odd.' }),
    ],
    ['a bug in the app', new TypeError('x is undefined')],
    ['a thrown string', 'nope'],
  ])('fails the rows on %s, which would happen again', (_name, error) => {
    expect(isTransientRequestError(error)).toBe(false)
  })
})

describe('requestErrorInfo', () => {
  it("keeps the server's code and message", () => {
    expect(requestErrorInfo(apiError(400, 'invalid_request', 'Too many rows.'))).toEqual({
      code: 'invalid_request',
      message: 'Too many rows.',
    })
  })

  it('words an answer off the contract as unknown', () => {
    const error = new ApiError({ kind: 'invalid_response', status: 200, message: 'Odd.' })
    expect(requestErrorInfo(error)).toEqual({
      code: 'unknown',
      message: 'Unexpected answer from the server.',
    })
  })

  it("uses an unexpected error's message, else a generic one", () => {
    expect(requestErrorInfo(new TypeError('x is undefined'))).toEqual({
      code: 'unknown',
      message: 'x is undefined',
    })
    expect(requestErrorInfo('nope')).toEqual({ code: 'unknown', message: 'Something went wrong.' })
  })
})
