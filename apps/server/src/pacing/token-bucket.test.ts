import { describe, expect, it } from 'vitest'
import { createTokenBucket, type TokenBucket } from './token-bucket.ts'

/** Takes a token whenever one is free from `from`, stepping the clock by the wait; the start times. */
function startsOf(bucket: TokenBucket, count: number, from = 0, reserve = 0): number[] {
  const starts: number[] = []
  let now = from
  for (let i = 0; i < count; i++) {
    now += Math.max(0, bucket.waitMs(now, reserve))
    bucket.take(now)
    starts.push(now)
  }
  return starts
}

describe('createTokenBucket', () => {
  it('starts full: a burst at once, then one token per refill', () => {
    const bucket = createTokenBucket({ burst: 3, refillMs: 5000 })
    expect(startsOf(bucket, 6)).toEqual([0, 0, 0, 5000, 10_000, 15_000])
  })

  it('refills while idle up to the burst, and no further', () => {
    const bucket = createTokenBucket({ burst: 2, refillMs: 1000 })
    expect(startsOf(bucket, 2)).toEqual([0, 0])
    expect(bucket.waitMs(500)).toBe(500)
    expect(startsOf(bucket, 3, 60_000)).toEqual([60_000, 60_000, 61_000])
  })

  it('answers waitMs without spending a token', () => {
    const bucket = createTokenBucket({ burst: 1, refillMs: 1000 })
    expect(bucket.waitMs(0)).toBeLessThanOrEqual(0)
    expect(bucket.waitMs(0)).toBeLessThanOrEqual(0)
    bucket.take(0)
    expect(bucket.waitMs(0)).toBe(1000)
    expect(bucket.waitMs(250)).toBe(750)
  })

  it('keeps `reserve` tokens for others: a reserved start waits while the rest may go on', () => {
    const bucket = createTokenBucket({ burst: 25, refillMs: 5000 })
    // Downloads leave the last 5 tokens: 20 at once, then one per refill.
    const downloads = startsOf(bucket, 22, 0, 5)
    expect(downloads.slice(0, 20)).toEqual(Array(20).fill(0))
    expect(downloads.slice(20)).toEqual([5000, 10_000])
    // A lookup at 10 s still finds the reserved tokens: 4 of them plus the one that refilled.
    expect(bucket.waitMs(10_000)).toBeLessThanOrEqual(0)
    expect(bucket.waitMs(10_000, 5)).toBe(5000)
  })

  it('is one budget for every holder of the instance', () => {
    const shared = createTokenBucket({ burst: 4, refillMs: 1000 })
    // Two consumers at the same moment: whatever one takes, the other can't.
    shared.take(0)
    shared.take(0)
    shared.take(0)
    expect(shared.waitMs(0)).toBeLessThanOrEqual(0)
    shared.take(0)
    expect(shared.waitMs(0)).toBe(1000)
    expect(shared.waitMs(0, 2)).toBe(3000)
  })

  it('runs into debt when a holder takes without waiting', () => {
    const bucket = createTokenBucket({ burst: 1, refillMs: 1000 })
    bucket.take(0)
    bucket.take(0)
    expect(bucket.waitMs(0)).toBe(2000)
  })

  it('moves back with a clock that steps back, instead of waiting the step out', () => {
    const bucket = createTokenBucket({ burst: 1, refillMs: 5000 })
    bucket.take(3_600_000)
    expect(bucket.waitMs(0)).toBe(5000)
    bucket.take(5000)
    expect(bucket.waitMs(5000)).toBe(5000)
  })

  it('exposes its budget', () => {
    expect(createTokenBucket({ burst: 10, refillMs: 12_000 })).toMatchObject({
      burst: 10,
      refillMs: 12_000,
    })
  })

  it.each([
    { burst: 0, refillMs: 1000 },
    { burst: 1.5, refillMs: 1000 },
    { burst: 5, refillMs: 0 },
    { burst: 5, refillMs: Number.NaN },
    { burst: 5, refillMs: Number.POSITIVE_INFINITY },
  ])('refuses the budget %o', (budget) => {
    expect(() => createTokenBucket(budget)).toThrow(RangeError)
  })

  it.each([-1, 1.5, 3, 4])('refuses the reserve %s of a burst of 3', (reserve) => {
    const bucket = createTokenBucket({ burst: 3, refillMs: 1000 })
    expect(() => bucket.waitMs(0, reserve)).toThrow(RangeError)
  })
})
