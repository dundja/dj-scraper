// Boots the real entry (`node src/index.ts`, what `pnpm start` runs, minus --open) as a child
// process, for the tests that need the whole server process: boot.test.ts and lifecycle.test.ts.
// Not a test file. helpers.ts stays free of src/ imports, which is why this lives on its own.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { LOCK_FILE, type LockHolder } from '../src/data-dir.ts'
import { type RunResult, run } from '../src/engine/run.ts'
import { SERVER_DIR } from './helpers.ts'

export type EntryStream = 'stdout' | 'stderr'

export type Entry = {
  /** Settles once the server has exited (run(): its process group is gone too). */
  done: Promise<RunResult>
  /** Every line so far, per stream. */
  lines: Record<EntryStream, string[]>
  /** The first line on `stream` matching `pattern`; rejects if the process ends without one. */
  waitForLine: (stream: EntryStream, pattern: RegExp) => Promise<string>
  /** Ctrl-C: SIGINT to the server's process group, then waits until it has exited. */
  stop: () => Promise<RunResult & { stopMs: number }>
}

/**
 * Starts the server entry through run(): in its own process group, which `killActiveGroups()`
 * stops in teardown. `env` is the server's whole environment.
 */
export function bootEntry(env: NodeJS.ProcessEnv, args: readonly string[] = []): Entry {
  const controller = new AbortController()
  const lines: Record<EntryStream, string[]> = { stdout: [], stderr: [] }
  const waiters: { stream: EntryStream; pattern: RegExp; resolve: (line: string) => void }[] = []
  const onLine = (stream: EntryStream) => (line: string) => {
    lines[stream].push(line)
    for (const waiter of waiters) {
      if (waiter.stream === stream && waiter.pattern.test(line)) waiter.resolve(line)
    }
  }
  const done = run(process.execPath, ['src/index.ts', ...args], {
    cwd: SERVER_DIR,
    env,
    signal: controller.signal,
    onStdoutLine: onLine('stdout'),
    onStderrLine: onLine('stderr'),
  })

  const waitForLine = (stream: EntryStream, pattern: RegExp): Promise<string> => {
    const seen = lines[stream].find((line) => pattern.test(line))
    if (seen !== undefined) return Promise.resolve(seen)
    return Promise.race([
      new Promise<string>((resolve) => waiters.push({ stream, pattern, resolve })),
      done.then((result) => {
        throw new Error(
          `server exited (${result.exitCode ?? result.signal}) before printing ${pattern} on ${stream}:\n${result.stdout}${result.stderr}`,
        )
      }),
    ])
  }

  const stop = async (): Promise<RunResult & { stopMs: number }> => {
    const startedAt = performance.now()
    controller.abort()
    const result = await done
    return { ...result, stopMs: performance.now() - startedAt }
  }

  return { done, lines, waitForLine, stop }
}

/** The line the server prints once it listens. */
export const listeningLine = (port: number, dev = false): RegExp =>
  new RegExp(
    `^\\[server\\] DJ Scraper on http://127\\.0\\.0\\.1:${port}${dev ? ' \\(dev\\)' : ''}$`,
  )

/** What `<dataDir>/server.lock` says about the server holding it (its pid, then its port). */
export async function lockHolder(dataDir: string): Promise<LockHolder> {
  const record: unknown = JSON.parse(await readFile(path.join(dataDir, LOCK_FILE), 'utf8'))
  if (
    typeof record !== 'object' ||
    record === null ||
    !('pid' in record) ||
    typeof record.pid !== 'number' ||
    !('startedAt' in record) ||
    typeof record.startedAt !== 'string'
  ) {
    throw new Error(`not a lock record: ${JSON.stringify(record)}`)
  }
  const port = 'port' in record && typeof record.port === 'number' ? record.port : undefined
  return { pid: record.pid, startedAt: record.startedAt, ...(port === undefined ? {} : { port }) }
}
