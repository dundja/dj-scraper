import { describe, expect, it } from 'vitest'
import { noRemixes, quickRemixes, remixes, remixesWith } from '@/test/remixes.ts'
import { remixesQueryOptions, remixStaleTime } from './use-remixes.ts'

const THIRTY_MINUTES = 30 * 60_000
const failed = { status: 'error', error: { code: 'network', message: 'No answer.' } } as const

describe('remixStaleTime', () => {
  it('keeps an answer whose searches went fine for 30 minutes, as the server does', () => {
    expect(remixStaleTime(remixes)).toBe(THIRTY_MINUTES)
    expect(remixStaleTime(noRemixes)).toBe(THIRTY_MINUTES)
  })

  it('keeps a quick answer, whose skipped platform is not a failure', () => {
    expect(remixStaleTime(quickRemixes)).toBe(THIRTY_MINUTES)
  })

  it('makes an answer with a failed search stale at once: the server cached nothing of it', () => {
    expect(
      remixStaleTime(remixesWith({ searches: { ...remixes.searches, soundcloud: failed } })),
    ).toBe(0)
    expect(
      remixStaleTime(remixesWith({ searches: { ...quickRemixes.searches, youtube: failed } })),
    ).toBe(0)
  })

  it('has nothing to keep without an answer', () => {
    expect(remixStaleTime(undefined)).toBe(0)
  })
})

describe('remixesQueryOptions', () => {
  it('keys the query by the request and never retries by itself', () => {
    const options = remixesQueryOptions({ title: 'Porcelain', platforms: ['youtube'] })
    expect(options.queryKey).toEqual(['remixes', { title: 'Porcelain', platforms: ['youtube'] }])
    expect(options.retry).toBe(false)
    expect(options.gcTime).toBe(THIRTY_MINUTES)
  })
})
