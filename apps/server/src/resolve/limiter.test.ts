import { describe, expect, it, vi } from 'vitest'
import { createTokenBucket } from '../pacing/token-bucket.ts'
import { createLimiter, monotonicClock } from './limiter.ts'

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets queued promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A clock that only moves when the limiter's sleep ends (on a later turn, like a timer). */
function fakeTime() {
  const time = { now: 0, sleeps: [] as number[] }
  return {
    time,
    clock: () => time.now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        time.sleeps.push(ms)
        setImmediate(() => {
          time.now += ms
          resolve()
        })
      }),
  }
}

describe('createLimiter', () => {
  it('runs at most `concurrency` calls at once and starts the rest in call order', async () => {
    const limiter = createLimiter({ concurrency: 2 })
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    const calls = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i)
        await gate.promise
        return i
      }),
    )
    await flush()
    expect(started).toEqual([0, 1])
    expect(limiter.active).toBe(2)
    expect(limiter.waiting).toBe(2)

    gates[1]?.resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])

    gates[0]?.resolve()
    gates[2]?.resolve()
    gates[3]?.resolve()
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3])
    expect(limiter.active).toBe(0)
  })

  it('frees the slot when a call fails', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const failing = limiter.run(async () => {
      throw new Error('boom')
    })
    const next = limiter.run(async () => 'next')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('next')
  })

  it('keeps the minimum gap between starts, measured on the injected clock', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({ concurrency: 2, minIntervalMs: 1000, clock, sleep })
    const starts: number[] = []
    await Promise.all(
      [0, 1, 2, 3].map(() =>
        limiter.run(async () => {
          starts.push(time.now)
        }),
      ),
    )
    expect(starts).toEqual([0, 1000, 2000, 3000])
  })

  it('does not wait when the gap has already passed', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 1000, clock, sleep })
    await limiter.run(async () => {})
    time.now += 5000
    await limiter.run(async () => {})
    expect(time.sleeps).toEqual([])
  })

  it('drops a waiting call whose signal aborts, without running it', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const gate = deferred()
    const first = limiter.run(() => gate.promise)
    const controller = new AbortController()
    let ran = false
    const waiting = limiter.run(async () => {
      ran = true
    }, controller.signal)
    await flush()
    controller.abort(new Error('client went away'))
    await expect(waiting).rejects.toThrow('client went away')
    expect(limiter.waiting).toBe(0)
    gate.resolve()
    await first
    expect(ran).toBe(false)
  })

  it('rejects at once with the reason when the signal is already aborted', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const signal = AbortSignal.abort(new Error('already gone'))
    await expect(limiter.run(async () => 1, signal)).rejects.toThrow('already gone')
    expect(limiter.active).toBe(0)
  })

  it('ignores an abort after the call started (the call handles its own signal)', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const controller = new AbortController()
    const gate = deferred()
    const call = limiter.run(async () => {
      await gate.promise
      return 'done'
    }, controller.signal)
    await flush()
    controller.abort()
    gate.resolve()
    await expect(call).resolves.toBe('done')
  })

  it('rejects every waiting call with rejectWaiting and lets running calls finish', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const gate = deferred()
    const running = limiter.run(async () => {
      await gate.promise
      return 'ran'
    })
    const waiting = [limiter.run(async () => 'a'), limiter.run(async () => 'b')]
    await flush()
    limiter.rejectWaiting(new Error('cooldown'))
    await expect(Promise.allSettled(waiting)).resolves.toEqual([
      { status: 'rejected', reason: new Error('cooldown') },
      { status: 'rejected', reason: new Error('cooldown') },
    ])
    gate.resolve()
    await expect(running).resolves.toBe('ran')
  })

  it.each([0, -1, 1.5])('refuses the concurrency %s', (concurrency) => {
    expect(() => createLimiter({ concurrency })).toThrow(RangeError)
  })

  it.each([
    { burst: 0, refillMs: 1000 },
    { burst: 1.5, refillMs: 1000 },
    { burst: 5, refillMs: 0 },
    { burst: 5, refillMs: Number.NaN },
  ])('refuses the budget %o', (budget) => {
    expect(() => createLimiter({ concurrency: 1, budget })).toThrow(RangeError)
  })
})

