import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { HealthSchema } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  checkExecutable,
  checkFf,
  checkHealth,
  checkJsRuntimes,
  checkYtdlp,
  PROBE_ARGV,
  type Probe,
} from '../src/engine/binaries.ts'
import { killActiveGroups, run } from '../src/engine/run.ts'
import {
  engineFixture,
  type FakeToolBehavior,
  makeTempDir,
  writeExecutable,
  writeFakeTool,
} from './helpers.ts'

// The probes run fake tools (symlinks to test/fake-tool.sh) through the real run(). PATH always
// points at a temp dir, so the real yt-dlp, ffmpeg and deno are never found, let alone started.

const NOW = new Date('2026-10-02T08:00:00Z')
/** Generous for a /bin/sh script, but far below the 30 s production timeout. */
const probe: Probe = { run, timeoutMs: 5_000 }

let root = ''
beforeAll(async () => {
  root = await makeTempDir('probe')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  killActiveGroups()
})

let dirCount = 0
/** A fresh, empty directory to use as PATH. */
async function freshDir(): Promise<string> {
  const dir = path.join(root, `bin-${++dirCount}`)
  await mkdir(dir)
  return dir
}

/** yt-dlp, ffmpeg and ffprobe printing the recorded Homebrew outputs. */
async function recordedTools(dir: string) {
  await writeFakeTool(dir, 'yt-dlp', {
    argv: PROBE_ARGV.ytdlp,
    stdout: engineFixture('ytdlp-version-2026.08.19.txt'),
  })
  await writeFakeTool(dir, 'ffmpeg', {
    argv: PROBE_ARGV.ffmpeg,
    stdout: engineFixture('ffmpeg-version-8.0-brew.txt'),
  })
  await writeFakeTool(dir, 'ffprobe', {
    argv: PROBE_ARGV.ffprobe,
    stdout: engineFixture('ffprobe-version-8.0-brew.txt'),
  })
  return dir
}

describe('checkHealth with fake tools', () => {
  it('reports the recorded Homebrew versions as a healthy engine', async () => {
    const bin = await recordedTools(await freshDir())
    await writeFakeTool(bin, 'deno', {
      argv: PROBE_ARGV.deno,
      stdout: engineFixture('deno-version-2.9.7.txt'),
    })
    const health = await checkHealth({ PATH: bin }, NOW, probe)
    expect(HealthSchema.parse(health)).toStrictEqual(health)
    expect(health).toStrictEqual({
      ok: true,
      checkedAt: '2026-10-02T08:00:00.000Z',
      ytdlp: {
        status: 'ok',
        path: path.join(bin, 'yt-dlp'),
        source: 'path',
        version: '2026.08.19',
        releaseDate: '2026-08-19',
        ageDays: 44,
        stale: false,
        meetsMinimum: true,
      },
      ffmpeg: {
        status: 'ok',
        path: path.join(bin, 'ffmpeg'),
        source: 'path',
        version: '8.0',
        major: 8,
        meetsMinimum: true,
        mp3: true,
      },
      ffprobe: {
        status: 'ok',
        path: path.join(bin, 'ffprobe'),
        source: 'path',
        version: '8.0',
        major: 8,
        meetsMinimum: true,
      },
      jsRuntimes: [
        { name: 'deno', path: path.join(bin, 'deno'), version: '2.9.7', supported: true },
        {
          name: 'node',
          path: process.execPath,
          version: process.versions.node,
          supported: true,
        },
      ],
    })
  })

  it('reads a nightly yt-dlp set with YTDLP_PATH and ffmpeg from a FFMPEG_PATH directory', async () => {
    const nightly = await writeFakeTool(
      path.join(await freshDir(), 'yt-dlp_macos'),
      'yt-dlp_macos',
      {
        argv: PROBE_ARGV.ytdlp,
        stdout: engineFixture('ytdlp-version-2026.09.27.232945.txt'),
      },
    )
    const ff = await freshDir()
    await writeFakeTool(ff, 'ffmpeg', {
      argv: PROBE_ARGV.ffmpeg,
      stdout: engineFixture('ffmpeg-version-N-127085-tessus.txt'),
    })
    await writeFakeTool(ff, 'ffprobe', {
      argv: PROBE_ARGV.ffprobe,
      stdout: engineFixture('ffprobe-version-8.0-brew.txt'),
    })
    const health = await checkHealth(
      { YTDLP_PATH: nightly, FFMPEG_PATH: ff, PATH: await freshDir() },
      NOW,
      probe,
    )
    expect(health).toMatchObject({
      ok: true,
      ytdlp: { source: 'env', version: '2026.09.27.232945', releaseDate: '2026-09-27', ageDays: 5 },
      ffmpeg: { source: 'env', version: 'N-127085-g0eb6a369c69-tessus', major: 9 },
      ffprobe: { source: 'env', path: path.join(ff, 'ffprobe') },
    })
  })

  it('reports an empty PATH as nothing installed, with only our own Node', async () => {
    const health = await checkHealth({ PATH: await freshDir() }, NOW, probe)
    expect(health).toMatchObject({
      ok: false,
      ytdlp: { status: 'missing' },
      ffmpeg: { status: 'missing' },
      ffprobe: { status: 'missing' },
      jsRuntimes: [{ name: 'node', path: process.execPath }],
    })
  })
})

