import { QueueStateSchema } from '@dj-scraper/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  createGates,
  DOWNLOAD_COOLDOWN,
  type GatesOptions,
  SOUNDCLOUD_DOWNLOAD_RESERVE,
  YOUTUBE_DOWNLOAD_BUDGET,
} from './gates.ts'
import { createTokenBucket } from './token-bucket.ts'

const MIN = 60_000
/** The wall clock at monotonic 0 in these tests. */
const WALL = Date.UTC(2026, 9, 2, 8, 0, 0)
const iso = (monotonic: number) => new Date(WALL + monotonic).toISOString()

/** Gates without pacing unless asked, so only the cooldown rules are in play. */
const gatesWith = (options: Partial<GatesOptions> = {}) => createGates({ buckets: {}, ...options })

/** A job of `platform` picked at `startedAt` and settled at `endedAt` with `outcome`. */
function attempt(
  gates: ReturnType<typeof createGates>,
  platform: 'youtube' | 'soundcloud' | 'other',
  outcome: Parameters<ReturnType<typeof createGates>['settled']>[1],
  startedAt: number,
  endedAt = startedAt,
) {
  gates.take(platform, startedAt)
  return gates.settled(platform, outcome, startedAt, endedAt)
}

describe('createGates: pacing', () => {
  it('admits at once without a bucket', () => {
    const gates = gatesWith()
    for (let i = 0; i < 50; i++) gates.take('youtube', 0)
    expect(gates.readyAt('youtube', 0)).toBe(0)
  })

  it('paces a platform with its bucket: the burst at once, then one per refill', () => {
    const gates = gatesWith({ buckets: { youtube: createTokenBucket(YOUTUBE_DOWNLOAD_BUDGET) } })
    const starts: number[] = []
    let now = 0
    for (let i = 0; i < 12; i++) {
      now = Math.max(now, gates.readyAt('youtube', now))
      gates.take('youtube', now)
      gates.settled('youtube', 'success', now, now)
      starts.push(now)
    }
    expect(starts).toEqual([...Array(10).fill(0), 12_000, 24_000])
    // Other platforms are not held back by YouTube's bucket.
    expect(gates.readyAt('soundcloud', now)).toBe(now)
  })

  it('leaves the reserve of a shared bucket to its other holders', () => {
    const shared = createTokenBucket({ burst: 25, refillMs: 5000 })
    const gates = gatesWith({
      buckets: { soundcloud: shared },
      downloadReserve: { soundcloud: SOUNDCLOUD_DOWNLOAD_RESERVE },
    })
    let taken = 0
    while (gates.readyAt('soundcloud', 0) <= 0) {
      gates.take('soundcloud', 0)
      taken++
    }
    expect(taken).toBe(20)
    expect(gates.readyAt('soundcloud', 0)).toBe(5000)
    // The lookups (no reserve) still have their 5 tokens.
    expect(shared.waitMs(0)).toBeLessThanOrEqual(0)
    // A lookup spending a refilled token pushes the next download back.
    shared.take(0)
    expect(gates.readyAt('soundcloud', 0)).toBe(10_000)
  })

  it('reports the next paced start of a platform as a wall-clock instant', () => {
    const gates = gatesWith({
      buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 12_000 }) },
    })
    expect(gates.state(0, WALL)).toEqual({ platforms: [] })
    gates.take('youtube', 0)
    expect(gates.state(0, WALL)).toEqual({
      platforms: [{ platform: 'youtube', nextStartAt: iso(12_000) }],
    })
    expect(gates.state(12_000, WALL + 12_000)).toEqual({ platforms: [] })
  })

  it('rounds reported instants up to whole seconds', () => {
    const gates = gatesWith({
      buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 1500 }) },
    })
    gates.take('youtube', 0.25)
    expect(gates.state(0.25, WALL + 0.7).platforms).toEqual([
      { platform: 'youtube', nextStartAt: iso(2000) },
    ])
  })

  it.each([
    [{ buckets: {}, downloadReserve: { soundcloud: 5 } }],
    [
      {
        buckets: { soundcloud: createTokenBucket({ burst: 5, refillMs: 1 }) },
        downloadReserve: { soundcloud: 5 },
      },
    ],
    [
      {
        buckets: { soundcloud: createTokenBucket({ burst: 5, refillMs: 1 }) },
        downloadReserve: { soundcloud: -1 },
      },
    ],
    [{ buckets: {}, cooldown: { baseMs: 0, maxMs: 1 } }],
    [{ buckets: {}, cooldown: { baseMs: 2, maxMs: 1 } }],
  ] satisfies [GatesOptions][])('refuses %o', (options) => {
    expect(() => createGates(options)).toThrow(RangeError)
  })
})

