import { type Budget, createTokenBucket, type TokenBucket } from '../pacing/token-bucket.ts'

export type { Budget } from '../pacing/token-bucket.ts'

/** Resolves after `ms`. Injected so pacing tests can run on a fake clock. */
export type Sleep = (ms: number) => Promise<void>

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Milliseconds on a clock that never steps. Pacing, cooldowns and cache expiry use it rather than
 * `Date.now`, so a wall-clock change (by hand, or a large NTP step) can't stall every queued call
 * for the length of the step, or end a cooldown early.
 */
export const monotonicClock = (): number => performance.now()

export type LimiterOptions = {
  /** At most this many calls run at once. */
  concurrency: number
  /** The least time between two call starts (pacing). Default 0. */
  minIntervalMs?: number
  /**
   * Caps starts over longer stretches than `minIntervalMs`: a `Budget` gets a bucket of its own,
   * full when the limiter is created; a `TokenBucket` instance is shared with its other holders.
   * A waiting call takes the next token in FIFO order among this limiter's calls. Default: none.
   */
  budget?: Budget | TokenBucket
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
  const bucket = budget === undefined || isTokenBucket(budget) ? budget : createTokenBucket(budget)
  type Waiter = {
    start: () => void
    fail: (reason: unknown) => void
    /** Settles the call through its bypass, if it has one that answers now. */
    skip: () => boolean
  }
  const queue: Waiter[] = []
  let active = 0
  let lastStart = Number.NEGATIVE_INFINITY
  let sleeping = false

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
      // An injected clock may step back (the default never does): move the gap back with it, or
      // the next start would wait out the step. The bucket moves its own state back.
      if (lastStart > now) lastStart = now
      // A shared bucket can also be emptied by its other holders while this limiter sleeps: the
      // wait is measured again after every sleep.
      const wait = Math.max(lastStart + minIntervalMs - now, bucket?.waitMs(now) ?? 0)
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
      bucket?.take(now)
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

const isTokenBucket = (budget: Budget | TokenBucket): budget is TokenBucket =>
  'take' in budget && typeof budget.take === 'function'
