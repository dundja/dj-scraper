/**
 * A token bucket on call starts: `burst` calls may start at once, then one more per `refillMs`.
 * It is full when created.
 */
export type Budget = { burst: number; refillMs: number }

/**
 * One budget of starts, shared by everything that holds the instance: the enricher's SoundCloud
 * lookups and the download queue's SoundCloud jobs take from the same one (Phase 2 design, D8).
 * Times are milliseconds on one monotonic clock that every holder passes in.
 */
export type TokenBucket = {
  readonly burst: number
  readonly refillMs: number
  /**
   * How long until a start may take a token while leaving `reserve` tokens in the bucket
   * (≤ 0: now). Downloads pass a reserve so lookups for rows in view keep the last tokens.
   */
  waitMs(now: number, reserve?: number): number
  /** Spends a token. Call it when `waitMs` allows a start: taking anyway runs the bucket into debt. */
  take(now: number): void
}

export function createTokenBucket({ burst, refillMs }: Budget): TokenBucket {
  if (!(Number.isSafeInteger(burst) && burst >= 1 && refillMs > 0 && Number.isFinite(refillMs))) {
    throw new RangeError('budget needs a positive integer burst and a positive refillMs')
  }
  /**
   * The budget as a theoretical arrival time (GCRA): each start pushes it `refillMs` further, and
   * a start is allowed while it is at most `burst - 1` refills ahead of now. The same as a bucket
   * of `burst` tokens that refills one per `refillMs`, without counting fractions of a token.
   */
  let arrival = Number.NEGATIVE_INFINITY
  /** The latest `now` seen, to notice an injected clock stepping back. */
  let latest = Number.NEGATIVE_INFINITY

  // An injected clock may step back (the default never does): move the budget back with it, or
  // the next start would wait out the step.
  const follow = (now: number): void => {
    if (now < latest) arrival -= latest - now
    latest = now
  }

  return {
    burst,
    refillMs,
    waitMs(now, reserve = 0) {
      if (!(Number.isSafeInteger(reserve) && reserve >= 0 && reserve < burst)) {
        throw new RangeError(`reserve must be an integer in [0, ${burst}), got ${reserve}`)
      }
      follow(now)
      return Math.max(arrival, now) - (burst - 1 - reserve) * refillMs - now
    },
    take(now) {
      follow(now)
      arrival = Math.max(arrival, now) + refillMs
    },
  }
}