describe('createGates: cooldown', () => {
  it('pauses a platform after a rate limit, for 60 s doubling to 10 minutes', () => {
    const gates = gatesWith({ halfOpen: false })
    const pauses: number[] = []
    let now = 0
    for (let i = 0; i < 7; i++) {
      expect(attempt(gates, 'soundcloud', 'rate_limited', now)).toBe('strike')
      const until = gates.readyAt('soundcloud', now)
      pauses.push(until - now)
      now = until
    }
    expect(pauses).toEqual([1, 2, 4, 8, 10, 10, 10].map((m) => m * MIN))
    expect(DOWNLOAD_COOLDOWN).toEqual({ baseMs: MIN, maxMs: 10 * MIN })
  })

  it('pauses only the platform that limited us', () => {
    const gates = gatesWith()
    attempt(gates, 'youtube', 'rate_limited', 0)
    expect(gates.readyAt('youtube', 0)).toBe(MIN)
    expect(gates.readyAt('soundcloud', 0)).toBe(0)
    expect(gates.readyAt('other', 0)).toBe(0)
  })

  it('pauses YouTube for a bot check, but not the other platforms', () => {
    const gates = gatesWith()
    expect(attempt(gates, 'youtube', 'bot_check', 0)).toBe('strike')
    expect(attempt(gates, 'soundcloud', 'bot_check', 0)).toBe('none')
    expect(attempt(gates, 'other', 'bot_check', 0)).toBe('none')
    expect(gates.state(0, WALL).platforms).toEqual([
      { platform: 'youtube', pausedUntil: iso(MIN), pauseCode: 'bot_check' },
    ])
  })

  it.each(['network', 'unavailable', 'private', 'disk_full', 'canceled', 'other'] as const)(
    'neither pauses nor strikes for %s',
    (outcome) => {
      const gates = gatesWith()
      expect(attempt(gates, 'youtube', outcome, 0)).toBe('none')
      expect(gates.readyAt('youtube', 0)).toBe(0)
    },
  )

  it('does not strike for a failure whose attempt started before the pause ended', () => {
    const gates = gatesWith({ halfOpen: false })
    gates.take('youtube', 0)
    gates.take('youtube', 5000)
    expect(gates.settled('youtube', 'rate_limited', 0, 10_000)).toBe('strike')
    // Started at 5 s: inside the pause (10 s → 70 s), whether it fails during it or after it.
    expect(gates.settled('youtube', 'rate_limited', 5000, 20_000)).toBe('inside')
    gates.take('youtube', 1000)
    expect(gates.settled('youtube', 'rate_limited', 1000, 90_000)).toBe('inside')
    expect(gates.readyAt('youtube', 20_000)).toBe(70_000)
    // Started when the pause had ended: a second strike, twice as long.
    expect(attempt(gates, 'youtube', 'rate_limited', 70_000, 75_000)).toBe('strike')
    expect(gates.readyAt('youtube', 75_000)).toBe(75_000 + 2 * MIN)
  })

  it('resets the doubling only after a success that started when the pause had ended', () => {
    const gates = gatesWith({ halfOpen: false })
    attempt(gates, 'youtube', 'rate_limited', 0) // pause 0 → 60 s
    // A long download that began before the pause and finishes after it says nothing.
    gates.take('youtube', -30_000)
    expect(gates.settled('youtube', 'success', -30_000, 2 * MIN)).toBe('none')
    expect(attempt(gates, 'youtube', 'rate_limited', 2 * MIN)).toBe('strike')
    expect(gates.readyAt('youtube', 2 * MIN)).toBe(4 * MIN) // doubled: 2 min
    // A success that started after that pause resets it.
    attempt(gates, 'youtube', 'success', 4 * MIN, 5 * MIN)
    expect(attempt(gates, 'youtube', 'rate_limited', 6 * MIN)).toBe('strike')
    expect(gates.readyAt('youtube', 6 * MIN)).toBe(7 * MIN) // back to 60 s
  })

  it('reports a pause with its code, and drops it once it is over', () => {
    const gates = gatesWith()
    attempt(gates, 'soundcloud', 'rate_limited', 1000)
    expect(QueueStateSchema.parse(gates.state(1000, WALL + 1000))).toEqual({
      platforms: [{ platform: 'soundcloud', pausedUntil: iso(61_000), pauseCode: 'rate_limited' }],
    })
    expect(gates.state(61_000, WALL + 61_000)).toEqual({ platforms: [] })
  })

  it('reports a paced start beyond the end of a pause, and only then', () => {
    const gates = gatesWith({
      buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 90_000 }) },
    })
    expect(attempt(gates, 'youtube', 'rate_limited', 0)).toBe('strike')
    expect(gates.state(0, WALL).platforms).toEqual([
      {
        platform: 'youtube',
        pausedUntil: iso(MIN),
        pauseCode: 'rate_limited',
        nextStartAt: iso(90_000),
      },
    ])
    const short = gatesWith({
      buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 1000 }) },
    })
    attempt(short, 'youtube', 'rate_limited', 0)
    expect(short.state(0, WALL).platforms).toEqual([
      { platform: 'youtube', pausedUntil: iso(MIN), pauseCode: 'rate_limited' },
    ])
  })

  it('takes the wall clock it is given, not one of its own', () => {
    const gates = gatesWith()
    attempt(gates, 'youtube', 'rate_limited', 500_000)
    // The wall clock jumped an hour since: the pause still ends 60 s after the strike.
    const later = Date.UTC(2026, 9, 2, 9, 0, 0)
    expect(gates.state(510_000, later).platforms[0]?.pausedUntil).toBe(
      new Date(later + 50_000).toISOString(),
    )
  })
})

