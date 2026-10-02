import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { ApiErrorBodySchema, HealthSchema } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PROBE_ARGV } from '../src/engine/binaries.ts'
import { killActiveGroups, type RunResult, run } from '../src/engine/run.ts'
import {
  engineFixture,
  freePort,
  makeTempDir,
  SERVER_DIR,
  todaysYtdlpVersion,
  writeFakeTool,
} from './helpers.ts'

// Boots the real entry (`node src/index.ts`, what `pnpm start` runs) as a child process. Its env
// is only PATH (a temp dir of fake tools) and PORT, so it never finds the real yt-dlp or ffmpeg.

let root = ''
beforeAll(async () => {
  root = await makeTempDir('boot')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  killActiveGroups()
})

let binCount = 0
/** A PATH dir with fake yt-dlp (printing `ytdlpVersion`), ffmpeg and, optionally, ffprobe. */
async function fakeEngine({ ytdlpVersion = todaysYtdlpVersion(), ffprobe = true } = {}) {
  const bin = path.join(root, `bin-${++binCount}`)
  await writeFakeTool(bin, 'yt-dlp', { argv: PROBE_ARGV.ytdlp, stdout: `${ytdlpVersion}\n` })
  await writeFakeTool(bin, 'ffmpeg', {
    argv: PROBE_ARGV.ffmpeg,
    stdout: engineFixture('ffmpeg-version-8.0-brew.txt'),
  })
  if (ffprobe) {
    await writeFakeTool(bin, 'ffprobe', {
      argv: PROBE_ARGV.ffprobe,
      stdout: engineFixture('ffprobe-version-8.0-brew.txt'),
    })
  }
  return bin
}

type Stream = 'stdout' | 'stderr'

