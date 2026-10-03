import { ErrorCodeSchema, UnavailableReasonSchema } from '@dj-scraper/shared'
import { CancelledError } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api.ts'
import { describeError, errorHint, isAbortError, unavailableLabel } from './error-text.ts'

const apiError = (code: Parameters<typeof errorHint>[0], message: string, status = 422) =>
  new ApiError({ kind: 'api', status, code, message })

describe('errorHint', () => {
  it.each([
    ['bot_check', 'Updating yt-dlp usually fixes this: `brew upgrade yt-dlp`.'],
    ['unknown', 'If it keeps happening, update yt-dlp: `brew upgrade yt-dlp`.'],
    ['rate_limited', 'Limits usually lift within a few minutes, at most an hour.'],
    ['folder_unavailable', 'You can pick another folder in the header.'],
    [
      'engine_missing',
      'Once it is installed (`brew install yt-dlp ffmpeg`), check the engine again in the top right.',
    ],
  ] as const)('gives %s a next step: %s', (code, hint) => {
    expect(errorHint(code)).toBe(hint)
  })

  it.each(['age_restricted', 'login_required', 'preview_only'] as const)(
    'says sign-ins come later for %s',
    (code) => {
      expect(errorHint(code)).toBe('DJ Scraper has no sign-ins yet; they come in a later version.')
    },
  )

  it.each([
    'invalid_url',
    'unsupported_url',
    'unavailable',
    'private',
    'geo_blocked',
    'network',
    'canceled',
    'invalid_request',
    'not_found',
  ] as const)('adds nothing to %s, whose message says it all', (code) => {
    expect(errorHint(code)).toBeUndefined()
  })

  it('names the start command that served the page for a refused origin', () => {
    vi.stubEnv('DEV', true)
    expect(errorHint('forbidden')).toBe('Open DJ Scraper at the address `pnpm dev` prints.')
    vi.stubEnv('DEV', false)
    expect(errorHint('forbidden')).toBe('Open DJ Scraper at the address `pnpm start` prints.')
  })

  it('writes every hint as a sentence with paired backticks', () => {
    for (const code of ErrorCodeSchema.options) {
      const hint = errorHint(code)
      if (hint === undefined) continue
      expect(hint, code).toMatch(/[.!?]$/)
      expect(hint.split('`').length % 2, code).toBe(1)
    }
  })
})

describe('describeError', () => {
  it("shows the server's own message with the code's hint", () => {
    const error = apiError(
      'rate_limited',
      'SoundCloud is limiting requests. Try again in 5 min.',
      429,
    )
    expect(describeError(error)).toEqual({
      message: 'SoundCloud is limiting requests. Try again in 5 min.',
      hint: 'Limits usually lift within a few minutes, at most an hour.',
      code: 'rate_limited',
    })
  })

  it('leaves the hint out when the code has none', () => {
    expect(describeError(apiError('private', 'Private video.'))).toEqual({
      message: 'Private video.',
      code: 'private',
    })
  })

  it('says the server is unreachable, and how to start it', () => {
    vi.stubEnv('DEV', true)
    const error = new ApiError({
      kind: 'unreachable',
      message: "Can't reach the DJ Scraper server.",
      cause: new TypeError('Failed to fetch'),
    })
    expect(describeError(error)).toEqual({
      message: "Can't reach the DJ Scraper server.",
      hint: 'Start it with `pnpm dev` in the project folder.',
    })
  })

  it('blames a version mismatch for an answer that breaks the contract', () => {
    vi.stubEnv('DEV', false)
    const error = new ApiError({
      kind: 'invalid_response',
      status: 200,
      message: 'Unexpected response from POST /api/resolve.',
    })
    expect(describeError(error)).toEqual({
      message: 'Unexpected answer from the server.',
      hint: 'If you just updated, restart `pnpm start`.',
    })
  })

  it('shows nothing for an aborted request', () => {
    const controller = new AbortController()
    controller.abort()
    expect(describeError(controller.signal.reason)).toBeUndefined()
    expect(describeError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(
      undefined,
    )
    expect(describeError(new CancelledError())).toBeUndefined()
  })

  it("shows another error's message, and a generic one for a thrown non-error", () => {
    expect(describeError(new TypeError('items is not iterable'))).toEqual({
      message: 'items is not iterable',
    })
    expect(describeError(new Error(''))).toEqual({ message: 'Something went wrong.' })
    expect(describeError('boom')).toEqual({ message: 'Something went wrong.' })
    expect(describeError(undefined)).toEqual({ message: 'Something went wrong.' })
  })
})

describe('isAbortError', () => {
  it('knows aborts from failures', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(new CancelledError())).toBe(true)
    expect(isAbortError(new DOMException('timed out', 'TimeoutError'))).toBe(false)
    expect(isAbortError(apiError('canceled', 'The request was canceled.', 409))).toBe(false)
    expect(isAbortError(new Error('AbortError'))).toBe(false)
    expect(isAbortError({ name: 'AbortError' })).toBe(false)
  })
})

describe('unavailableLabel', () => {
  it.each([
    ['unavailable', 'Unavailable'],
    ['private', 'Private'],
    ['geo_blocked', 'Not in your country'],
    ['age_restricted', 'Age-restricted'],
    ['login_required', 'Needs a login'],
    ['preview_only', 'Preview only (Go+)'],
  ] as const)('labels %s as %s', (reason, label) => {
    expect(unavailableLabel(reason)).toBe(label)
  })

  it('labels every reason the contract has', () => {
    for (const reason of UnavailableReasonSchema.options) {
      expect(unavailableLabel(reason)).not.toBe('')
    }
  })

  it('says Unavailable when no reason is known', () => {
    expect(unavailableLabel(undefined)).toBe('Unavailable')
  })
})
