import {
  type ErrorCode,
  type PauseCode,
  type Platform,
  type PlatformQueueState,
  PlatformSchema,
  type QueueState,
} from '@dj-scraper/shared'
import type { Budget, TokenBucket } from './token-bucket.ts'

/**
 * Per-platform admission for downloads (Phase 2 design, D8): a token bucket paces starts, and a
 * cooldown pauses a platform that limits us. The queue asks `readyAt` before it starts a job of a
 * platform, `take`s at the start and reports every end with `settled`. Every time is on one
 * monotonic clock that the caller passes in; nothing here reads a clock or arms a timer.
 */
export type Gates = {
  /** When a job of `platform` may start (≤ now: now; Infinity: after a running job settles). */
  readyAt(platform: Platform, now: number): number
  /** A job of `platform` starts now: spends a token and counts it as running. */
  take(platform: Platform, now: number): void
  /**
   * A job started at `startedAt` ended. For a rate limit (or a YouTube bot check):
   * - `strike`: it started after the last cooldown ended, so a new cooldown starts (and doubles);
   * - `inside`: it started before the last cooldown ended, so it is part of that pause (no strike);
   * - `blocked`: a strike that hit the longest cooldown for a bot check the second time in a row:
   *   the block is persistent, so the queue fails the platform's queued jobs.
   * Anything else is `none`.
   */
  settled(
    platform: Platform,
    outcome: 'success' | ErrorCode | 'other',
    startedAt: number,
    now: number,
  ): Verdict
  /** The pauses and pacing waits, as wall-clock instants (`wallNow` is the wall clock at `now`). */
  state(now: number, wallNow: number): QueueState
  /** Called after a pause starts or ends early (a success). Returns the unsubscribe. */
  onChange(listener: () => void): () => void
}

export type Verdict = 'strike' | 'inside' | 'none' | 'blocked'

export type Cooldown = { baseMs: number; maxMs: number }

export type GatesOptions = {
  /** A platform without a bucket is not paced, only paused. */
  buckets: Partial<Record<Platform, TokenBucket>>
  /** The first pause, doubled per consecutive strike up to `maxMs`. Default `DOWNLOAD_COOLDOWN`. */
  cooldown?: Cooldown
  /** Tokens downloads leave in a platform's bucket for its other holders (lookups). */
  downloadReserve?: Partial<Record<Platform, number>>
  /** After a pause, one running job of the platform until one succeeds. Default true. */
  halfOpen?: boolean
}

/** 60 s doubling to 10 min, like the enricher's lookup cooldown. */
export const DOWNLOAD_COOLDOWN: Cooldown = { baseMs: 60_000, maxMs: 10 * 60_000 }
/** About 300 YouTube downloads an hour, after a burst of 10. */
export const YOUTUBE_DOWNLOAD_BUDGET: Budget = { burst: 10, refillMs: 12_000 }
/**
 * SoundCloud downloads share the enricher's lookup bucket (`SOUNDCLOUD_LOOKUP_BUDGET`) and leave
 * it this many tokens, so the rows in view still fill while a long set downloads.
 */
export const SOUNDCLOUD_DOWNLOAD_RESERVE = 5

const PLATFORMS = PlatformSchema.options

type Gate = {
  bucket: TokenBucket | undefined
  reserve: number
  /** Jobs taken and not settled yet. */
  running: number
  /** Consecutive strikes, for the doubling. */
  strikes: number
  /** When the last cooldown ends (or ended). */
  cooldownUntil: number
  pauseCode: PauseCode | undefined
  /** Since the last pause: one running job until a job that started after it succeeds. */
  halfOpen: boolean
  /** Consecutive strikes that were bot checks at the longest cooldown. */
  maxedBotChecks: number
}