describe('createLimiter: budget', () => {
  /** Start times of `count` instant calls made at once. */
  async function startsOf(
    count: number,
    options: Omit<Parameters<typeof createLimiter>[0], 'clock' | 'sleep'>,
  ) {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({ ...options, clock, sleep })
    const starts: number[] = []
    await Promise.all(
      Array.from({ length: count }, () =>
        limiter.run(async () => {
          starts.push(time.now)
        }),
      ),
    )
    return { starts, limiter, time }
  }

  it('starts a burst at once, then one call per refill', async () => {
    const { starts } = await startsOf(6, {
      concurrency: 10,
      budget: { burst: 3, refillMs: 5000 },
    })
    expect(starts).toEqual([0, 0, 0, 5000, 10_000, 15_000])
  })

  it('combines with the gap: tokens that refill while the gap paces calls are used too', async () => {
    // Burst 3 refilling 1 per 5 s at a 1 s gap: three starts 1 s apart leave 0.4 of a token, so the
    // fourth waits for it to fill at 5 s, and every later one waits 5 s more.
    const { starts } = await startsOf(7, {
      concurrency: 2,
      minIntervalMs: 1000,
      budget: { burst: 3, refillMs: 5000 },
    })
    expect(starts).toEqual([0, 1000, 2000, 5000, 10_000, 15_000, 20_000])
  })

  it('refills up to the burst while idle, and no further', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({
      concurrency: 10,
      budget: { burst: 2, refillMs: 1000 },
      clock,
      sleep,
    })
    const startAll = async (count: number) => {
      const starts: number[] = []
      await Promise.all(
        Array.from({ length: count }, () =>
          limiter.run(async () => {
            starts.push(time.now)
          }),
        ),
      )
      return starts
    }
    expect(await startAll(2)).toEqual([0, 0])
    time.now = 60_000
    expect(await startAll(3)).toEqual([60_000, 60_000, 61_000])
  })

  it('keeps waiting calls in order and never fails them for lack of a token', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({
      concurrency: 10,
      budget: { burst: 1, refillMs: 1000 },
      clock,
      sleep,
    })
    const order: string[] = []
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((name) =>
        limiter.run(async () => {
          order.push(`${name}@${time.now}`)
          return name
        }),
      ),
    )
    expect(order).toEqual(['a@0', 'b@1000', 'c@2000', 'd@3000'])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  })

  it('lets a call whose signal aborts leave the queue without spending a token', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({
      concurrency: 10,
      budget: { burst: 1, refillMs: 5000 },
      clock,
      sleep,
    })
    const starts: string[] = []
    const call = (name: string, signal?: AbortSignal) =>
      limiter.run(async () => {
        starts.push(`${name}@${time.now}`)
      }, signal)
    await call('first')
    const controller = new AbortController()
    const leaving = call('leaving', controller.signal)
    const staying = call('staying')
    // Before the 5 s wait for the next token ends (the fake sleep ends on the next turn).
    controller.abort(new Error('client went away'))
    await expect(leaving).rejects.toThrow('client went away')
    await staying
    expect(starts).toEqual(['first@0', 'staying@5000'])
  })
})

describe('createLimiter: shared bucket', () => {
  it('shares a TokenBucket instance with its other holders', async () => {
    const { time, clock, sleep } = fakeTime()
    const shared = createTokenBucket({ burst: 2, refillMs: 1000 })
    const a = createLimiter({ concurrency: 5, budget: shared, clock, sleep })
    const b = createLimiter({ concurrency: 5, budget: shared, clock, sleep })
    const starts: string[] = []
    const call = (limiter: typeof a, name: string) =>
      limiter.run(async () => {
        starts.push(`${name}@${time.now}`)
      })
    await Promise.all([call(a, 'a1'), call(b, 'b1'), call(a, 'a2'), call(b, 'b2')])
    expect(starts).toEqual(['a1@0', 'b1@0', 'a2@1000', 'b2@2000'])
  })

  it('measures the wait again after a sleep, when another holder took the token meanwhile', async () => {
    const { time, clock, sleep } = fakeTime()
    const shared = createTokenBucket({ burst: 1, refillMs: 1000 })
    shared.take(0)
    const limiter = createLimiter({
      concurrency: 1,
      budget: shared,
      clock,
      sleep: (ms) => {
        // Someone else (the download queue) takes the token that refills during this sleep.
        if (time.sleeps.length === 0) shared.take(ms)
        return sleep(ms)
      },
    })
    const starts: number[] = []
    await limiter.run(async () => {
      starts.push(time.now)
    })
    expect(time.sleeps).toEqual([1000, 1000])
    expect(starts).toEqual([2000])
  })

  it('keeps the tokens another holder reserves for it', async () => {
    const { time, clock, sleep } = fakeTime()
    const shared = createTokenBucket({ burst: 5, refillMs: 1000 })
    // Downloads take what they may, leaving 2 tokens.
    while (shared.waitMs(0, 2) <= 0) shared.take(0)
    const limiter = createLimiter({ concurrency: 5, budget: shared, clock, sleep })
    const starts: number[] = []
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.run(async () => {
          starts.push(time.now)
        }),
      ),
    )
    expect(starts).toEqual([0, 0, 1000])
  })
})

