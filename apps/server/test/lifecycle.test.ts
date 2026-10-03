import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CreateDownloadsResponseSchema, type ServerEvent } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { JOBS_DIR, LOCK_WAIT_MS, lockDataDir, prepareDataDir } from '../src/data-dir.ts'
import { killActiveGroups, run } from '../src/engine/run.ts'
import { downloadArgs } from '../src/engine/ytdlp-args.ts'
import { KILL_GRACE_MS } from '../src/jobs/attempt.ts'
import { MP3, openEvents, processGroup, REFS, waitUntil } from './downloads-app.ts'
import { bootEntry, listeningLine, lockHolder } from './entry.ts'
import {
  type FakeEngine,
  freePort,
  makeTempDir,
  type ServerDirsEnv,
  serverEnv,
  writeFakeEngine,
  writeWebDist,
} from './helpers.ts'

// The server process around its downloads (design D9, §3 index.ts): graceful shutdown with a job
// running, the sweep of what a previous server left, and the data dir lock between two servers.
// Each test boots the real entry (test/entry.ts) with the whole fake engine (fake yt-dlp replaying
// test/fixtures/downloads, fake ffmpeg/ffprobe), its own data dir and home (serverEnv), and the
// fixture UI build.

let root = ''
let webDist = ''
beforeAll(async () => {
  root = await makeTempDir('lifecycle')
  webDist = await writeWebDist(path.join(root, 'dist'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  killActiveGroups()
})

const silent = { info() {}, warn() {}, error() {} }

let engines = 0
/** The fake engine in a PATH dir of its own, with node beside it for the fakes' `#!` line. */
async function fakeEngine(): Promise<FakeEngine> {
  const engine = await writeFakeEngine(path.join(root, `bin-${++engines}`))
  await symlink(process.execPath, path.join(engine.binDir, 'node'))
  return engine
}

/** A server's whole environment: nothing real on PATH, the fake engine, its own dirs. */
const entryEnv = (engine: FakeEngine, port: number, dirs: ServerDirsEnv): NodeJS.ProcessEnv => ({
  PATH: engine.binDir,
  PORT: String(port),
  DJS_WEB_DIST: webDist,
  ...dirs,
  ...engine.env,
})

/** The pids of the fake yt-dlp's download runs (the health probe's --version has no URL). */
const downloadPids = async (engine: FakeEngine) =>
  (await engine.ytdlp.calls()).filter((call) => call.url !== null).map((call) => call.pid)

/** Server log lines that break D18 (the listening line names the server's own URL; it may). */
const unsafeLines = (lines: readonly string[], paths: readonly string[]) =>
  lines.filter(
    (line) =>
      !/^\[server\] DJ Scraper on http:\/\/127\.0\.0\.1:\d+$/.test(line) &&
      (/https?:|Me at the zoo|jawed/.test(line) || paths.some((dir) => line.includes(dir))),
  )

describe('shutdown', () => {
  it('stops on SIGTERM with a download running and a client listening: the stream ends cleanly, the engine is gone, jobs/ is empty', async () => {
    const engine = await fakeEngine()
    const [port, dirs] = await Promise.all([freePort(), serverEnv(root)])
    const folder = await realpath(await mkdtemp(path.join(root, 'folder-')))
    const server = bootEntry(entryEnv(engine, port, dirs))
    await server.waitForLine('stdout', listeningLine(port))

    const sse = await openEvents(`http://127.0.0.1:${port}/api/events`)
    expect(await sse.next()).toMatchObject({ type: 'snapshot', jobs: [] })
    const res = await fetch(`http://127.0.0.1:${port}/api/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [REFS.youtubeHang], folder, options: MP3 }),
    })
    expect(res.status).toBe(200)
    const [id] = CreateDownloadsResponseSchema.parse(await res.json()).jobIds
    // The download hangs after its second progress line, until SIGINT.
    await sse.until(
      (event): event is ServerEvent =>
        event.type === 'job.progress' && event.jobId === id && (event.progress.percent ?? 0) > 12,
    )
    const [ytdlpPid] = await downloadPids(engine)
    if (ytdlpPid === undefined) throw new Error('yt-dlp started')
    expect(processGroup(ytdlpPid)).toBe('running')
    const jobsDir = path.join(dirs.DJS_DATA_DIR, JOBS_DIR)
    expect(await readdir(jobsDir)).toHaveLength(1)

    const { pid } = await lockHolder(dirs.DJS_DATA_DIR)
    const signaledAt = performance.now()
    process.kill(pid, 'SIGTERM')
    expect(await sse.ended()).toBe('closed')
    const result = await server.done
    // Within the attempt's SIGINT-to-SIGKILL grace, plus a second for the rest.
    expect(performance.now() - signaledAt).toBeLessThan(KILL_GRACE_MS + 1000)
    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: '' })

    expect(processGroup(ytdlpPid)).toBe('gone')
    expect(await readdir(jobsDir)).toEqual([])
    expect(await readdir(folder)).toEqual([])
    expect(unsafeLines(server.lines.stdout, [root, await realpath(root)])).toEqual([])
    // The lock went with it: the next server gets the data dir at once.
    const lock = await lockDataDir(await realpath(dirs.DJS_DATA_DIR), { waitMs: 0, log: silent })
    expect(lock.exclusive).toBe(true)
    lock.release()
  })
})

describe('the startup sweep', () => {
  it("stops a previous server's leftover engine process group and sweeps its job dirs and part files at boot", async () => {
    const engine = await fakeEngine()
    const [port, dirs] = await Promise.all([freePort(), serverEnv(root)])
    // What a server that died left behind. Its data dir:
    const dataDir = await prepareDataDir(dirs.DJS_DATA_DIR)
    const jobsDir = path.join(dataDir, JOBS_DIR)
    // A job dir with yt-dlp still downloading into it, in a process group of its own (as run()
    // starts them), the job dir in its argv, hung after its second progress line.
    const jobDir = path.join(jobsDir, randomUUID())
    await mkdir(jobDir, { mode: 0o700 })
    const leftover = run(
      engine.ytdlp.path,
      downloadArgs({
        url: REFS.youtubeHang.url,
        platform: 'youtube',
        format: 'mp3',
        jobDir,
        writeThumbnail: true,
        jsRuntime: process.execPath,
      }),
      { timeoutMs: 20_000 },
    )
    await waitUntil('the leftover to write its part file', async () =>
      (await readdir(jobDir)).includes('jNQXAC9IVRw.webm.part'),
    )
    const [leftoverPid] = await downloadPids(engine)
    if (leftoverPid === undefined) throw new Error('the leftover started')
    // The record of a cross-volume publish that never finished, and its part file.
    const music = await realpath(await mkdtemp(path.join(root, 'music-')))
    const attemptId = randomUUID()
    const part = path.join(music, `.djs-${attemptId}.part`)
    await writeFile(part, 'half a copy')
    await writeFile(path.join(music, 'mine.mp3'), "the user's own file")
    await writeFile(
      path.join(jobsDir, `${attemptId}.part.json`),
      JSON.stringify({ partPath: part }),
    )
    // And something in jobs/ that isn't ours to remove.
    await writeFile(path.join(jobsDir, 'notes.txt'), 'not a job')

    const server = bootEntry(entryEnv(engine, port, dirs))
    await server.waitForLine('stdout', listeningLine(port))
    // Swept before listening; the line holds counts only.
    expect(server.lines.stdout).toEqual([
      '[server] Cleaned up after the previous server: 1 process group(s) stopped, 2 job entries and 1 part file(s) removed',
      `[server] DJ Scraper on http://127.0.0.1:${port}`,
    ])
    // Killed before the server listened (the sweep waits until it is gone), so this settles at once.
    expect(await Promise.race([leftover, delay(1000, 'still running')])).toMatchObject({
      signal: 'SIGKILL',
      timedOut: false,
    })
    expect(processGroup(leftoverPid)).toBe('gone')
    expect(await readdir(jobsDir)).toEqual(['notes.txt'])
    expect(await readdir(music)).toEqual(['mine.mp3'])

    expect(await server.stop()).toMatchObject({ exitCode: 0 })
    expect(server.lines.stderr).toEqual([])
  })
})

describe('the data dir lock', () => {
  it('makes a second server on the same data dir wait for the first, then exit 1 naming it', {
    timeout: LOCK_WAIT_MS + 10_000,
  }, async () => {
    const engine = await fakeEngine()
    const [port, otherPort, dirs] = await Promise.all([freePort(), freePort(), serverEnv(root)])
    const first = bootEntry(entryEnv(engine, port, dirs))
    await first.waitForLine('stdout', listeningLine(port))
    const { pid } = await lockHolder(dirs.DJS_DATA_DIR)

    const startedAt = performance.now()
    const second = bootEntry(entryEnv(engine, otherPort, dirs))
    const waiting = await second.waitForLine('stdout', /Waiting/)
    expect(waiting).toBe(`[server] Waiting for the previous server (pid ${pid}) to stop…`)
    const result = await second.done
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(LOCK_WAIT_MS)
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: `${waiting}\n`,
      stderr: `[server] Another DJ Scraper server (pid ${pid}, http://127.0.0.1:${port}/) is using the app data folder. Stop it first.\n`,
    })
    // It never listened, and the first one is unaffected.
    await expect(fetch(`http://127.0.0.1:${otherPort}/api/health`)).rejects.toThrow()
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200)
    expect(await lockHolder(dirs.DJS_DATA_DIR)).toMatchObject({ pid, port })
    expect(await first.stop()).toMatchObject({ exitCode: 0 })
  })

  it('lets a waiting second server take the data dir over once the first has shut down', async () => {
    const engine = await fakeEngine()
    const [port, otherPort, dirs] = await Promise.all([freePort(), freePort(), serverEnv(root)])
    const first = bootEntry(entryEnv(engine, port, dirs))
    await first.waitForLine('stdout', listeningLine(port))
    const { pid } = await lockHolder(dirs.DJS_DATA_DIR)

    const second = bootEntry(entryEnv(engine, otherPort, dirs))
    await second.waitForLine('stdout', /Waiting for the previous server/)
    expect(await first.stop()).toMatchObject({ exitCode: 0 })
    await second.waitForLine('stdout', listeningLine(otherPort))
    expect((await fetch(`http://127.0.0.1:${otherPort}/api/health`)).status).toBe(200)
    const holder = await lockHolder(dirs.DJS_DATA_DIR)
    expect(holder).toMatchObject({ port: otherPort })
    expect(holder.pid).not.toBe(pid)
    expect(await second.stop()).toMatchObject({ exitCode: 0 })
    expect(second.lines.stderr).toEqual([])
  })
})
