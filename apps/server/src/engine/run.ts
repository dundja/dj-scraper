import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/**
 * The only module that spawns processes (see apps/server/CLAUDE.md).
 *
 * - argv only, `shell: false`, stdin is /dev/null.
 * - `detached: true` puts the child in its own process group, so stopping it also stops
 *   whatever it started (yt-dlp → ffmpeg). Stopping is SIGINT to the group, then SIGKILL
 *   after `killGraceMs`. SIGTERM is never used: yt-dlp has no handler and ffmpeg can orphan.
 * - Detached children do NOT get the terminal's Ctrl-C and survive a crash of this server,
 *   so shutdown must abort every run and await it.
 *
 * Settling rules:
 * - Rejects only when no process could be started (`SpawnError`, or `signal.reason` when the
 *   signal is already aborted), or when a line callback throws (after the group is stopped).
 * - Otherwise resolves once the child's stdio has closed, so the process group is gone (or was
 *   SIGKILLed) and every line callback has run. Callers may then delete the job dir.
 */

const STOP_SIGNAL: NodeJS.Signals = 'SIGINT'
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** A line longer than this (UTF-16 units) is passed on in pieces instead of buffering forever. */
const MAX_LINE_LENGTH = 8 * 1024 * 1024

/** Process groups whose stdio hasn't closed yet. */
const activeGroups = new Set<number>()

/**
 * Last resort: SIGKILL every group still running. Synchronous, so it works in
 * `process.on('exit')` (uncaught exception, process.exit) and in test teardown.
 * Graceful shutdown should abort runs and await them first.
 */
export function killActiveGroups(): void {
  for (const pid of activeGroups) killGroup(pid, 'SIGKILL')
}

export interface RunOptions {
  /** A missing cwd is reported by Node as ENOENT on `bin`. Check the dir first. */
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Stops the process group after this many ms (finite, at most 2^31-1); then `timedOut: true`. */
  timeoutMs?: number
  /** Aborting stops the process group; the promise still waits until it is gone. */
  signal?: AbortSignal
  /** Delay between SIGINT and SIGKILL to the group. Default 5 s. */
  killGraceMs?: number
  /** Called per line of stdout (`\n`, `\r\n` or a lone `\r` ends a line). */
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** Per-stream cap on collected output. The oldest bytes go first (ERROR lines come last). */
  maxOutputBytes?: number
}

export interface RunResult {
  pid: number
  /** Null when the child was ended by a signal. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** Output went over `maxOutputBytes`; `stdout`/`stderr` hold only the tail. */
  truncated: boolean
  /** Stopped by `timeoutMs`, or by `signal` aborting with a TimeoutError (AbortSignal.timeout). */
  timedOut: boolean
  /** Stopped by `signal` for any other reason. */
  aborted: boolean
  durationMs: number
}

/** The process could not be started. `code` is the errno name: ENOENT, EACCES, ENOEXEC, E2BIG… */
export class SpawnError extends Error {
  readonly code: string
  readonly bin: string

  constructor(bin: string, cause: unknown) {
    const code = errnoCode(cause) ?? 'UNKNOWN'
    super(`Cannot start ${bin}: ${code}`, { cause })
    this.name = 'SpawnError'
    this.code = code
    this.bin = bin
  }
}

