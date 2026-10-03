import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { get } from 'node:http'
import path from 'node:path'
import { ApiErrorBodySchema, HealthSchema } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PROBE_ARGV } from '../src/engine/binaries.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { bootEntry as boot, listeningLine as listening } from './entry.ts'
import {
  engineFixture,
  FIXTURE_ASSET,
  FIXTURE_INDEX,
  freePort,
  makeTempDir,
  SERVER_DIR,
  serverEnv,
  todaysYtdlpVersion,
  writeFakeTool,
  writeWebDist,
} from './helpers.ts'

// Boots the real entry (`node src/index.ts`, what `pnpm start` runs, minus --open) as a child
// process. Its env is only PATH (a temp dir of fake tools), PORT, DJS_WEB_DIST (a fixture UI build),
// and DJS_DATA_DIR and HOME (fresh temp dirs per server, see serverEnv), so it never finds the real
// yt-dlp or ffmpeg, never touches the user's data dir or ~/Music, and doesn't depend on whether
// apps/web/dist exists.

let root = ''
let webDist = ''
beforeAll(async () => {
  root = await makeTempDir('boot')
  webDist = await writeWebDist(path.join(root, 'dist'))
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

/** One server's whole environment: fake engine, port, the fixture UI build, its own temp dirs. */
const bootEnv = async (bin: string, port: number, extra: NodeJS.ProcessEnv = {}) => ({
  PATH: bin,
  PORT: String(port),
  DJS_WEB_DIST: webDist,
  ...(await serverEnv(root)),
  ...extra,
})

/** GET `target` with a chosen Host header, which fetch can't set. Resolves with the status. */
function statusWithHost(port: number, host: string, target = '/api/health'): Promise<number> {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: target,
      headers: { host },
      agent: false,
    }
    get(options, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
  })
}

describe('server boot', () => {
  it('serves the health of the fake engine, warns about nothing, and exits 0 on Ctrl-C', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const server = boot(await bootEnv(bin, port))
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
        // A pattern, not today's date: the test may run across midnight UTC.
        version: expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/),
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
    // So is the Host the Vite proxy forwards.
    expect(await statusWithHost(port, 'localhost:5173')).toBe(403)

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
    const server = boot(await bootEnv(bin, port))
    await server.waitForLine('stdout', listening(port))

    const stale = await server.waitForLine('stderr', /yt-dlp 2025\.11\.12/)
    expect(stale).toMatch(
      /^\[server\] yt-dlp 2025\.11\.12 is \d+ days old \(over 60\)\. If YouTube fails, run `brew upgrade yt-dlp` or point YTDLP_PATH at a nightly build\.$/,
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

  it('allows the Vite dev server with --dev and says so in the log line', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const server = boot(await bootEnv(bin, port), ['--dev'])
    await server.waitForLine('stdout', listening(port, true))

    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
    // Vite's proxy forwards the browser's Host unchanged; only the exact Vite hosts pass.
    expect(await statusWithHost(port, 'localhost:5173')).toBe(200)
    expect(await statusWithHost(port, 'file:5173')).toBe(403)
    expect(await server.stop()).toMatchObject({ exitCode: 0 })
  })

  it('serves no UI with --dev and does not look for a build', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const missing = path.join(root, 'no-dist-dev')
    const server = boot(await bootEnv(bin, port, { DJS_WEB_DIST: missing }), ['--dev'])
    await server.waitForLine('stdout', listening(port, true))

    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await res.json()).error.message).toBe('Not found')
    expect(await server.stop()).toMatchObject({ exitCode: 0 })
    expect(server.lines.stderr).toEqual([])
  })

  it('serves the built UI from DJS_WEB_DIST, behind the guard and with the security headers', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const server = boot(await bootEnv(bin, port))
    await server.waitForLine('stdout', listening(port))

    for (const target of ['/', '/downloads']) {
      const res = await fetch(`http://127.0.0.1:${port}${target}`)
      expect(res.status).toBe(200)
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      expect(await res.text()).toBe(FIXTURE_INDEX)
    }

    const asset = await fetch(`http://localhost:${port}${FIXTURE_ASSET.path}`)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await asset.text()).toBe(FIXTURE_ASSET.body)

    expect((await fetch(`http://127.0.0.1:${port}/assets/missing.js`)).status).toBe(404)
    expect(await statusWithHost(port, `evil.test:${port}`, '/')).toBe(403)

    expect(await server.stop()).toMatchObject({ exitCode: 0 })
    expect(server.lines.stderr).toEqual([])
  })

  it('warns once when there is no built UI, and keeps serving the API', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const missing = path.join(root, 'no-dist')
    const server = boot(await bootEnv(bin, port, { DJS_WEB_DIST: missing }))
    await server.waitForLine('stdout', listening(port))
    expect(await server.waitForLine('stderr', /No built UI/)).toBe(
      `[server] No built UI in ${missing}. Run \`pnpm build\` (pnpm start does).`,
    )

    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await page.json()).error).toEqual({
      code: 'not_found',
      message: 'The UI is not built. Run `pnpm build` (pnpm start does).',
    })

    expect(await server.stop()).toMatchObject({ exitCode: 0 })
    expect(server.lines.stderr).toHaveLength(1)
  })

  it('exits 1 with a clear message when the port is already in use', async () => {
    const [bin, port] = await Promise.all([fakeEngine(), freePort()])
    const first = boot(await bootEnv(bin, port))
    await first.waitForLine('stdout', listening(port))

    // Its own data dir, so it gets as far as listening.
    const second = await boot(await bootEnv(bin, port)).done
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
      env: await bootEnv(bin, port),
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
    await expect.poll(() => stdout, { timeout: 4_000 }).toMatch(/DJ Scraper on/)

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
      const result = await boot(
        { PATH: await fakeEngine(), ...(await serverEnv(root)), ...env },
        args,
      ).done
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(stderr)
      expect(result.stdout).toBe('')
    },
  )
})
