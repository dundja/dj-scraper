import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { HealthSchema } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_INDEX, freePort, makeTempDir, writeWebDist } from './helpers.ts'

// test/e2e-server.ts is the webServer of apps/web's Playwright config; this pins its contract.

const SCRIPT = path.join(import.meta.dirname, 'e2e-server.ts')
const YTDLP_DATE = expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/)

let root = ''
let webDist = ''
beforeAll(async () => {
  root = await makeTempDir('e2e-server')
  webDist = await writeWebDist(path.join(root, 'dist'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Started in their own process group, so a failed test can't leave a server behind. */
const started: ChildProcessByStdio<null, Readable, Readable>[] = []
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // ESRCH: the group is gone already.
    }
  }
})

/** Runs the script from an unrelated cwd, as Playwright may. */
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: root,
    env: { TMPDIR: tmpdir(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  started.push(child)
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output.stderr += chunk
  })
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  return { child, output, exited }
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })

describe('e2e-server', () => {
  it.each([
    // Passed on by the script.
    ['SIGTERM to the script only', 'SIGTERM', 1],
    ['SIGINT to the script only', 'SIGINT', 1],
    // Playwright's gracefulShutdown and Ctrl-C signal the whole group: the server gets the signal
    // directly and forwarded, and must still exit cleanly.
    ['SIGTERM to its process group', 'SIGTERM', -1],
  ] as const)(
    'serves the built UI with a healthy fake engine, and cleans up on %s',
    async (_label, signal, target) => {
      const port = await freePort()
      const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
      await expect
        .poll(() => output.stdout, { timeout: 4_000 })
        .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
      const bin = /Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? ''
      expect(existsSync(bin)).toBe(true)

      const health = HealthSchema.parse(
        await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(),
      )
      expect(health).toMatchObject({
        ok: true,
        // A pattern, not today's date: the test may run across midnight UTC.
        ytdlp: { status: 'ok', path: path.join(bin, 'yt-dlp'), version: YTDLP_DATE },
        ffmpeg: { status: 'ok', version: '8.0' },
        ffprobe: { status: 'ok', version: '8.0' },
        jsRuntimes: [{ name: 'node', supported: true }],
      })
      const page = await fetch(`http://localhost:${port}/`)
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      expect(await page.text()).toBe(FIXTURE_INDEX)

      // Never pid 0: that would signal the test runner's own process group.
      if (child.pid === undefined) throw new Error('e2e-server has no pid')
      process.kill(target * child.pid, signal)
      expect(await exited).toEqual([0, null])
      expect(await refused(port)).toBe(true)
      expect(existsSync(path.dirname(bin))).toBe(false)
      expect(output.stderr).toBe('')
    },
  )

  it('stops the server with it when its process group is SIGKILLed', async () => {
    const port = await freePort()
    const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
    await expect
      .poll(() => output.stdout, { timeout: 4_000 })
      .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
    const bin = /Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? ''

    // Playwright's fallback once gracefulShutdown times out, and what its exit handler sends.
    if (child.pid === undefined) throw new Error('e2e-server has no pid')
    process.kill(-child.pid, 'SIGKILL')
    expect(await exited).toEqual([null, 'SIGKILL'])
    // The server was in the same group, so it is gone too.
    await expect.poll(() => refused(port)).toBe(true)
    // No exit hook runs on SIGKILL, so the temp dir is left behind; remove it here.
    await rm(path.dirname(bin), { recursive: true, force: true })
  })

  it.each([
    [
      'without PORT',
      () => ({ DJS_WEB_DIST: webDist }),
      () => 'Set PORT to a free port from 1024 to 65535, e.g. PORT=4849.',
    ],
    [
      'without a built UI',
      () => ({ PORT: '4849', DJS_WEB_DIST: path.join(root, 'missing') }),
      () =>
        `No built UI in ${path.join(root, 'missing')}. Run \`pnpm --filter @dj-scraper/web build\` first.`,
    ],
    [
      'with a relative DJS_WEB_DIST',
      () => ({ PORT: '4849', DJS_WEB_DIST: 'dist' }),
      () => 'DJS_WEB_DIST must be an absolute path, not dist.',
    ],
  ])('exits 1 %s, before starting anything', async (_label, env, message) => {
    const { output, exited } = start(env())
    expect(await exited).toEqual([1, null])
    expect(output).toEqual({ stdout: '', stderr: `[e2e-server] ${message()}\n` })
  })
})