describe('createGates: half-open', () => {
  it('admits one job at a time after a pause, until one that started after it succeeds', () => {
    const gates = gatesWith()
    attempt(gates, 'youtube', 'rate_limited', 0)
    expect(gates.readyAt('youtube', MIN)).toBe(MIN)
    gates.take('youtube', MIN)
    expect(gates.readyAt('youtube', MIN)).toBe(Number.POSITIVE_INFINITY)
    expect(gates.state(MIN, WALL + MIN)).toEqual({ platforms: [] })
    // The probe fails for another reason: still one at a time.
    expect(gates.settled('youtube', 'network', MIN, MIN + 5000)).toBe('none')
    expect(gates.readyAt('youtube', MIN + 5000)).toBe(MIN + 5000)
    gates.take('youtube', MIN + 5000)
    expect(gates.readyAt('youtube', MIN + 5000)).toBe(Number.POSITIVE_INFINITY)
    gates.settled('youtube', 'success', MIN + 5000, MIN + 9000)
    gates.take('youtube', MIN + 9000)
    gates.take('youtube', MIN + 9000)
    expect(gates.readyAt('youtube', MIN + 9000)).toBe(MIN + 9000)
  })

  it('waits for the jobs that were running when the pause began', () => {
    const gates = gatesWith()
    gates.take('soundcloud', 0)
    gates.take('soundcloud', 0)
    gates.take('soundcloud', 0)
    expect(gates.settled('soundcloud', 'rate_limited', 0, 1000)).toBe('strike')
    expect(gates.readyAt('soundcloud', 2 * MIN)).toBe(Number.POSITIVE_INFINITY)
    // One of them ending as a success started before the pause: no reopening.
    expect(gates.settled('soundcloud', 'success', 0, 2 * MIN)).toBe('none')
    expect(gates.readyAt('soundcloud', 2 * MIN)).toBe(Number.POSITIVE_INFINITY)
    expect(gates.settled('soundcloud', 'rate_limited', 0, 2 * MIN)).toBe('inside')
    expect(gates.readyAt('soundcloud', 2 * MIN)).toBe(2 * MIN)
  })

  it('can be turned off', () => {
    const gates = gatesWith({ halfOpen: false })
    attempt(gates, 'youtube', 'rate_limited', 0)
    gates.take('youtube', MIN)
    expect(gates.readyAt('youtube', MIN)).toBe(MIN)
  })

  it('counts a canceled or failed job as no longer running', () => {
    const gates = gatesWith()
    attempt(gates, 'youtube', 'rate_limited', 0)
    gates.take('youtube', MIN)
    gates.settled('youtube', 'other', MIN, MIN)
    expect(gates.readyAt('youtube', MIN)).toBe(MIN)
  })
})

