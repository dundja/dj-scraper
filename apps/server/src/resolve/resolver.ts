import {
  type ResolveRequest,
  type ResolveResult,
  ResolveResultSchema,
  type UrlKind,
  type ValidUrl,
} from '@dj-scraper/shared'
import type { EngineEnv } from '../engine/binaries.ts'
import { run } from '../engine/run.ts'
import { resolveArgs } from '../engine/ytdlp-args.ts'
import { InfoParseError, type Normalized, normalizeInfo } from '../engine/ytdlp-parse.ts'
import { ApiError } from '../http/errors.ts'
import { describeIssues } from '../http/json.ts'
import { checkUrl } from './input.ts'
import { createLimiter } from './limiter.ts'
import { planResolve, type ResolvePlan } from './plan.ts'
import { CANCELED, callYtdlp, findYtdlp, type Logger, since, UNREADABLE } from './ytdlp-call.ts'

/** Each resolve is one yt-dlp process; a burst of pastes shouldn't start dozens. */
export const DEFAULT_MAX_CONCURRENT_RESOLVES = 4

export type ResolverDeps = {
  engine: EngineEnv
  run?: typeof run
  /** Our Node for `--js-runtimes`: `process.execPath`, never user input. */
  jsRuntime?: string
  maxConcurrent?: number
  log?: Logger
}

export type Resolver = {
  /**
   * `POST /api/resolve`: one `yt-dlp -J --flat-playlist` call, normalized and checked against the
   * contract. Throws `ApiError`; aborting `signal` (the browser closed the request) stops yt-dlp.
   */
  resolve: (request: ResolveRequest, signal?: AbortSignal) => Promise<ResolveResult>
}

export function createResolver({
  engine,
  run: runFn = run,
  jsRuntime = process.execPath,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_RESOLVES,
  log = console,
}: ResolverDeps): Resolver {
  const limiter = createLimiter({ concurrency: maxConcurrent })

  async function resolvePlan(
    input: ValidUrl,
    plan: ResolvePlan,
    bin: string,
    signal?: AbortSignal,
  ) {
    const { url, playlist, limit } = plan
    const argv = resolveArgs({ url, playlist, limit, jsRuntime })
    const outcome = await callYtdlp(bin, argv, { run: runFn, timeoutMs: plan.timeoutMs, signal })
    if (!outcome.ok) {
      if (outcome.cause) log.warn(`[resolve] ${input.kind}: ${outcome.cause}`)
      throw new ApiError(outcome.error.code, outcome.error.message)
    }

    let normalized: Normalized
    try {
      normalized = normalizeInfo(outcome.json, { input, limit: plan.limit })
    } catch (error) {
      if (!(error instanceof InfoParseError)) throw error
      log.warn(`[resolve] ${input.kind}: ${error.message}`)
      throw new ApiError(UNREADABLE.code, UNREADABLE.message)
    }

    let result: ResolveResult = normalized
    if (plan.ambiguous) {
      if (normalized.kind !== 'track') {
        log.warn(`[resolve] ${input.kind}: expected one track, got a ${normalized.kind}`)
        throw new ApiError(UNREADABLE.code, UNREADABLE.message)
      }
      result = { kind: 'ambiguous', track: normalized.track, ...plan.ambiguous }
    }

    // yt-dlp is distrusted: whatever the parser let through must still match the contract.
    const checked = ResolveResultSchema.safeParse(result)
    if (!checked.success) {
      log.warn(
        `[resolve] ${input.kind}: off-contract result: ${describeIssues(checked.error.issues)}`,
      )
      throw new ApiError(UNREADABLE.code, UNREADABLE.message)
    }
    return checked.data
  }

  return {
    async resolve(request, signal) {
      const startedAt = performance.now()
      let kind: UrlKind | 'invalid' = 'invalid'
      try {
        const checked = checkUrl(request.url)
        if (!checked.ok) {
          kind = checked.kind
          throw new ApiError(checked.error.code, checked.error.message)
        }
        const { input } = checked
        kind = input.kind
        const plan = planResolve(input, request.mode)
        const bin = await findYtdlp(engine)
        const result = await limiter.run(() => resolvePlan(input, plan, bin, signal), signal)
        log.info(`[resolve] ${kind} → ${summarize(result)} in ${since(startedAt)}`)
        return result
      } catch (error) {
        // A wait for a slot that the client gave up on rejects with the signal's reason.
        const failure =
          !(error instanceof ApiError) && signal?.aborted
            ? new ApiError(CANCELED.code, CANCELED.message)
            : error
        const code = failure instanceof ApiError ? failure.code : 'unknown'
        log.info(`[resolve] ${kind} → ${code} in ${since(startedAt)}`)
        throw failure
      }
    },
  }
}

/** The outcome for the log line: kinds and counts only, never titles or URLs. */
function summarize(result: ResolveResult): string {
  if (result.kind === 'track') return 'track'
  if (result.kind === 'ambiguous') return `ambiguous (${result.collectionKind})`
  const { kind, entries, truncated } = result.collection
  const partial = entries.filter((entry) => entry.partial).length
  return [
    `${kind} of ${entries.length}`,
    ...(partial > 0 ? [`${partial} partial`] : []),
    ...(truncated ? ['truncated'] : []),
  ].join(', ')
}
