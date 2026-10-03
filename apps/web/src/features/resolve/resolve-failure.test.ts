import { type ErrorCode, ErrorCodeSchema } from '@dj-scraper/shared'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import { urls } from '@/test/resolve.ts'
import { failureView, listFallback } from './resolve-failure.ts'

const apiError = (code: ErrorCode, message = 'Private video.') =>
  new ApiError({ kind: 'api', status: 422, code, message })
const unreachable = new ApiError({
  kind: 'unreachable',
  message: "Can't reach the DJ Scraper server.",
})

describe('failureView', () => {
  it("shows the server's message with the code's next step", () => {
    expect(
      failureView(apiError('age_restricted', 'Age-restricted: needs browser cookies.')),
    ).toEqual({
      title: 'Age-restricted: needs browser cookies.',
      detail: 'DJ Scraper has no sign-ins yet; they come in a later version.',
    })
  })

  it('shows only the message when there is no next step', () => {
    expect(failureView(apiError('private'))).toEqual({ title: 'Private video.' })
  })

  it('says the server is offline, and how to start it, when nothing answered', () => {
    expect(failureView(unreachable)).toEqual({
      title: 'Server offline',
      detail: "Can't reach the DJ Scraper server. Start it with `pnpm dev` in the project folder.",
    })
    vi.stubEnv('DEV', false)
    expect(failureView(unreachable)?.detail).toContain('`pnpm start`')
  })

  it('has nothing to show for an abort', () => {
    expect(
      failureView(new DOMException('The operation was aborted.', 'AbortError')),
    ).toBeUndefined()
  })

  it('still has words for anything else that was thrown', () => {
    expect(failureView(new Error('boom'))).toEqual({ title: 'boom' })
  })
})

describe('listFallback', () => {
  it("offers the list when a track-in-a-list link's track can't be loaded", () => {
    expect(listFallback(urls.watchList, 'auto', apiError('private'))).toBe('playlist')
    expect(listFallback(urls.mix, 'auto', apiError('age_restricted'))).toBe('mix')
    const albumTrack =
      'https://www.youtube.com/watch?v=XNEnEBrHws8&list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0'
    expect(listFallback(albumTrack, 'auto', apiError('geo_blocked'))).toBe('album')
  })

  it('offers it for failures of the track itself, not for a bad link or a refused request', () => {
    const offered = ErrorCodeSchema.options.filter(
      (code) => listFallback(urls.watchList, 'auto', apiError(code)) !== undefined,
    )
    expect(offered).toEqual([
      'unavailable',
      'private',
      'geo_blocked',
      'age_restricted',
      'login_required',
      'bot_check',
      'rate_limited',
      'preview_only',
      'network',
      'not_found',
      'unknown',
    ])
  })

  it('offers nothing for other links, other modes, or no answer from the server', () => {
    expect(listFallback(urls.track, 'auto', apiError('private'))).toBeUndefined()
    expect(listFallback(urls.playlist, 'auto', apiError('private'))).toBeUndefined()
    expect(listFallback(urls.watchList, 'collection', apiError('private'))).toBeUndefined()
    expect(listFallback(urls.watchList, 'track', apiError('private'))).toBeUndefined()
    expect(listFallback(urls.watchList, 'auto', unreachable)).toBeUndefined()
    expect(listFallback(urls.watchList, 'auto', new Error('boom'))).toBeUndefined()
  })
})