describe('createGates: persistent bot check', () => {
  const short = { baseMs: 1000, maxMs: 4000 }

  it('signals a block when a bot check hits the longest pause the second time in a row', () => {
    const gates = gatesWith({ cooldown: short })
    const verdicts: string[] = []
    let now = 0
    for (let i = 0; i < 6; i++) {
      verdicts.push(attempt(gates, 'youtube', 'bot_check', now))
      now = gates.readyAt('youtube', now)
    }
    // 1 s, 2 s, 4 s (the longest: once), 4 s (twice: blocked), and every one after.
    expect(verdicts).toEqual(['strike', 'strike', 'strike', 'blocked', 'blocked', 'blocked'])
  })

  it('never signals a block for rate limits', () => {
    const gates = gatesWith({ cooldown: short })
    let now = 0
    for (let i = 0; i < 6; i++) {
      expect(attempt(gates, 'youtube', 'rate_limited', now)).toBe('strike')
      now = gates.readyAt('youtube', now)
    }
  })

  it('needs the two longest pauses in a row: a rate limit or a success in between starts over', () => {
    const gates = gatesWith({ cooldown: { baseMs: 1000, maxMs: 1000 } })
    expect(attempt(gates, 'youtube', 'bot_check', 0)).toBe('strike')
    expect(attempt(gates, 'youtube', 'rate_limited', 1000)).toBe('strike')
    expect(attempt(gates, 'youtube', 'bot_check', 2000)).toBe('strike')
    attempt(gates, 'youtube', 'success', 3000)
    expect(attempt(gates, 'youtube', 'bot_check', 3000)).toBe('strike')
    expect(attempt(gates, 'youtube', 'bot_check', 4000)).toBe('blocked')
  })
})

describe('createGates: onChange', () => {
  it('tells its listeners when a pause starts or a success ends one early', () => {
    const gates = gatesWith()
    const listener = vi.fn()
    const unsubscribe = gates.onChange(listener)
    attempt(gates, 'youtube', 'network', 0)
    attempt(gates, 'youtube', 'success', 0)
    expect(listener).not.toHaveBeenCalled()
    attempt(gates, 'youtube', 'rate_limited', 0)
    expect(listener).toHaveBeenCalledTimes(1)
    attempt(gates, 'youtube', 'rate_limited', 10) // inside
    expect(listener).toHaveBeenCalledTimes(1)
    attempt(gates, 'youtube', 'success', MIN)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    unsubscribe()
    attempt(gates, 'youtube', 'rate_limited', 2 * MIN)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('lets a listener unsubscribe while being called', () => {
    const gates = gatesWith()
    const second = vi.fn()
    const unsubscribeFirst = gates.onChange(() => unsubscribeFirst())
    gates.onChange(second)
    attempt(gates, 'youtube', 'rate_limited', 0)
    attempt(gates, 'youtube', 'rate_limited', MIN)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
