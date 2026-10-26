import {
  type ErrorInfo,
  REMIX_PLATFORMS,
  type RemixPlatform,
  type RemixRequest,
  type RemixSearchStatus,
  type RemixSuggestions,
  RemixSuggestionsSchema,
} from '@dj-scraper/shared'
import type { EngineEnv } from '../engine/binaries.ts'
import { run } from '../engine/run.ts'
import { searchArgs } from '../engine/ytdlp-args.ts'
import { ApiError } from '../http/errors.ts'
import { describeIssues } from '../http/json.ts'
import type { TokenBucket } from '../pacing/token-bucket.ts'
import { type Budget, createLimiter, type Limiter } from '../resolve/limiter.ts'
import { createTtlCache } from '../resolve/lru.ts'
import { CANCELED, callYtdlp, findYtdlp, type Logger, since } from '../resolve/ytdlp-call.ts'
import {
  parseSearchResults,
  type RemixCandidate,
  remixQuery,
  SEARCH_COUNTS,
  type Song,
  songOf,
  suggestRemixes,
} from './suggest.ts'

/**
 * `POST /api/remixes` (ADR-027): one search per platform for the song's remixes, run through yt-dlp
 * like a resolve, then `suggestRemixes`. A platform's search is shared by every request that waits
 * for it and cached for 30 minutes, so the web's YouTube-first request and its full one search
 * YouTube once, and a paste of the same song searches nothing.
 */

export const SEARCH_TIMEOUT_MS = 60_000
/** A search of 30 results is under 200 kB of JSON. */
const SEARCH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const REMIX_CACHE_TTL_MS = 30 * 60_000
const REMIX_CACHE_MAX = 200

export type RemixFinderDeps = {
  engine: EngineEnv
  run?: typeof run
  /** Finds the yt-dlp binary per request, or throws `ApiError('engine_missing')`. */
  locate?: (engine: EngineEnv) => Promise<string>
  /** Our Node for `--js-runtimes`: `process.execPath`, never user input. */
  jsRuntime?: string
  /**
   * SoundCloud's budget: the bucket the enricher's lookups and the SoundCloud downloads share
   * (ADR-017), so a search takes a token like a lookup.
   */
  soundcloudBudget?: Budget | TokenBucket
  clock?: () => number
  log?: Logger
}

export type RemixFinder = {
  /**
   * Remix suggestions for the request's song. Throws `ApiError`: `invalid_request` when the title
   * has no word to search for, `engine_missing`, `canceled` when `signal` aborts. A failed search
   * is reported in `searches`, never thrown.
   */
  find: (request: RemixRequest, signal?: AbortSignal) => Promise<RemixSuggestions>
}

type SearchOutcome = { ok: true; candidates: RemixCandidate[] } | { ok: false; error: ErrorInfo }

/** A search in flight: its waiters, and the controller that stops it once none is left. */
type Flight = { promise: Promise<SearchOutcome>; waiters: number; controller: AbortController }

