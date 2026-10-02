import type { ErrorInfo } from '@dj-scraper/shared'
import { type EngineEnv, locateYtdlp, spawnFailure } from '../engine/binaries.ts'
import { type RunResult, type run, SpawnError } from '../engine/run.ts'
import { mapYtdlpError } from '../engine/ytdlp-errors.ts'
import { ApiError } from '../http/errors.ts'

/** Where resolve services write their one line per call. Never give it URLs or argv. */
export type Logger = Pick<Console, 'info' | 'warn' | 'error'>

/** `1.3 s`: the time since `startedAt` (a `performance.now()` reading), for log lines. */
export function since(startedAt: number): string {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)} s`
}

/** A 5000-row YouTube listing is a few MB of JSON; this only stops a runaway process. */
export const YTDLP_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** The yt-dlp binary, found per call so installing it needs no restart. */
export async function findYtdlp(engine: EngineEnv): Promise<string> {
  const located = await locateYtdlp(engine)
  if (located.kind !== 'found') throw new ApiError('engine_missing', located.message)
  return located.path
}

export type CallOptions = {
  run: typeof run
  timeoutMs: number
  signal?: AbortSignal
  maxOutputBytes?: number
}

/** `cause` is a log-safe detail (no URL, no output) for failures worth investigating. */
export type CallOutcome =
  | { ok: true; json: unknown }
  | { ok: false; error: ErrorInfo; cause?: string }

/**
 * Runs one `yt-dlp -J …` call and reads its JSON. Every failure becomes an `ErrorInfo`, except a
 * binary that can't start, which throws `ApiError('engine_missing')`: no later call would work.
 */
export async function callYtdlp(
  bin: string,
  argv: readonly string[],
  { run: runFn, timeoutMs, signal, maxOutputBytes = YTDLP_MAX_OUTPUT_BYTES }: CallOptions,
): Promise<CallOutcome> {
  let result: RunResult
  try {
    result = await runFn(bin, argv, { timeoutMs, signal, maxOutputBytes })
  } catch (error) {
    if (error instanceof SpawnError) {
      throw new ApiError('engine_missing', spawnFailure('yt-dlp', error.code), { cause: error })
    }
    // run rejects with the signal's reason when the signal was already aborted.
    if (signal?.aborted) return { ok: false, error: CANCELED }
    throw error
  }
  const failure = runFailure(result, timeoutMs)
  if (failure) return failure
  try {
    return { ok: true, json: JSON.parse(result.stdout) }
  } catch {
    // The parser's message quotes stdout, which holds the URL: log only the size.
    return {
      ok: false,
      error: UNREADABLE,
      cause: `stdout is not JSON (${Buffer.byteLength(result.stdout)} bytes)`,
    }
  }
}

export const CANCELED: ErrorInfo = { code: 'canceled', message: 'The request was canceled.' }

/** yt-dlp answered, but not with something we can use. */
export const UNREADABLE: ErrorInfo = {
  code: 'unknown',
  message: 'yt-dlp returned data DJ Scraper could not read. Updating yt-dlp may help.',
}

/** Why a finished run can't be used; undefined when it exited 0 with all of its output. */
export function runFailure(
  result: RunResult,
  timeoutMs: number,
): Extract<CallOutcome, { ok: false }> | undefined {
  if (result.aborted) return { ok: false, error: CANCELED }
  if (result.timedOut) {
    return {
      ok: false,
      error: {
        code: 'network',
        message: `yt-dlp didn't answer within ${Math.round(timeoutMs / 1000)} s.`,
      },
    }
  }
  // Checked before `truncated`: ERROR lines come last, and the collector keeps the tail.
  if (result.exitCode !== 0) {
    const error = mapYtdlpError({ stderr: result.stderr, exitCode: result.exitCode })
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`
    return error.code === 'unknown' ? { ok: false, error, cause: how } : { ok: false, error }
  }
  if (result.truncated) {
    return {
      ok: false,
      error: { code: 'unknown', message: 'yt-dlp printed more data than DJ Scraper accepts.' },
      cause: 'output over the limit',
    }
  }
  return undefined
}
