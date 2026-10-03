import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import {
  type ApiErrorBody,
  ApiErrorBodySchema,
  type ErrorCode,
  ErrorCodeSchema,
  type ErrorInfo,
  ErrorInfoSchema,
} from './errors.ts'
import { issuePaths, without } from './test-helpers.ts'

const botCheck = {
  code: 'bot_check',
  message: 'YouTube wants to confirm you are not a bot. Sign in with your browser and retry.',
} satisfies ErrorInfo

const botCheckBody = { error: botCheck } satisfies ApiErrorBody

/** ErrorInfo values that must fail, with the path of the field that fails. */
const invalidErrorInfos = [
  ['without a code', without(botCheck, 'code'), 'code'],
  ['without a message', without(botCheck, 'message'), 'message'],
  ['with a code outside ErrorCode', { ...botCheck, code: 'teapot' }, 'code'],
  ['with an HTTP status as the code', { ...botCheck, code: 429 }, 'code'],
  ['with an empty message', { ...botCheck, message: '' }, 'message'],
  ['with a non-string message', { ...botCheck, message: { reason: 'bot' } }, 'message'],
] as const

describe('ErrorCodeSchema', () => {
  it('rejects a job status that is not an error code', () => {
    expect(ErrorCodeSchema.safeParse('skipped').success).toBe(false)
  })

  it('is exactly the union of the error codes in the domain model', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | 'invalid_url'
      | 'unsupported_url'
      | 'unavailable'
      | 'private'
      | 'geo_blocked'
      | 'age_restricted'
      | 'login_required'
      | 'bot_check'
      | 'rate_limited'
      | 'preview_only'
      | 'network'
      | 'engine_missing'
      | 'postprocess_failed'
      | 'disk_full'
      | 'folder_unavailable'
      | 'canceled'
      | 'invalid_request'
      | 'forbidden'
      | 'not_found'
      | 'unknown'
    >()
  })
})

describe('ErrorInfoSchema', () => {
  it('parses a code with a user-facing message unchanged', () => {
    expect(ErrorInfoSchema.parse(botCheck)).toStrictEqual(botCheck)
  })

  it.each(invalidErrorInfos)('rejects an error %s', (_label, input, field) => {
    expect(issuePaths(ErrorInfoSchema, input)).toEqual([[field]])
  })

  it('strips unknown keys such as a stack trace instead of rejecting them', () => {
    const input = { ...botCheck, stack: 'Error: bot check\n    at mapError (ytdlp-parse.ts:1:1)' }
    expect(ErrorInfoSchema.parse(input)).toStrictEqual(botCheck)
  })

  it('types the code as ErrorCode and the message as string', () => {
    expectTypeOf<ErrorInfo>().toEqualTypeOf<{ code: ErrorCode; message: string }>()
  })
})

describe('ApiErrorBodySchema', () => {
  it('parses the { error: { code, message } } envelope unchanged', () => {
    expect(ApiErrorBodySchema.parse(botCheckBody)).toStrictEqual(botCheckBody)
  })

  it('rejects a bare ErrorInfo without the envelope', () => {
    expect(issuePaths(ApiErrorBodySchema, botCheck)).toEqual([['error']])
  })

  it.each(invalidErrorInfos)(
    'rejects an envelope whose error is %s, at the path under error',
    (_label, error, field) => {
      expect(issuePaths(ApiErrorBodySchema, { error })).toEqual([['error', field]])
    },
  )

  it('strips unknown keys on the envelope and the error instead of rejecting them', () => {
    const input = {
      error: { ...botCheck, stack: 'Error: bot check\n    at mapError (ytdlp-parse.ts:1:1)' },
      status: 403,
    }
    expect(ApiErrorBodySchema.parse(input)).toStrictEqual(botCheckBody)
  })

  it('wraps exactly an ErrorInfo', () => {
    expectTypeOf<ApiErrorBody>().toEqualTypeOf<{ error: ErrorInfo }>()
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof ApiErrorBodySchema>>().toEqualTypeOf<ApiErrorBody>()
  })
})
