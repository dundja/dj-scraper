import {
  type EntryResult,
  type ErrorCode,
  type ErrorInfo,
  MAX_ENTRIES_PER_REQUEST,
  type Platform,
  type ResolveEntriesRequest,
  type ResolveEntriesResponse,
  type Track,
  TrackSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import type { EngineEnv } from '../engine/binaries.ts'
import { run } from '../engine/run.ts'
import { entryArgs } from '../engine/ytdlp-args.ts'
import { InfoParseError, normalizeEntry } from '../engine/ytdlp-parse.ts'
import { ApiError } from '../http/errors.ts'
import { describeIssues } from '../http/json.ts'
import { checkUrl } from './input.ts'
import {
  type Budget,
  createLimiter,
  defaultSleep,
  type Limiter,
  monotonicClock,
  type Sleep,
} from './limiter.ts'
import { createTtlCache } from './lru.ts'
import { CANCELED, callYtdlp, findYtdlp, type Logger, since, UNREADABLE } from './ytdlp-call.ts'

/**
 * How many lookups may run at once per platform, the least time between their starts, and an
 * optional budget of starts over longer stretches (see `SOUNDCLOUD_LOOKUP_BUDGET`).
 */
export type PacingRule = { concurrency: number; minIntervalMs: number; budget?: Budget }
export type Pacing = Record<Platform, PacingRule>

/**
 * SoundCloud allows about 600 API requests per 10 minutes, and one lookup costs 3-5 of them
 * (measured 2026-10-02: test/fixtures/soundcloud/README.md, "Entry lookup cost"). Two at a time
 * and one start per second alone would allow 60 lookups a minute: 180-300 requests. So lookups also
 * take a token from this bucket. A full bucket lets a screenful (`MAX_ENTRIES_PER_REQUEST`, 25 rows,
 * plus the tokens that refill meanwhile) start at the 1 s pace; after that, one lookup per 5 s. That
 * sustains 120 lookups per 10 minutes, 360-600 requests; a 10-minute window that begins with a full
 * bucket fits 145 (up to 725 requests at 5 each).
 * Listings (`POST /api/resolve`) spend a few requests outside this budget. Whatever still goes over
 * meets the rate-limit cooldown below. Rows wait for a token; they never fail for the lack of one.
 */
export const SOUNDCLOUD_LOOKUP_BUDGET: Budget = { burst: MAX_ENTRIES_PER_REQUEST, refillMs: 5000 }

/** Shared by all requests, so parallel batches can't add up. */
export const DEFAULT_PACING: Pacing = {
  soundcloud: { concurrency: 2, minIntervalMs: 1000, budget: SOUNDCLOUD_LOOKUP_BUDGET },
  youtube: { concurrency: 2, minIntervalMs: 500 },
  other: { concurrency: 2, minIntervalMs: 500 },
}

export const ENTRY_TIMEOUT_MS = 60_000
/** A full single-track JSON (formats included) is well under 1 MB. */
const ENTRY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const DEFAULT_CACHE_TTL_MS = 30 * 60_000
export const DEFAULT_CACHE_MAX = 2000
/** The first rate limit pauses a platform this long; each consecutive one doubles it. */
export const COOLDOWN_BASE_MS = 60_000
export const COOLDOWN_MAX_MS = 10 * 60_000

const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  other: 'The site',
}

export type EnricherDeps = {
  engine: EngineEnv
  run?: typeof run
  /** Our Node for `--js-runtimes`: `process.execPath`, never user input. */
  jsRuntime?: string
  /** Pacing, cooldowns and cache expiry. Default `monotonicClock`. */
  clock?: () => number
  sleep?: Sleep
  pacing?: Pacing
  cacheTtlMs?: number
  cacheMax?: number
  log?: Logger
}

export type Enricher = {
  /**
   * `POST /api/resolve/entries`: a full Track per partial row, one result per distinct
   * platform + id in first-seen order. A row fails on its own (removed track, rate limit); the
   * whole request fails only when yt-dlp can't run (`engine_missing`) or `signal` aborts
   * (`canceled`: its rows stop waiting, and lookups no other request waits for are stopped).
   */
  enrich: (request: ResolveEntriesRequest, signal?: AbortSignal) => Promise<ResolveEntriesResponse>
}

type PlatformState = {
  limiter: Limiter
  /** Lookups for this platform fail at once until then (on `clock`). */
  cooldownUntil: number
  /** Consecutive rate limits, for the doubling. */
  strikes: number
}

/** Rejects the rows waiting for a platform that just went into cooldown. */
class CooldownError extends Error {
  override name = 'CooldownError'
}

/** A distinct requested row. Its result echoes the request's platform + id, which the web merges on. */
type Row = { platform: Platform; id: string; url: string }

/**
 * What a row's lookup works on. The platform comes from classifying the row's URL, not from the
 * request: a row is paced, cooled down and cached by the site its lookup actually goes to.
 */
