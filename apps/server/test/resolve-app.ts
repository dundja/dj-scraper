// The real app (startServer + createApp) with the real resolver and enricher, driving the fake
// yt-dlp over HTTP. Shared by the resolve integration tests; not a test file. helpers.ts stays free
// of src/ imports, which is why this lives on its own.
import { setTimeout as delay } from 'node:timers/promises'
import type { Health } from '@dj-scraper/shared'
import { expect } from 'vitest'
import { createApp } from '../src/app.ts'
import type { EngineEnv } from '../src/engine/binaries.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { createEnricher, type Pacing } from '../src/resolve/enricher.ts'
import { createResolver } from '../src/resolve/resolver.ts'
import { type RunningServer, startServer } from '../src/server.ts'
import {
  type FakeYtdlp,
  type FakeYtdlpCall,
  type FakeYtdlpKnobs,
  type FakeYtdlpRule,
  writeFakeYtdlp,
} from './helpers.ts'

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

/**
 * One lookup at a time per platform, without gaps: the order of lookups is deterministic, a
 * rate-limited row's batch mates are still waiting when the cooldown starts, and tests don't sleep.
 * The real 1 s / 500 ms pacing has its own fake-clock tests (enricher.test.ts).
 */
export const SEQUENTIAL: Pacing = {
  soundcloud: { concurrency: 1, minIntervalMs: 0 },
  youtube: { concurrency: 1, minIntervalMs: 0 },
  other: { concurrency: 1, minIntervalMs: 0 },
}

export type ResolveApp = {
  port: number
  fake: FakeYtdlp
  /** Every line the resolver and enricher logged. */
  logs: string[]
  /** POSTs `body` as JSON (`Content-Type: application/json`). */
  post: (route: string, body: unknown, init?: RequestInit) => Promise<Response>
  /** A request with exactly these headers and body, for malformed ones. */
  send: (route: string, init: RequestInit) => Promise<Response>
  /** The fake's invocations that looked up a URL, in order (the --version probe has none). */
  lookups: () => Promise<FakeYtdlpCall[]>
}

const running: RunningServer[] = []
let count = 0

/**
 * Starts the app on a free port with a fake yt-dlp in `root/app-<n>/`. `engine` replaces the fake
 * (e.g. a YTDLP_PATH that doesn't exist); `manifestRules` come before the recorded fixtures' rules.
 */
export async function startResolveApp(
  root: string,
  options: {
    manifestRules?: readonly FakeYtdlpRule[]
    env?: FakeYtdlpKnobs
    engine?: EngineEnv
    pacing?: Pacing
  } = {},
): Promise<ResolveApp> {
  const fake = await writeFakeYtdlp(`${root}/app-${++count}`, {
    ...(options.manifestRules === undefined ? {} : { manifestRules: options.manifestRules }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const engine = options.engine ?? { YTDLP_PATH: fake.path }
  const logs: string[] = []
  const write = (...data: unknown[]) => {
    logs.push(data.map(String).join(' '))
  }
  const log = { info: write, warn: write, error: write }
  const resolver = createResolver({ engine, log })
  const enricher = createEnricher({ engine, log, pacing: options.pacing ?? SEQUENTIAL })
  const stubHealth = { current: async () => health, recheck: async () => health }
  const server = await startServer(0, (port) =>
    createApp({ port, health: stubHealth, resolver, enricher }),
  )
  running.push(server)

  const send = (route: string, init: RequestInit) =>
    fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', ...init })
  return {
    port: server.port,
    fake,
    logs,
    send,
    post: (route, body, init = {}) =>
      send(route, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...init,
      }),
    lookups: async () => (await fake.calls()).filter((call) => call.url !== null),
  }
}

/** For afterEach: stops leftover engine processes, then every app started by this file. */
export async function stopResolveApps(): Promise<void> {
  killActiveGroups()
  await Promise.all(running.splice(0).map((server) => server.close()))
}

/**
 * The JSON body of a response from our API: JSON content type, and never a CORS header (the
 * server is not public, see the guard).
 */
export async function jsonBody(res: Response): Promise<unknown> {
  expect(res.headers.get('content-type')).toMatch(/^application\/json\b/)
  expect(res.headers.get('access-control-allow-origin')).toBeNull()
  return res.json()
}

/** Resolves once `pid` is gone; a stopped engine process must not linger. */
export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      // ESRCH, or EPERM for a zombie on macOS: either way it no longer runs.
      return
    }
    await delay(20)
  }
  throw new Error(`process ${pid} is still running after ${timeoutMs} ms`)
}

/** Resolves once a logged line matches; the service logs after the request has settled. */
export async function waitForLog(logs: readonly string[], pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const line = logs.find((entry) => pattern.test(entry))
    if (line !== undefined) return line
    if (Date.now() > deadline)
      throw new Error(`no log line matched ${pattern}:\n${logs.join('\n')}`)
    await delay(10)
  }
}
