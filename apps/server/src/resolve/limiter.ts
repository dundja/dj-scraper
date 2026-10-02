/** Resolves after `ms`. Injected so pacing tests can run on a fake clock. */
export type Sleep = (ms: number) => Promise<void>

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Milliseconds on a clock that never steps. Pacing, cooldowns and cache expiry use it rather than
 * `Date.now`, so a wall-clock change (by hand, or a large NTP step) can't stall every queued call
 * for the length of the step, or end a cooldown early.
 */
export const monotonicClock = (): number => performance.now()

/**
 * A token bucket on call starts: `burst` calls may start at once, then one more per `refillMs`.
 * It is full when the limiter is created, and a waiting call takes the next token in FIFO order.
 */
export type Budget = { burst: number; refillMs: number }

export type LimiterOptions = {
  /** At most this many calls run at once. */
  concurrency: number
  /** The least time between two call starts (pacing). Default 0. */
  minIntervalMs?: number
  /** Caps starts over longer stretches than `minIntervalMs`. Default: none. */
  budget?: Budget
  /** Default `monotonicClock`. */
  clock?: () => number
  sleep?: Sleep
}

/**
 * Checked while a call is at the front of the queue, before it takes anything: `{ value }` settles
 * the call with that value without a slot, a pacing gap or a token (it starts nothing).
 */
export type Bypass<T> = () => { value: T } | undefined

export type Limiter = {
  /**
   * Runs `fn` once a slot is free, the gap since the last start has passed and the budget has a
   * token, in call order (FIFO). A call whose `signal` aborts while it waits leaves the queue and
   * rejects with `signal.reason`; a running call is up to `fn`. Waiting never fails on its own.
   */
  run: <T>(fn: () => Promise<T>, signal?: AbortSignal, bypass?: Bypass<T>) => Promise<T>
  /** Rejects every waiting call with `reason`; running calls continue. */
  rejectWaiting: (reason: unknown) => void
  readonly active: number
  readonly waiting: number
}

/**
 * A FIFO concurrency limiter with an optional minimum gap between starts and an optional start
 * budget. It caps yt-dlp processes and paces lookups per platform (see the enricher's pacing).
 */
export function createLimiter({
  concurrency,
  minIntervalMs = 0,
  budget,
  clock = monotonicClock,
  sleep = defaultSleep,
}: LimiterOptions): Limiter {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`)
  }
  if (
    budget !== undefined &&
    !(Number.isSafeInteger(budget.burst) && budget.burst >= 1 && budget.refillMs > 0)
  ) {
    throw new RangeError('budget needs a positive integer burst and a positive refillMs')
  }
  type Waiter = {
    start: () => void
    fail: (reason: unknown) => void
    /** Settles the call through its bypass, if it has one that answers now. */
    skip: () => boolean
  }
  const queue: Waiter[] = []
  let active = 0
  let lastStart = Number.NEGATIVE_INFINITY
  /**
   * The budget as a theoretical arrival time (GCRA): each start pushes it `refillMs` further, and
   * a start is allowed while it is at most `burst - 1` refills ahead of now. The same as a bucket
   * of `burst` tokens that refills one per `refillMs`, without counting fractions of a token.
   */
  let budgetAt = Number.NEGATIVE_INFINITY
  let sleeping = false

  const budgetWait = (now: number): number => {
    if (budget === undefined) return 0
    return Math.max(budgetAt, now) - (budget.burst - 1) * budget.refillMs - now
  }

  const pump = (): void => {
    for (;;) {
      const next = queue[0]
      if (next === undefined) return
      if (next.skip()) {
        queue.shift()
        continue
      }
      if (active >= concurrency) return
      const now = clock()
      // An injected clock may step back (the default never does): move the pacing state back with
      // it, or the next start would wait out the step.
      if (lastStart > now) {
        const step = lastStart - now
        lastStart -= step
        budgetAt -= step
      }
      const wait = Math.max(lastStart + minIntervalMs - now, budgetWait(now))
      if (wait > 0) {
        if (!sleeping) {
          sleeping = true
          void sleep(wait).then(() => {
            sleeping = false
            pump()
          })
        }
        return
      }
      queue.shift()
      active++
      lastStart = now
      if (budget !== undefined) budgetAt = Math.max(budgetAt, now) + budget.refillMs
      next.start()
    }
  }

  const release = (): void => {
    active--
    pump()
  }

  function run<T>(fn: () => Promise<T>, signal?: AbortSignal, bypass?: Bypass<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const onAbort = (): void => {
        const index = queue.indexOf(waiter)
        if (index === -1) return
        queue.splice(index, 1)
        reject(signal?.reason)
        // The call behind it may be at the front now, and able to bypass.
        pump()
      }
      const settle = (): void => {
        signal?.removeEventListener('abort', onAbort)
      }
      const waiter: Waiter = {
        start: () => {
          settle()
          Promise.resolve()
            .then(fn)
            .then(
              (value) => {
                release()
                resolve(value)
              },
              (error: unknown) => {
                release()
                reject(error)
              },
            )
        },
        fail: (reason) => {
          settle()
          reject(reason)
        },
        skip: () => {
          if (bypass === undefined) return false
          let answer: { value: T } | undefined
          try {
            answer = bypass()
          } catch (error) {
            settle()
            reject(error)
            return true
          }
          if (answer === undefined) return false
          settle()
          resolve(answer.value)
          return true
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
      pump()
    })
  }

  return {
    run,
    rejectWaiting: (reason) => {
      for (const waiter of queue.splice(0)) waiter.fail(reason)
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}