type Target = { key: string; platform: Platform; input: ValidUrl }

/** What one lookup comes to; every request that asked for the row shares it. */
type Outcome = { ok: true; track: Track } | { ok: false; error: ErrorInfo }

/** A lookup in progress. Later requests for the same row join it instead of starting another. */
type InFlight = {
  outcome: Promise<Outcome>
  /** Stops the lookup: aborted once every request waiting on it has gone away. */
  controller: AbortController
  waiters: number
}

export function createEnricher({
  engine,
  run: runFn = run,
  jsRuntime = process.execPath,
  clock = monotonicClock,
  sleep = defaultSleep,
  pacing = DEFAULT_PACING,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheMax = DEFAULT_CACHE_MAX,
  log = console,
}: EnricherDeps): Enricher {
  const cache = createTtlCache<Track>({ ttlMs: cacheTtlMs, max: cacheMax, clock })
  const platforms = new Map<Platform, PlatformState>()
  const inFlight = new Map<string, InFlight>()

  const stateOf = (platform: Platform): PlatformState => {
    let state = platforms.get(platform)
    if (state === undefined) {
      state = {
        limiter: createLimiter({ ...pacing[platform], clock, sleep }),
        cooldownUntil: 0,
        strikes: 0,
      }
      platforms.set(platform, state)
    }
    return state
  }

  /** The error for a row of a platform in cooldown, saying when to retry; else undefined. */
  const cooldownError = (platform: Platform): ErrorInfo | undefined => {
    const remaining = stateOf(platform).cooldownUntil - clock()
    if (remaining <= 0) return undefined
    return {
      code: 'rate_limited',
      message: `${PLATFORM_NAMES[platform]} is limiting requests. Try again in ${formatWait(remaining)}.`,
    }
  }

  const startCooldown = (platform: Platform): void => {
    const state = stateOf(platform)
    const now = clock()
    // Lookups that were already running when the cooldown began don't double it.
    if (now < state.cooldownUntil) return
    state.strikes++
    const ms = Math.min(COOLDOWN_BASE_MS * 2 ** (state.strikes - 1), COOLDOWN_MAX_MS)
    state.cooldownUntil = now + ms
    log.warn(`[resolve/entries] ${platform} is rate-limiting: pausing lookups for ${ms / 1000} s`)
    state.limiter.rejectWaiting(new CooldownError(platform))
  }

  /** The key comes from the request: quoted, so it can't forge or break a log line. */
  const warn = (target: Target, detail: string) =>
    log.warn(`[resolve/entries] ${JSON.stringify(target.key)}: ${detail}`)

  async function lookup(target: Target, bin: string, signal: AbortSignal): Promise<Outcome> {
    const argv = entryArgs({ url: target.input.url, jsRuntime })
    const outcome = await callYtdlp(bin, argv, {
      run: runFn,
      timeoutMs: ENTRY_TIMEOUT_MS,
      signal,
      maxOutputBytes: ENTRY_MAX_OUTPUT_BYTES,
    })
    if (!outcome.ok) {
      if (outcome.error.code === 'rate_limited') startCooldown(target.platform)
      if (outcome.cause) warn(target, outcome.cause)
      return { ok: false, error: outcome.error }
    }

    let track: Track
    try {
      track = normalizeEntry(outcome.json, target.input)
    } catch (error) {
      if (!(error instanceof InfoParseError)) throw error
      warn(target, error.message)
      return { ok: false, error: UNREADABLE }
    }
    const checked = TrackSchema.safeParse(track)
    if (!checked.success) {
      warn(target, `off-contract track: ${describeIssues(checked.error.issues)}`)
      return { ok: false, error: UNREADABLE }
    }

    cache.set(target.key, checked.data)
    const state = stateOf(target.platform)
    if (clock() >= state.cooldownUntil) state.strikes = 0
    return { ok: true, track: checked.data }
  }

  /** Locates yt-dlp, waits for the platform's pacing, then looks the row up. */
  async function paced(
    target: Target,
    bin: () => Promise<string>,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const path = await bin()
    try {
      return await stateOf(target.platform).limiter.run<Outcome>(
        () => lookup(target, path, signal),
        signal,
        () => {
          // Filled, or a cooldown begun, before its turn came: start nothing, spend no pacing.
          const fresh = cache.get(target.key)
          if (fresh) return { value: { ok: true, track: fresh } }
          const cooling = cooldownError(target.platform)
          return cooling ? { value: { ok: false, error: cooling } } : undefined
        },
      )
    } catch (error) {
      if (error instanceof CooldownError) {
        return { ok: false, error: cooldownError(target.platform) ?? RATE_LIMITED }
      }
      // Dropped from the queue because every request that wanted the row went away.
      if (signal.aborted && !(error instanceof ApiError)) return { ok: false, error: CANCELED }
      throw error
    }
  }

  /** The row's lookup in progress, or a new one. */
  function shared(target: Target, bin: () => Promise<string>): InFlight {
    const running = inFlight.get(target.key)
    if (running) return running
    const controller = new AbortController()
    const flight: InFlight = {
      outcome: paced(target, bin, controller.signal),
      controller,
      waiters: 0,
    }
    inFlight.set(target.key, flight)
    const forget = () => {
      if (inFlight.get(target.key) === flight) inFlight.delete(target.key)
    }
    // Also marks a rejection as handled when nobody waits for it any more.
    flight.outcome.then(forget, forget)
    return flight
  }

  /**
   * Waits for a shared lookup on behalf of one request. When `signal` aborts, the request stops
   * waiting (`canceled`), and the lookup stops once no request waits for it.
   */
  function follow(flight: InFlight, key: string, signal: AbortSignal): Promise<Outcome> {
    flight.waiters++
    return new Promise<Outcome>((resolve, reject) => {
      let left = false
      const leave = (): boolean => {
        if (left) return false
        left = true
        flight.waiters--
        signal.removeEventListener('abort', onAbort)
        return true
      }
      const onAbort = (): void => {
        if (!leave()) return
        if (flight.waiters === 0) {
          // A later request for the row starts afresh instead of joining a stopped lookup.
          if (inFlight.get(key) === flight) inFlight.delete(key)
          flight.controller.abort(signal.reason)
        }
        resolve({ ok: false, error: CANCELED })
      }
      flight.outcome.then(
        (outcome) => {
          if (leave()) resolve(outcome)
        },
        (error: unknown) => {
          if (leave()) reject(error)
        },
      )
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function enrichRow(
    row: Row,
    bin: () => Promise<string>,
    signal: AbortSignal,
  ): Promise<EntryResult> {
    const checked = checkUrl(row.url)
    if (!checked.ok) return failed(row, checked.error)
    const { input } = checked
    if (input.guess === 'collection') return failed(row, NOT_A_TRACK)
    const target: Target = { key: `${input.platform}:${row.id}`, platform: input.platform, input }
    const cached = cache.get(target.key)
    if (cached) return filled(row, cached)
    const cooling = cooldownError(target.platform)
    if (cooling) return failed(row, cooling)

    const outcome = await follow(shared(target, bin), target.key, signal)
    return outcome.ok ? filled(row, outcome.track) : failed(row, outcome.error)
  }

  return {
    async enrich(request, signal) {
      const startedAt = performance.now()
      const rows = new Map<string, Row>()
      for (const { platform, id, url } of request.entries) {
        const key = `${platform}:${id}`
        if (!rows.has(key)) rows.set(key, { platform, id, url })
      }
      const label = `[resolve/entries] ${rows.size} row${rows.size === 1 ? '' : 's'}`

      // Aborts when the client goes away or this request fails as a whole: stops its waiting.
      const failure = new AbortController()
      const scope = signal ? AbortSignal.any([signal, failure.signal]) : failure.signal
      let located: Promise<string> | undefined
      const bin = () => {
        located ??= findYtdlp(engine)
        return located
      }

      try {
        if (signal?.aborted) throw new ApiError(CANCELED.code, CANCELED.message)
        const results = await Promise.all(
          [...rows.values()].map((row) => enrichRow(row, bin, scope)),
        )
        if (signal?.aborted) throw new ApiError(CANCELED.code, CANCELED.message)
        log.info(`${label} → ${summarize(results)} in ${since(startedAt)}`)
        return { results }
      } catch (error) {
        failure.abort(error)
        const code = error instanceof ApiError ? error.code : 'unknown'
        log.info(`${label} → ${code} in ${since(startedAt)}`)
        throw error
      }
    },
  }
}

/** Only track rows are partial: a list URL here is a client bug, and looking it up would list it. */
const NOT_A_TRACK: ErrorInfo = {
  code: 'invalid_request',
  message: 'This link is a list, not a track: resolve it instead.',
}

const RATE_LIMITED: ErrorInfo = {
  code: 'rate_limited',
  message: 'Too many requests. Try again later.',
}

function filled(row: Row, track: Track): EntryResult {
  return { status: 'ok', platform: row.platform, id: row.id, track }
}

function failed(row: Row, error: ErrorInfo): EntryResult {
  return { status: 'error', platform: row.platform, id: row.id, error }
}

/** Rounded up to whole seconds first, so 59.999 s reads "1 minute", never "60 s". */
function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/** `20 ok, 5 failed (rate_limited 3, unavailable 2)`: counts and codes only. */
function summarize(results: readonly EntryResult[]): string {
  const codes = new Map<ErrorCode, number>()
  let ok = 0
  for (const result of results) {
    if (result.status === 'ok') ok++
    else codes.set(result.error.code, (codes.get(result.error.code) ?? 0) + 1)
  }
  const failedCount = results.length - ok
  if (failedCount === 0) return `${ok} ok`
  const detail = [...codes].map(([code, count]) => `${code} ${count}`).join(', ')
  return `${ok} ok, ${failedCount} failed (${detail})`
}