export function createRemixFinder({
  engine,
  run: runFn = run,
  locate = findYtdlp,
  jsRuntime = process.execPath,
  soundcloudBudget,
  clock,
  log = console,
}: RemixFinderDeps): RemixFinder {
  // One search at a time per platform: a burst of pastes queues instead of starting a dozen.
  const limiters: Record<RemixPlatform, Limiter> = {
    youtube: createLimiter({ concurrency: 1, ...(clock ? { clock } : {}) }),
    soundcloud: createLimiter({
      concurrency: 1,
      minIntervalMs: 1000,
      ...(soundcloudBudget ? { budget: soundcloudBudget } : {}),
      ...(clock ? { clock } : {}),
    }),
  }
  const cache = createTtlCache<RemixCandidate[]>({
    ttlMs: REMIX_CACHE_TTL_MS,
    max: REMIX_CACHE_MAX,
    ...(clock ? { clock } : {}),
  })
  const flights = new Map<string, Flight>()

  /** One yt-dlp search, after its platform's limiter lets it start. */
  async function search(
    platform: RemixPlatform,
    query: string,
    bin: () => Promise<string>,
    signal: AbortSignal,
  ): Promise<SearchOutcome> {
    // Before the limiter: a missing yt-dlp spends no SoundCloud token.
    const path = await bin()
    const argv = searchArgs({ query, count: SEARCH_COUNTS[platform], jsRuntime, site: platform })
    const result = await limiters[platform].run(
      () =>
        callYtdlp(path, argv, {
          run: runFn,
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal,
          maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES,
        }),
      signal,
    )
    if (!result.ok) {
      if (result.cause) log.warn(`[remixes] ${platform}: the search failed: ${result.cause}`)
      return { ok: false, error: result.error }
    }
    return { ok: true, candidates: parseSearchResults(platform, result.json) }
  }

  /**
   * The platform's results for `query`: cached, or the search in flight, or a new one. The search
   * stops when every request waiting for it has gone; a request that goes gets `canceled`.
   */
  function shared(
    platform: RemixPlatform,
    query: string,
    bin: () => Promise<string>,
    signal?: AbortSignal,
  ): Promise<SearchOutcome> {
    const key = `${platform}\n${query}`
    const cached = cache.get(key)
    if (cached !== undefined) return Promise.resolve({ ok: true, candidates: cached })
    // A request that has already gone starts nothing: no process, no SoundCloud token.
    if (signal?.aborted) return Promise.resolve({ ok: false, error: CANCELED })

    let flight = flights.get(key)
    // A stopped search may still be exiting: a new request gets a search of its own, not its
    // `canceled` (React's StrictMode sends a request, aborts it and sends it again at once).
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const promise = search(platform, query, bin, controller.signal)
        .catch((error: unknown): SearchOutcome => {
          // The limiter rejects a wait that was aborted with the signal's reason.
          if (controller.signal.aborted) return { ok: false, error: CANCELED }
          throw error
        })
        .then((outcome) => {
          if (outcome.ok) cache.set(key, outcome.candidates)
          return outcome
        })
        .finally(() => {
          if (flights.get(key) === created) flights.delete(key)
        })
      const created: Flight = { promise, waiters: 0, controller }
      flight = created
      flights.set(key, created)
    }

    const current = flight
    current.waiters++
    return new Promise<SearchOutcome>((resolve, reject) => {
      let settled = false
      const leave = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        current.waiters--
      }
      const onAbort = () => {
        leave()
        if (current.waiters === 0) current.controller.abort()
        resolve({ ok: false, error: CANCELED })
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      current.promise.then(
        (outcome) => {
          if (settled) return
          leave()
          resolve(outcome)
        },
        (error: unknown) => {
          if (settled) return
          leave()
          reject(error)
        },
      )
    })
  }

  return {
    async find(request, signal) {
      const startedAt = performance.now()
      const song = songOf(request)
      if (song === undefined) {
        throw new ApiError('invalid_request', 'The title has no words to search for remixes of.')
      }
      const platforms = new Set(request.platforms ?? REMIX_PLATFORMS)
      const query = remixQuery(song)
      // Found once, and only when a search has to start: a cached answer needs no yt-dlp.
      let located: Promise<string> | undefined
      const bin = () => {
        located ??= locate(engine)
        return located
      }
      // This request's own signal: when one platform's search throws, the other's is left too,
      // so it stops if no other request waits for it.
      const scope = new AbortController()
      const leave = () => scope.abort()
      signal?.addEventListener('abort', leave, { once: true })
      if (signal?.aborted) leave()
      let outcomes: (SearchOutcome | undefined)[]
      try {
        outcomes = await Promise.all(
          REMIX_PLATFORMS.map((platform) =>
            platforms.has(platform) ? shared(platform, query, bin, scope.signal) : undefined,
          ),
        )
      } finally {
        signal?.removeEventListener('abort', leave)
        leave()
      }
      if (signal?.aborted) throw new ApiError(CANCELED.code, CANCELED.message)

      const results: Partial<Record<RemixPlatform, RemixCandidate[]>> = {}
      const statuses = {} as Record<RemixPlatform, RemixSearchStatus>
      REMIX_PLATFORMS.forEach((platform, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined) statuses[platform] = { status: 'skipped' }
        else if (!outcome.ok) statuses[platform] = { status: 'error', error: outcome.error }
        else results[platform] = outcome.candidates
      })
      const { suggestions, found } = suggestRemixes(song, results, request.exclude)
      for (const platform of REMIX_PLATFORMS) {
        statuses[platform] ??= { status: 'ok', found: found[platform] }
      }
      const answer = { song: songText(song), suggestions, searches: statuses }

      // yt-dlp is distrusted: whatever the parser let through must still match the contract.
      const checked = RemixSuggestionsSchema.safeParse(answer)
      if (!checked.success) {
        log.warn(`[remixes] off-contract answer: ${describeIssues(checked.error.issues)}`)
        throw new ApiError('unknown', 'yt-dlp returned data DJ Scraper could not read.')
      }
      log.info(`[remixes] ${summarize(statuses)} → ${suggestions.length} in ${since(startedAt)}`)
      return checked.data
    },
  }
}

function songText({ title, artist }: Song): RemixSuggestions['song'] {
  return artist === undefined ? { title } : { title, artist }
}

/** Per platform: its count of versions found, or its error code. Never titles or queries. */
function summarize(statuses: Record<RemixPlatform, RemixSearchStatus>): string {
  return REMIX_PLATFORMS.map((platform) => {
    const status = statuses[platform]
    if (status.status === 'ok') return `${platform} ${status.found}`
    if (status.status === 'error') return `${platform} ${status.error.code}`
    return `${platform} skipped`
  }).join(', ')
}