export async function run(
  bin: string,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { signal } = options
  signal?.throwIfAborted()

  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(bin, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    // ENOEXEC (script without a shebang), E2BIG and invalid args throw synchronously.
    throw new SpawnError(bin, error)
  }

  const { pid } = child
  if (pid === undefined) {
    // ENOENT and EACCES (and a missing cwd) arrive as an 'error' event on the next tick.
    return new Promise((_resolve, reject) => {
      child.once('error', (error) => reject(new SpawnError(bin, error)))
    })
  }

  activeGroups.add(pid)
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    let timedOut = false
    let aborted = false
    let stopping = false
    let closed = false
    let callbackError: { error: unknown } | undefined
    let timeoutTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let orphanTimer: NodeJS.Timeout | undefined

    const stop = (): void => {
      if (stopping || closed) return
      stopping = true
      killGroup(pid, STOP_SIGNAL)
      killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), killGraceMs)
    }

    const guard = (onLine: ((line: string) => void) | undefined) => {
      if (!onLine) return undefined
      return (line: string): void => {
        if (callbackError) return
        try {
          onLine(line)
        } catch (error) {
          callbackError = { error }
          stop()
        }
      }
    }

    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const stdout = createCollector(maxBytes, guard(options.onStdoutLine))
    const stderr = createCollector(maxBytes, guard(options.onStderrLine))
    child.stdout.on('data', stdout.push)
    child.stderr.on('data', stderr.push)

    const onAbort = (): void => {
      if (isTimeoutError(signal?.reason)) timedOut = true
      else aborted = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // setTimeout turns Infinity (and anything over 2^31-1 ms) into 1 ms, so arm only finite limits.
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        stop()
      }, options.timeoutMs)
    }

    // Spawn succeeded, so 'error' can only come from child.kill()/IPC, which we don't use.
    // A listener is still required: an unhandled 'error' event would crash the server.
    child.on('error', () => {})

    child.once('exit', () => {
      // The leader is gone but something in its group still holds our pipes ('close' waits for
      // it). Give it the grace period, then kill the group so the run cannot hang.
      orphanTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), killGraceMs)
    })

    child.once('close', (exitCode, exitSignal) => {
      closed = true
      activeGroups.delete(pid)
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      clearTimeout(orphanTimer)
      signal?.removeEventListener('abort', onAbort)
      // After a stop, sweep group members that don't hold our pipes (ignored if none are left).
      if (stopping) killGroup(pid, 'SIGKILL')
      stdout.end()
      stderr.end()

      if (callbackError) {
        reject(callbackError.error)
        return
      }
      resolve({
        pid,
        exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated() || stderr.truncated(),
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - startedAt),
      })
    })
  })
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // ESRCH: the group is gone. EPERM: macOS reports it while the group holds only a zombie.
    const code = errnoCode(error)
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isTimeoutError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError'
}

interface Collector {
  push: (chunk: Buffer) => void
  /** Flushes the last unterminated line. Call once, after the stream has ended. */
  end: () => void
  text: () => string
  truncated: () => boolean
}

function createCollector(maxBytes: number, onLine?: (line: string) => void): Collector {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  const lines = onLine ? createLineSplitter(onLine) : undefined

  return {
    push(chunk) {
      lines?.push(chunk)
      chunks.push(chunk)
      size += chunk.length
      while (size > maxBytes) {
        const head = chunks[0]
        if (head === undefined) break
        truncated = true
        const excess = size - maxBytes
        if (head.length <= excess) {
          chunks.shift()
          size -= head.length
        } else {
          chunks[0] = head.subarray(excess)
          size -= excess
        }
      }
    },
    end() {
      lines?.end()
    },
    text() {
      let bytes = Buffer.concat(chunks, size)
      if (truncated) {
        // The cut may land inside a UTF-8 character: drop its continuation bytes (10xxxxxx).
        let start = 0
        while (start < 3 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
        bytes = bytes.subarray(start)
      }
      return bytes.toString('utf8')
    },
    truncated: () => truncated,
  }
}

const LF = 0x0a
const CR = 0x0d

/** Splits on `\n`, `\r\n` and lone `\r` (ffmpeg stats), across chunk and UTF-8 boundaries. */
function createLineSplitter(onLine: (line: string) => void) {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  let skipLf = false

  const split = (text: string): void => {
    if (text === '') return
    let start = 0
    if (skipLf && text.charCodeAt(0) === LF) start = 1
    skipLf = false
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c !== LF && c !== CR) continue
      onLine(partial + text.slice(start, i))
      partial = ''
      if (c === CR) {
        if (i + 1 === text.length) skipLf = true
        else if (text.charCodeAt(i + 1) === LF) i++
      }
      start = i + 1
    }
    partial += text.slice(start)
    if (partial.length > MAX_LINE_LENGTH) {
      onLine(partial)
      partial = ''
    }
  }

  return {
    push: (chunk: Buffer): void => split(decoder.write(chunk)),
    end: (): void => {
      split(decoder.end())
      if (partial !== '') onLine(partial)
      partial = ''
    },
  }
}
