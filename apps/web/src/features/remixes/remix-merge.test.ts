import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import { noRemixes, quickRemixes, remixes } from '@/test/remixes.ts'
import { mergeRemixes, type RemixQueryState } from './remix-merge.ts'

const pending: RemixQueryState = { status: 'pending' }
const success = (data = remixes): RemixQueryState => ({ status: 'success', data })
const quickOk = success(quickRemixes)
const engineMissing = new ApiError({
  kind: 'api',
  status: 503,
  code: 'engine_missing',
  message: 'yt-dlp is not installed.',
})
const failure = (error: unknown = engineMissing): RemixQueryState => ({ status: 'error', error })

describe('mergeRemixes', () => {
  it('waits while neither search has answered', () => {
    expect(mergeRemixes(pending, pending)).toEqual({ status: 'pending' })
  })

  it('shows the quick answer until the full one is in, with the platforms it skipped as searching', () => {
    expect(mergeRemixes(quickOk, pending)).toEqual({
      status: 'ready',
      remixes: quickRemixes,
      searching: ['soundcloud'],
    })
  })

  it('shows the full answer as soon as it is in, whatever the quick search did', () => {
    const full = { status: 'ready', remixes, searching: [] }
    expect(mergeRemixes(quickOk, success())).toEqual(full)
    expect(mergeRemixes(pending, success())).toEqual(full)
    expect(mergeRemixes(failure(), success())).toEqual(full)
  })

  it("keeps a full answer's own per-platform failure", () => {
    const partial = {
      ...noRemixes,
      searches: {
        youtube: { status: 'ok', found: 0 },
        soundcloud: { status: 'error', error: { code: 'rate_limited', message: 'Slow down.' } },
      },
    } as const
    expect(mergeRemixes(quickOk, success(partial))).toMatchObject({ remixes: partial })
  })

  it('keeps the quick rows when the full search fails, and shows its error as SoundCloud’s', () => {
    const view = mergeRemixes(quickOk, failure())
    expect(view).toEqual({
      status: 'ready',
      remixes: {
        ...quickRemixes,
        searches: {
          youtube: quickRemixes.searches.youtube,
          soundcloud: {
            status: 'error',
            error: { code: 'engine_missing', message: 'yt-dlp is not installed.' },
          },
        },
      },
      searching: [],
    })
    expect(quickRemixes.searches.soundcloud).toEqual({ status: 'skipped' })
  })

  it('words a failure without a server answer in our own terms', () => {
    const view = mergeRemixes(quickOk, failure(new TypeError('Failed to fetch')))
    if (view.status !== 'ready') throw new Error('expected the quick rows')
    expect(view.remixes.searches.soundcloud).toEqual({
      status: 'error',
      error: { code: 'unknown', message: 'Failed to fetch' },
    })
  })

  it('waits for a search still running before calling the whole search failed', () => {
    expect(mergeRemixes(failure(), pending)).toEqual({ status: 'pending' })
    expect(mergeRemixes(pending, failure())).toEqual({ status: 'pending' })
  })

  it("fails as a whole only when both searches failed, with the full search's error", () => {
    const quickError = new ApiError({ kind: 'unreachable', message: 'down' })
    expect(mergeRemixes(failure(quickError), failure())).toEqual({
      status: 'error',
      error: engineMissing,
    })
  })
})