describe('probe failures through run()', () => {
  const fakeYtdlp = async (behavior: FakeToolBehavior) => {
    const bin = await freshDir()
    const ytdlp = await writeFakeTool(bin, 'yt-dlp', { argv: PROBE_ARGV.ytdlp, ...behavior })
    return { bin, ytdlp }
  }
  /** A script that must fail before it runs, so endpoint security never scans it. */
  const brokenYtdlp = async (body: string) => {
    const bin = await freshDir()
    return { bin, ytdlp: await writeExecutable(bin, 'yt-dlp', body) }
  }

  it('reports a crash with its exit code and last stderr line', async () => {
    const { bin, ytdlp } = await fakeYtdlp({
      stderr: 'Traceback (most recent call last):\nModuleNotFoundError: No module named yt_dlp\n',
      exitCode: 1,
    })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toEqual({
      status: 'error',
      path: ytdlp,
      source: 'path',
      message: 'yt-dlp exited with code 1: ModuleNotFoundError: No module named yt_dlp',
    })
  })

  it('reports a process killed by a signal (e.g. Gatekeeper killing a quarantined binary)', async () => {
    const { bin } = await fakeYtdlp({ signal: 'KILL' })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toMatchObject({
      status: 'error',
      message: 'yt-dlp was killed by SIGKILL.',
    })
  })

  it('stops a probe that hangs and reports the timeout', async () => {
    const { bin } = await fakeYtdlp({ hang: true })
    const startedAt = performance.now()
    const result = await checkYtdlp({ PATH: bin }, NOW, { run, timeoutMs: 500 })
    expect(result).toMatchObject({
      status: 'error',
      message: "yt-dlp didn't answer within 500 ms.",
    })
    // SIGINT to the process group ends it at once; no wait for the 5 s SIGKILL grace.
    expect(performance.now() - startedAt).toBeLessThan(3_000)
  })

  it('reports output that is not a version, naming the file', async () => {
    const { bin, ytdlp } = await fakeYtdlp({ stdout: 'Usage: yt-dlp [OPTIONS] URL\n' })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toMatchObject({
      status: 'error',
      message: `${ytdlp} printed no yt-dlp version we understand.`,
    })
  })

  it('explains ENOENT for an existing script whose #! interpreter is gone', async () => {
    const { bin, ytdlp } = await brokenYtdlp('#!/nonexistent/venv/bin/python3\nimport yt_dlp\n')
    expect(await checkExecutable(ytdlp)).toBe('ok')
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toEqual({
      status: 'error',
      path: ytdlp,
      source: 'path',
      message: "yt-dlp can't start: the interpreter in its #! line is missing. Reinstall yt-dlp.",
    })
  })

  it('reports an executable without a #! line as unable to start', async () => {
    const { bin } = await brokenYtdlp('echo 2026.08.19\n')
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toMatchObject({
      status: 'error',
      message: "yt-dlp can't start (ENOEXEC).",
    })
  })

  it('fails the probe when the tool is called with another argv', async () => {
    const bin = await freshDir()
    await writeFakeTool(bin, 'ffmpeg', {
      argv: ['-hide_banner', '-version'],
      stdout: engineFixture('ffmpeg-version-8.0-brew.txt'),
    })
    const loc = { kind: 'found', path: path.join(bin, 'ffmpeg'), source: 'path' } as const
    expect(await checkFf('ffmpeg', loc, probe)).toMatchObject({
      status: 'error',
      message: 'ffmpeg exited with code 64: unexpected argv: -version',
    })
  })

  it('leaves out a deno that fails, keeping our own Node', async () => {
    const bin = await freshDir()
    await writeFakeTool(bin, 'deno', { stderr: 'dyld: Library not loaded\n', exitCode: 134 })
    expect(await checkJsRuntimes({ PATH: bin }, probe)).toEqual([
      { name: 'node', path: process.execPath, version: process.versions.node, supported: true },
    ])
  })
})