describe('createLimiter: bypass', () => {
  it('settles a call at the front through its bypass without a slot, a gap or a token', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({
      concurrency: 1,
      minIntervalMs: 1000,
      budget: { burst: 2, refillMs: 60_000 },
      clock,
      sleep,
    })
    const starts: string[] = []
    const call = (name: string, cached?: string) =>
      limiter.run(
        async () => {
          starts.push(`${name}@${time.now}`)
          return `${name} ran`
        },
        undefined,
        () => (cached === undefined ? undefined : { value: cached }),
      )
    const results = await Promise.all([call('a'), call('b', 'b cached'), call('c')])
    expect(results).toEqual(['a ran', 'b cached', 'c ran'])
    // c takes the gap and the token b would have spent.
    expect(starts).toEqual(['a@0', 'c@1000'])
  })

  it('asks the bypass again each time the call is at the front, until it answers', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const gate = deferred()
    const running = limiter.run(() => gate.promise)
    let filled: string | undefined
    let ran = false
    const waiting = limiter.run(
      async () => {
        ran = true
        return 'looked up'
      },
      undefined,
      () => (filled === undefined ? undefined : { value: filled }),
    )
    await flush()
    filled = 'from the cache'
    gate.resolve()
    await running
    await expect(waiting).resolves.toBe('from the cache')
    expect(ran).toBe(false)
  })

  it('lets the call behind an aborted one bypass at once', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const gate = deferred()
    const running = limiter.run(() => gate.promise)
    const controller = new AbortController()
    const aborted = limiter.run(async () => 'never', controller.signal)
    let cached: string | undefined
    const behind = limiter.run(
      async () => 'ran',
      undefined,
      () => (cached === undefined ? undefined : { value: cached }),
    )
    await flush()
    cached = 'hit'
    controller.abort(new Error('gone'))
    await expect(aborted).rejects.toThrow('gone')
    await expect(behind).resolves.toBe('hit')
    gate.resolve()
    await running
  })

  it('rejects the call when its bypass throws', async () => {
    const limiter = createLimiter({ concurrency: 1 })
    const call = limiter.run(
      async () => 'ran',
      undefined,
      () => {
        throw new Error('bad cache')
      },
    )
    await expect(call).rejects.toThrow('bad cache')
    expect(limiter.waiting).toBe(0)
  })
})

describe('createLimiter: clock', () => {
  it('moves its pacing back with an injected clock that steps back, instead of waiting it out', async () => {
    const { time, clock, sleep } = fakeTime()
    const limiter = createLimiter({
      concurrency: 1,
      minIntervalMs: 1000,
      budget: { burst: 1, refillMs: 5000 },
      clock,
      sleep,
    })
    time.now = 3_600_000
    await limiter.run(async () => {})
    time.now = 0
    await limiter.run(async () => {})
    expect(time.sleeps).toEqual([5000])
  })

  it('paces on a monotonic clock by default, so a wall-clock step back stalls nothing', async () => {
    // Only Date is faked, before the limiter reads a clock; its sleeps are real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const limiter = createLimiter({ concurrency: 1, minIntervalMs: 10 })
      await limiter.run(async () => {})
      vi.setSystemTime(Date.now() - 60 * 60_000)
      const startedAt = performance.now()
      await limiter.run(async () => {})
      expect(performance.now() - startedAt).toBeLessThan(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the monotonic clock it defaults to', () => {
    const before = performance.now()
    expect(monotonicClock()).toBeGreaterThanOrEqual(before)
  })
})