export function createGates({
  buckets,
  cooldown = DOWNLOAD_COOLDOWN,
  downloadReserve = {},
  halfOpen: halfOpenEnabled = true,
}: GatesOptions): Gates {
  if (!(cooldown.baseMs > 0 && cooldown.maxMs >= cooldown.baseMs)) {
    throw new RangeError('cooldown needs 0 < baseMs ≤ maxMs')
  }
  const gates = new Map<Platform, Gate>()
  for (const platform of PLATFORMS) {
    const bucket = buckets[platform]
    const reserve = downloadReserve[platform] ?? 0
    if (reserve !== 0 && bucket === undefined) {
      throw new RangeError(`a download reserve for ${platform} needs a bucket`)
    }
    if (
      bucket !== undefined &&
      !(Number.isSafeInteger(reserve) && reserve >= 0 && reserve < bucket.burst)
    ) {
      throw new RangeError(`the ${platform} reserve must be an integer in [0, ${bucket.burst})`)
    }
    gates.set(platform, {
      bucket,
      reserve,
      running: 0,
      strikes: 0,
      cooldownUntil: Number.NEGATIVE_INFINITY,
      pauseCode: undefined,
      halfOpen: false,
      maxedBotChecks: 0,
    })
  }
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const gateOf = (platform: Platform): Gate => {
    const gate = gates.get(platform)
    if (gate === undefined) throw new RangeError(`unknown platform ${String(platform)}`)
    return gate
  }

  const readyAt = (platform: Platform, now: number): number => {
    const gate = gateOf(platform)
    if (halfOpenEnabled && gate.halfOpen && gate.running > 0) return Number.POSITIVE_INFINITY
    const paused = now < gate.cooldownUntil ? gate.cooldownUntil : now
    const wait = gate.bucket?.waitMs(now, gate.reserve) ?? 0
    return Math.max(paused, now + Math.max(0, wait))
  }

  /** Pauses whose strikes the queue charges: a rate limit anywhere, a bot check on YouTube. */
  const pauses = (platform: Platform, outcome: string): outcome is PauseCode =>
    outcome === 'rate_limited' || (outcome === 'bot_check' && platform === 'youtube')

  return {
    readyAt,

    take(platform, now) {
      const gate = gateOf(platform)
      gate.bucket?.take(now)
      gate.running++
    },

    settled(platform, outcome, startedAt, now) {
      const gate = gateOf(platform)
      gate.running = Math.max(0, gate.running - 1)
      if (outcome === 'success') {
        // A job that started before the pause ended proves nothing about the platform now.
        if (startedAt < gate.cooldownUntil) return 'none'
        if (gate.strikes === 0 && !gate.halfOpen && gate.maxedBotChecks === 0) return 'none'
        gate.strikes = 0
        gate.halfOpen = false
        gate.maxedBotChecks = 0
        changed()
        return 'none'
      }
      if (!pauses(platform, outcome)) return 'none'
      if (startedAt < gate.cooldownUntil) return 'inside'
      gate.strikes++
      const ms = Math.min(cooldown.baseMs * 2 ** (gate.strikes - 1), cooldown.maxMs)
      gate.cooldownUntil = now + ms
      gate.pauseCode = outcome
      gate.halfOpen = true
      gate.maxedBotChecks =
        outcome === 'bot_check' && ms >= cooldown.maxMs ? gate.maxedBotChecks + 1 : 0
      changed()
      return gate.maxedBotChecks >= 2 ? 'blocked' : 'strike'
    },

    state(now, wallNow) {
      // Whole seconds, rounded up: the UI counts down in seconds, and the text of an instant then
      // doesn't change with the sub-millisecond drift between the two clocks' samples.
      const wall = (at: number): string =>
        new Date(Math.ceil((wallNow + (at - now)) / 1000) * 1000).toISOString()
      const platforms: PlatformQueueState[] = []
      for (const platform of PLATFORMS) {
        const gate = gateOf(platform)
        const entry: PlatformQueueState = { platform }
        const paused = now < gate.cooldownUntil
        if (paused) {
          entry.pausedUntil = wall(gate.cooldownUntil)
          if (gate.pauseCode !== undefined) entry.pauseCode = gate.pauseCode
        }
        const ready = readyAt(platform, now)
        // A start the pause alone holds back is said by pausedUntil.
        if (Number.isFinite(ready) && ready > now && !(paused && ready <= gate.cooldownUntil)) {
          entry.nextStartAt = wall(ready)
        }
        if (entry.pausedUntil !== undefined || entry.nextStartAt !== undefined) {
          platforms.push(entry)
        }
      }
      return { platforms }
    },

    onChange(listener) {
      // A wrapper per call, so subscribing the same function twice needs two unsubscribes.
      const entry = () => listener()
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
  }
}