/** Starts the server entry; lines are collected per stream and can be awaited. */
function boot(env: NodeJS.ProcessEnv, args: readonly string[] = []) {
  const controller = new AbortController()
  const lines: Record<Stream, string[]> = { stdout: [], stderr: [] }
  const waiters: { stream: Stream; pattern: RegExp; resolve: (line: string) => void }[] = []
  const onLine = (stream: Stream) => (line: string) => {
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

  /** The first line on `stream` matching `pattern`; rejects if the process ends without one. */
  const waitForLine = (stream: Stream, pattern: RegExp): Promise<string> => {
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

  /** Ctrl-C: SIGINT to the server's process group, then waits until it has exited. */
  const stop = async (): Promise<RunResult & { stopMs: number }> => {
    const startedAt = performance.now()
    controller.abort()
    const result = await done
    return { ...result, stopMs: performance.now() - startedAt }
  }

  return { done, lines, waitForLine, stop }
}

const listening = (port: number, dev = false) =>
  new RegExp(
    `^\\[server\\] DJ Scraper on http://127\\.0\\.0\\.1:${port}${dev ? ' \\(dev\\)' : ''}$`,
  )

describe('server boot', () => {
  it('serves the health of the fake engine, warns about nothing, and exits 0 on Ctrl-C', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const server = boot({ PATH: bin, PORT: String(port) })
    expect(await server.waitForLine('stdout', /DJ Scraper on/)).toMatch(listening(port))

    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
    const health = HealthSchema.parse(await res.json())
    expect(health).toMatchObject({
      ok: true,
      ytdlp: {
        status: 'ok',
        path: path.join(bin, 'yt-dlp'),
        source: 'path',
        version: todaysYtdlpVersion(),
        stale: false,
      },
      ffmpeg: { status: 'ok', path: path.join(bin, 'ffmpeg'), version: '8.0', mp3: true },
      ffprobe: { status: 'ok', path: path.join(bin, 'ffprobe'), version: '8.0' },
      jsRuntimes: [{ name: 'node', path: process.execPath, supported: true }],
    })

    // Without --dev the Vite origin is a foreign origin.
    const vite = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(ApiErrorBodySchema.parse(await vite.json()).error.code).toBe('forbidden')

    // fetch keeps the connection alive; shutdown must not wait for it.
    const result = await server.stop()
    expect(result).toMatchObject({ exitCode: 0, signal: null })
    expect(result.stopMs).toBeLessThan(2_000)
    expect(server.lines.stderr).toEqual([])
  })

  it('prints a warning per engine problem once the boot check finishes', async () => {
    // 2025.11.12 meets the minimum but is stale from 2026-01-12 on, whatever today is.
    const [bin, port] = await Promise.all([
      fakeEngine({ ytdlpVersion: '2025.11.12', ffprobe: false }),
      freePort(),
    ])
    const server = boot({ PATH: bin, PORT: String(port) })
    await server.waitForLine('stdout', listening(port))

    const stale = await server.waitForLine('stderr', /yt-dlp 2025\.11\.12/)
    expect(stale).toMatch(
      /^\[server\] yt-dlp 2025\.11\.12 is \d+ days old \(over 60\)\. If YouTube fails, update it or use a nightly build\.$/,
    )
    expect(await server.waitForLine('stderr', /ffprobe/)).toBe(
      '[server] ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
    )

    const health = HealthSchema.parse(
      await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(),
    )
    expect(health).toMatchObject({
      ok: false,
      ytdlp: { stale: true },
      ffprobe: { status: 'missing' },
    })

    expect(await server.stop()).toMatchObject({ exitCode: 0 })
    expect(server.lines.stderr).toHaveLength(2)
  })

  it('allows the Vite dev origin with --dev and says so in the log line', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const server = boot({ PATH: bin, PORT: String(port) }, ['--dev'])
    await server.waitForLine('stdout', listening(port, true))

    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
    expect(await server.stop()).toMatchObject({ exitCode: 0 })
  })

  it('exits 1 with a clear message when the port is already in use', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const first = boot({ PATH: bin, PORT: String(port) })
    await first.waitForLine('stdout', listening(port))

    const second = await boot({ PATH: bin, PORT: String(port) }).done
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toBe(`[server] Port ${port} is in use. Is DJ Scraper already running?\n`)
    expect(second.stdout).toBe('')

    // The first instance is unaffected.
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    expect(await first.stop()).toMatchObject({ exitCode: 0 })
  })

  // pnpm dev delivers Ctrl-C twice (the terminal's group and node --watch). A second signal must not
  // fall through to Node's default action, which kills the server before its exit hook runs.
  it.each([
    // Identical signals sent back to back merge in the kernel, so keep sending while it shuts down.
    ['repeated SIGINTs', ['SIGINT'], 50],
    ['SIGTERM then SIGINT', ['SIGTERM', 'SIGINT'], 0],
    ['SIGHUP (terminal closed)', ['SIGHUP'], 0],
  ] as const)('shuts down cleanly on %s', async (_label, signals, repeatForMs) => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    // Spawned directly, not through run(), to signal the server's own pid.
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: { PATH: bin, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const exited = once(child, 'exit')
    await expect.poll(() => stdout, { timeout: 5_000 }).toMatch(/DJ Scraper on/)

    for (const signal of signals) child.kill(signal)
    const until = performance.now() + repeatForMs
    while (performance.now() < until) {
      const next = performance.now() + 0.2
      while (performance.now() < next) {}
      if (child.exitCode !== null || !child.kill(signals.at(-1))) break
    }
    const [code, signal] = await exited
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: '' })
  })

  it.each([
    ['an invalid PORT', { PORT: '80' }, [], /^\[server\] Invalid environment:\n[\s\S]*\bPORT\b/],
    ['a relative YTDLP_PATH', { YTDLP_PATH: 'yt-dlp' }, [], /→ at YTDLP_PATH/],
    ['an unknown flag', {}, ['--verbose'], /^\[server\] Unknown option '--verbose'/],
  ])(
    'exits 1 with the ConfigError for %s, without listening',
    async (_label, env, args, stderr) => {
      const result = await boot({ PATH: await fakeEngine(), ...env }, args).done
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(stderr)
      expect(result.stdout).toBe('')
    },
  )
})
