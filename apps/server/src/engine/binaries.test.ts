import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HealthSchema, healthProblems } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StepError } from '../jobs/types.ts'
import {
  checkExecutable,
  checkFf,
  checkHealth,
  checkJsRuntimes,
  checkYtdlp,
  type EngineEnv,
  ffprobeCandidates,
  findOnPath,
  locateEngine,
  locateFfmpeg,
  locateYtdlp,
  type Probe,
  pathDirs,
  probeFailure,
  spawnFailure,
} from './binaries.ts'
import { type RunOptions, type RunResult, type run, SpawnError } from './run.ts'

// Lookup works on real temp dirs; probing uses a stub `run`, so nothing is spawned here.
// Spawning fake executables through the real run() is covered in test/binaries.test.ts.

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/engine')
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')

const NOW = new Date('2026-10-02T08:00:00Z')

let root = ''
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-binaries-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Creates root/rel (and its parents) with the given mode; 755 = an executable stub. */
async function file(rel: string, mode = 0o755): Promise<string> {
  const p = path.join(root, rel)
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, '#!/bin/sh\nexit 0\n')
  await chmod(p, mode)
  return p
}

async function dir(rel: string): Promise<string> {
  const p = path.join(root, rel)
  await mkdir(p, { recursive: true })
  return p
}

let count = 0
/** A path under root that no other test uses, for parameterized tests. */
const unique = (prefix: string) => `${prefix}-${++count}`

/** A directory holding executable stubs with these names, for use as PATH. */
async function binDir(rel: string, names: readonly string[]): Promise<string> {
  const d = await dir(rel)
  for (const name of names) await file(path.join(rel, name))
  return d
}

const exited = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 12,
  ...extra,
})

type Answer = RunResult | Error
type Call = { bin: string; argv: readonly string[]; options: RunOptions | undefined }

/** A Probe whose run() answers by binary name; an unexpected binary fails the test. */
function stubProbe(answers: Record<string, Answer>, timeoutMs = 30_000) {
  const calls: Call[] = []
  const fakeRun: typeof run = async (bin, argv, options) => {
    calls.push({ bin, argv, options })
    const answer = answers[path.basename(bin)]
    if (answer === undefined) throw new Error(`test bug: unexpected run of ${bin}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  const probe: Probe = { run: fakeRun, timeoutMs }
  return { probe, calls }
}

const spawnError = (bin: string, code: string) =>
  new SpawnError(bin, Object.assign(new Error(`spawn ${bin} ${code}`), { code }))

const recorded = {
  'yt-dlp': exited(fixture('ytdlp-version-2026.08.19.txt')),
  ffmpeg: exited(fixture('ffmpeg-version-8.0-brew.txt')),
  ffprobe: exited(fixture('ffprobe-version-8.0-brew.txt')),
  deno: exited(fixture('deno-version-2.9.7.txt')),
}

/** Runs `fn` as if this process were Node `version`: checkJsRuntimes reads process.versions.node. */
async function asNode<T>(version: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node')
  Object.defineProperty(process.versions, 'node', { ...original, value: version })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(process.versions, 'node', original)
  }
}

describe('pathDirs', () => {
  it('keeps only absolute entries, normalized and deduplicated, in order', () => {
    expect(pathDirs('/opt/homebrew/bin::bin:./x:/usr/bin/:/usr/bin:/opt/homebrew//bin')).toEqual([
      '/opt/homebrew/bin',
      '/usr/bin',
    ])
  })

  it('treats an unset or empty PATH as no directories (not the cwd)', () => {
    expect(pathDirs(undefined)).toEqual([])
    expect(pathDirs('')).toEqual([])
  })
})

describe('checkExecutable', () => {
  it('classifies files, directories, links and missing paths', async () => {
    const executable = await file('exec/tool')
    const plain = await file('exec/plain', 0o644)
    const directory = await dir('exec/a-dir')
    await chmod(directory, 0o755)
    const dangling = path.join(root, 'exec/dangling')
    await symlink(path.join(root, 'exec/nowhere'), dangling)
    const link = path.join(root, 'exec/link')
    await symlink(executable, link)

    expect(await checkExecutable(executable)).toBe('ok')
    expect(await checkExecutable(link)).toBe('ok')
    expect(await checkExecutable(plain)).toBe('not_executable')
    expect(await checkExecutable(directory)).toBe('not_a_file')
    expect(await checkExecutable(dangling)).toBe('missing')
    expect(await checkExecutable(path.join(root, 'exec/absent'))).toBe('missing')
  })
})

describe('findOnPath', () => {
  it('returns the first executable regular file in PATH order', async () => {
    const first = await binDir('order/first', ['yt-dlp'])
    const second = await binDir('order/second', ['yt-dlp'])
    expect(await findOnPath('yt-dlp', `${first}:${second}`)).toBe(path.join(first, 'yt-dlp'))
    expect(await findOnPath('yt-dlp', `${second}:${first}`)).toBe(path.join(second, 'yt-dlp'))
  })

  it('skips a non-executable file, a directory and a dangling link with that name', async () => {
    const notExecutable = await dir('skip/not-executable')
    await file('skip/not-executable/yt-dlp', 0o644)
    const directory = await dir('skip/directory')
    await dir('skip/directory/yt-dlp')
    const dangling = await dir('skip/dangling')
    await symlink('/nonexistent/yt-dlp', path.join(dangling, 'yt-dlp'))
    const good = await binDir('skip/good', ['yt-dlp'])

    const skipped = [notExecutable, directory, dangling]
    expect(await findOnPath('yt-dlp', skipped.join(':'))).toBeNull()
    expect(await findOnPath('yt-dlp', [...skipped, good].join(':'))).toBe(path.join(good, 'yt-dlp'))
  })

  it('keeps the symlinked path, like /opt/homebrew/bin/yt-dlp pointing into the Cellar', async () => {
    const real = await file('cellar/yt-dlp/2026.08.19/bin/yt-dlp')
    const bin = await dir('linked-bin')
    await symlink(real, path.join(bin, 'yt-dlp'))
    expect(await findOnPath('yt-dlp', bin)).toBe(path.join(bin, 'yt-dlp'))
  })

  it('ignores relative and empty entries even when they lead to the binary', async () => {
    const bin = await binDir('relative/bin', ['yt-dlp'])
    const relative = path.relative(process.cwd(), bin)
    expect(path.isAbsolute(relative)).toBe(false)
    expect(await findOnPath('yt-dlp', `${relative}::.`)).toBeNull()
  })

  it('finds nothing without a PATH', async () => {
    expect(await findOnPath('yt-dlp', undefined)).toBeNull()
  })
})

describe('ffprobeCandidates', () => {
  it.each([
    ['/opt/ff/ffmpeg', ['/opt/ff/ffprobe']],
    ['/opt/ff/ffmpeg-8', ['/opt/ff/ffprobe-8', '/opt/ff/ffprobe']],
    ['/opt/ff/my-ffmpeg-build', ['/opt/ff/my-ffprobe-build', '/opt/ff/ffprobe']],
    ['/opt/ff/ff', ['/opt/ff/ffprobe']],
  ])('looks beside %s, like yt-dlp --ffmpeg-location', (ffmpeg, candidates) => {
    expect(ffprobeCandidates(ffmpeg)).toEqual(candidates)
  })
})

describe('locateYtdlp', () => {
  it('finds yt-dlp on PATH', async () => {
    const bin = await binDir('yt/path', ['yt-dlp'])
    expect(await locateYtdlp({ PATH: bin })).toEqual({
      kind: 'found',
      path: path.join(bin, 'yt-dlp'),
      source: 'path',
    })
  })

  it('reports a missing yt-dlp with how to install it', async () => {
    const empty = await dir('yt/empty')
    expect(await locateYtdlp({ PATH: empty })).toEqual({
      kind: 'missing',
      message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
    })
  })

  it('prefers YTDLP_PATH over PATH', async () => {
    const onPath = await binDir('yt/prefer-path', ['yt-dlp'])
    const override = await file('yt/prefer-env/yt-dlp_macos')
    expect(await locateYtdlp({ YTDLP_PATH: override, PATH: onPath })).toEqual({
      kind: 'found',
      path: override,
      source: 'env',
    })
  })

  it.each([
    ['does not exist', async () => path.join(root, 'yt/gone/yt-dlp'), 'does not exist.'],
    ['is not executable', () => file('yt/plain/yt-dlp', 0o644), 'is not executable (chmod +x).'],
    ['is a directory', () => dir('yt/a-dir/yt-dlp'), 'is not a file.'],
  ])('reports a YTDLP_PATH that %s without falling back to PATH', async (_label, make, problem) => {
    const override = await make()
    const onPath = await binDir(unique('yt/fallback'), ['yt-dlp'])
    expect(await locateYtdlp({ YTDLP_PATH: override, PATH: onPath })).toEqual({
      kind: 'broken',
      path: override,
      source: 'env',
      message: `YTDLP_PATH: ${override} ${problem}`,
    })
  })

  it('searches PATH when YTDLP_PATH is empty', async () => {
    const bin = await binDir('yt/empty-override', ['yt-dlp'])
    expect(await locateYtdlp({ YTDLP_PATH: '', PATH: bin })).toMatchObject({
      kind: 'found',
      source: 'path',
    })
  })
})

describe('locateFfmpeg', () => {
  it('searches PATH for ffmpeg and ffprobe independently without an override', async () => {
    const a = await binDir('ff/path-a', ['ffmpeg'])
    const b = await binDir('ff/path-b', ['ffprobe'])
    expect(await locateFfmpeg({ PATH: `${a}:${b}` })).toEqual({
      ffmpeg: { kind: 'found', path: path.join(a, 'ffmpeg'), source: 'path' },
      ffprobe: { kind: 'found', path: path.join(b, 'ffprobe'), source: 'path' },
    })
  })

  it('reports a missing ffprobe with how to install it', async () => {
    const bin = await binDir('ff/no-probe', ['ffmpeg'])
    expect((await locateFfmpeg({ PATH: bin })).ffprobe).toEqual({
      kind: 'missing',
      message: 'ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
    })
  })

  it('takes both binaries from a FFMPEG_PATH directory', async () => {
    const ff = await binDir('ff/dir-both', ['ffmpeg', 'ffprobe'])
    expect(await locateFfmpeg({ FFMPEG_PATH: ff })).toEqual({
      ffmpeg: { kind: 'found', path: path.join(ff, 'ffmpeg'), source: 'env' },
      ffprobe: { kind: 'found', path: path.join(ff, 'ffprobe'), source: 'env' },
    })
  })

  it('reports ffprobe missing from a FFMPEG_PATH directory instead of using the one on PATH', async () => {
    const ff = await binDir('ff/dir-no-probe', ['ffmpeg'])
    const onPath = await binDir('ff/dir-no-probe-path', ['ffprobe'])
    const missing = path.join(ff, 'ffprobe')
    expect((await locateFfmpeg({ FFMPEG_PATH: ff, PATH: onPath })).ffprobe).toEqual({
      kind: 'broken',
      path: missing,
      source: 'env',
      message: `FFMPEG_PATH: ${missing} does not exist.`,
    })
  })

  it('takes ffprobe from beside a FFMPEG_PATH binary', async () => {
    const ff = await binDir('ff/bin-both', ['ffmpeg', 'ffprobe'])
    expect(await locateFfmpeg({ FFMPEG_PATH: path.join(ff, 'ffmpeg') })).toEqual({
      ffmpeg: { kind: 'found', path: path.join(ff, 'ffmpeg'), source: 'env' },
      ffprobe: { kind: 'found', path: path.join(ff, 'ffprobe'), source: 'env' },
    })
  })

  it('prefers the matching versioned ffprobe beside a versioned ffmpeg', async () => {
    const ff = await binDir('ff/versioned', ['ffmpeg-8', 'ffprobe-8', 'ffprobe'])
    const { ffprobe } = await locateFfmpeg({ FFMPEG_PATH: path.join(ff, 'ffmpeg-8') })
    expect(ffprobe).toEqual({ kind: 'found', path: path.join(ff, 'ffprobe-8'), source: 'env' })
  })

  it('falls back to a plain ffprobe beside a versioned ffmpeg', async () => {
    const ff = await binDir('ff/versioned-plain', ['ffmpeg-8', 'ffprobe'])
    const { ffprobe } = await locateFfmpeg({ FFMPEG_PATH: path.join(ff, 'ffmpeg-8') })
    expect(ffprobe).toEqual({ kind: 'found', path: path.join(ff, 'ffprobe'), source: 'env' })
  })

  it('reports a non-executable versioned ffprobe rather than silently using another', async () => {
    const ff = await binDir('ff/versioned-broken', ['ffmpeg-8', 'ffprobe'])
    await file('ff/versioned-broken/ffprobe-8', 0o644)
    const { ffprobe } = await locateFfmpeg({ FFMPEG_PATH: path.join(ff, 'ffmpeg-8') })
    expect(ffprobe).toMatchObject({ kind: 'broken', path: path.join(ff, 'ffprobe-8') })
  })

  it('never looks on PATH for ffprobe when FFMPEG_PATH names the binary', async () => {
    const ff = await binDir('ff/lonely', ['ffmpeg'])
    const onPath = await binDir('ff/lonely-path', ['ffprobe'])
    const missing = path.join(ff, 'ffprobe')
    const located = await locateFfmpeg({ FFMPEG_PATH: path.join(ff, 'ffmpeg'), PATH: onPath })
    expect(located.ffprobe).toEqual({
      kind: 'broken',
      path: missing,
      source: 'env',
      message: `FFMPEG_PATH: ${missing} does not exist.`,
    })
  })

  it('reports both tools as broken when FFMPEG_PATH does not exist', async () => {
    const gone = path.join(root, 'ff/gone/ffmpeg')
    const onPath = await binDir('ff/gone-path', ['ffmpeg', 'ffprobe'])
    expect(await locateFfmpeg({ FFMPEG_PATH: gone, PATH: onPath })).toMatchObject({
      ffmpeg: { kind: 'broken', path: gone, message: `FFMPEG_PATH: ${gone} does not exist.` },
      ffprobe: { kind: 'broken', path: path.join(root, 'ff/gone/ffprobe') },
    })
  })
})

describe('locateEngine', () => {
  /** The StepError it throws, as { code, message }. */
  const failure = async (env: EngineEnv) => {
    const error = await locateEngine(env).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    if (!(error instanceof StepError)) throw new Error('expected a StepError')
    return error.info
  }

  it('finds all three without running them', async () => {
    const bin = await binDir('engine/all', ['yt-dlp', 'ffmpeg', 'ffprobe'])
    expect(await locateEngine({ PATH: bin })).toEqual({
      ytdlp: path.join(bin, 'yt-dlp'),
      ffmpeg: path.join(bin, 'ffmpeg'),
      ffprobe: path.join(bin, 'ffprobe'),
    })
  })

  it('takes the overrides', async () => {
    const ff = await binDir('engine/ff', ['ffmpeg', 'ffprobe'])
    const ytdlp = await file('engine/override/yt-dlp')
    expect(await locateEngine({ YTDLP_PATH: ytdlp, FFMPEG_PATH: ff })).toEqual({
      ytdlp,
      ffmpeg: path.join(ff, 'ffmpeg'),
      ffprobe: path.join(ff, 'ffprobe'),
    })
  })

  it.each([
    [['ffmpeg', 'ffprobe'], 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.'],
    [['yt-dlp', 'ffprobe'], 'ffmpeg is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.'],
    [['yt-dlp', 'ffmpeg'], 'ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.'],
  ] as const)('is engine_missing with %o only', async (names, message) => {
    const bin = await binDir(unique('engine/some'), names)
    expect(await failure({ PATH: bin })).toEqual({ code: 'engine_missing', message })
  })

  it('names the variable, never the path, for a broken override', async () => {
    const bin = await binDir('engine/broken-path', ['yt-dlp', 'ffmpeg', 'ffprobe'])
    const gone = path.join(root, 'engine/secret-place/yt-dlp')
    expect(await failure({ YTDLP_PATH: gone, PATH: bin })).toEqual({
      code: 'engine_missing',
      message: "YTDLP_PATH doesn't point at a working yt-dlp. Fix it, then retry.",
    })
    const notExecutable = await file('engine/secret-place/ffmpeg', 0o644)
    expect(await failure({ FFMPEG_PATH: notExecutable, PATH: bin })).toEqual({
      code: 'engine_missing',
      message: "FFMPEG_PATH doesn't point at a working ffmpeg. Fix it, then retry.",
    })
  })
})

describe('probeFailure', () => {
  it('is null for a clean exit, so stdout gets parsed', () => {
    expect(probeFailure('yt-dlp', exited('2026.08.19\n'), 30_000)).toBeNull()
  })

  it('reports a timeout in whole seconds, even though the process then died of SIGINT', () => {
    const result = exited('', { exitCode: null, signal: 'SIGINT', timedOut: true })
    expect(probeFailure('yt-dlp', result, 30_000)).toBe("yt-dlp didn't answer within 30 s.")
  })

  it('quotes the last stderr line of a failed exit', () => {
    const stderr =
      'Traceback (most recent call last):\r\n  File "yt_dlp/__main__.py"\r\nModuleNotFoundError: No module named yt_dlp\r\n'
    const result = exited('', { exitCode: 1, stderr })
    expect(probeFailure('yt-dlp', result, 30_000)).toBe(
      'yt-dlp exited with code 1: ModuleNotFoundError: No module named yt_dlp',
    )
  })

  it('reports the exit code alone when stderr is empty', () => {
    const result = exited('', { exitCode: 2, stderr: '  \n' })
    expect(probeFailure('ffmpeg', result, 30_000)).toBe('ffmpeg exited with code 2.')
  })

  it('names the signal that killed it', () => {
    const result = exited('', {
      exitCode: null,
      signal: 'SIGABRT',
      stderr: 'dyld: Library not loaded\n',
    })
    expect(probeFailure('ffmpeg', result, 30_000)).toBe(
      'ffmpeg was killed by SIGABRT: dyld: Library not loaded',
    )
  })
})

describe('spawnFailure', () => {
  it('explains ENOENT on an existing file as a missing #! interpreter', () => {
    expect(spawnFailure('yt-dlp', 'ENOENT')).toBe(
      "yt-dlp can't start: the interpreter in its #! line is missing. Reinstall yt-dlp.",
    )
  })

  it('passes other errno codes through', () => {
    expect(spawnFailure('ffmpeg', 'EACCES')).toBe("ffmpeg can't start (EACCES).")
  })
})

describe('checkYtdlp', () => {
  it('reports the version, age and freshness of a working yt-dlp', async () => {
    const bin = await binDir('check-yt/ok', ['yt-dlp'])
    const { probe, calls } = stubProbe({ 'yt-dlp': recorded['yt-dlp'] }, 12_345)
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toStrictEqual({
      status: 'ok',
      path: path.join(bin, 'yt-dlp'),
      source: 'path',
      version: '2026.08.19',
      releaseDate: '2026-08-19',
      ageDays: 44,
      stale: false,
      meetsMinimum: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bin).toBe(path.join(bin, 'yt-dlp'))
    expect(calls[0]?.argv).toEqual(['--ignore-config', '--no-update', '--version'])
    expect(calls[0]?.options?.timeoutMs).toBe(12_345)
    expect(calls[0]?.options?.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024)
  })

  it('marks a yt-dlp older than 60 days as stale, measured from the injected now', async () => {
    const bin = await binDir('check-yt/stale', ['yt-dlp'])
    const { probe } = stubProbe({ 'yt-dlp': recorded['yt-dlp'] })
    const later = new Date('2026-10-19T00:00:00Z')
    expect(await checkYtdlp({ PATH: bin }, later, probe)).toMatchObject({
      ageDays: 61,
      stale: true,
      meetsMinimum: true,
    })
  })

  it('flags a release older than 2025.11.12 as below the minimum', async () => {
    const bin = await binDir('check-yt/old', ['yt-dlp'])
    const { probe } = stubProbe({ 'yt-dlp': exited('2025.10.22\n') })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toMatchObject({
      status: 'ok',
      version: '2025.10.22',
      meetsMinimum: false,
    })
  })

  it('does not probe a missing or broken yt-dlp', async () => {
    const { probe, calls } = stubProbe({})
    const empty = await dir('check-yt/empty')
    expect(await checkYtdlp({ PATH: empty }, NOW, probe)).toMatchObject({ status: 'missing' })
    const gone = path.join(root, 'check-yt/gone/yt-dlp')
    expect(await checkYtdlp({ YTDLP_PATH: gone }, NOW, probe)).toEqual({
      status: 'error',
      path: gone,
      source: 'env',
      message: `YTDLP_PATH: ${gone} does not exist.`,
    })
    expect(calls).toEqual([])
  })

  it.each([
    [
      'cannot start (ENOENT: its #! interpreter is gone)',
      (bin: string) => spawnError(bin, 'ENOENT'),
      "yt-dlp can't start: the interpreter in its #! line is missing. Reinstall yt-dlp.",
    ],
    [
      'exits with an error',
      () => exited('', { exitCode: 1, stderr: 'ImportError: no module\n' }),
      'yt-dlp exited with code 1: ImportError: no module',
    ],
    [
      'times out',
      () => exited('', { exitCode: null, signal: 'SIGINT', timedOut: true }),
      "yt-dlp didn't answer within 30 s.",
    ],
  ])('reports a yt-dlp that %s as an error with the reason', async (_label, answer, message) => {
    const bin = await binDir(unique('check-yt/fail'), ['yt-dlp'])
    const ytdlp = path.join(bin, 'yt-dlp')
    const { probe } = stubProbe({ 'yt-dlp': answer(ytdlp) })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toEqual({
      status: 'error',
      path: ytdlp,
      source: 'path',
      message,
    })
  })

  it('reports output that is not a yt-dlp version as an error naming the file', async () => {
    const bin = await binDir('check-yt/garbage', ['yt-dlp'])
    const { probe } = stubProbe({ 'yt-dlp': exited('youtube-dl 2021.12.17\n') })
    expect(await checkYtdlp({ PATH: bin }, NOW, probe)).toMatchObject({
      status: 'error',
      message: `${path.join(bin, 'yt-dlp')} printed no yt-dlp version we understand.`,
    })
  })

  it('rethrows a failure that is not a spawn error, so bugs are not hidden as a status', async () => {
    const bin = await binDir('check-yt/bug', ['yt-dlp'])
    const { probe } = stubProbe({ 'yt-dlp': new TypeError('bug in run') })
    await expect(checkYtdlp({ PATH: bin }, NOW, probe)).rejects.toThrow('bug in run')
  })
})

describe('checkFf', () => {
  const found = (p: string) => ({ kind: 'found', path: p, source: 'path' }) as const

  it('reports ffmpeg with its major, minimum and MP3 encoder', async () => {
    const { probe, calls } = stubProbe({ ffmpeg: recorded.ffmpeg })
    expect(await checkFf('ffmpeg', found('/opt/homebrew/bin/ffmpeg'), probe)).toStrictEqual({
      status: 'ok',
      path: '/opt/homebrew/bin/ffmpeg',
      source: 'path',
      version: '8.0',
      major: 8,
      meetsMinimum: true,
      mp3: true,
    })
    expect(calls[0]?.argv).toEqual(['-version'])
  })

  it('reports ffprobe without an mp3 field', async () => {
    const { probe, calls } = stubProbe({ ffprobe: recorded.ffprobe })
    expect(await checkFf('ffprobe', found('/opt/homebrew/bin/ffprobe'), probe)).toStrictEqual({
      status: 'ok',
      path: '/opt/homebrew/bin/ffprobe',
      source: 'path',
      version: '8.0',
      major: 8,
      meetsMinimum: true,
    })
    expect(calls[0]?.argv).toEqual(['-version'])
  })

  it('omits an unknown major and treats it as below the minimum', async () => {
    const { probe } = stubProbe({ ffmpeg: exited('ffmpeg version custom-build Copyright\n') })
    const health = await checkFf('ffmpeg', found('/usr/local/bin/ffmpeg'), probe)
    expect(health).toStrictEqual({
      status: 'ok',
      path: '/usr/local/bin/ffmpeg',
      source: 'path',
      version: 'custom-build',
      meetsMinimum: false,
      mp3: false,
    })
  })

  it('flags ffmpeg 7 as below the minimum', async () => {
    const { probe } = stubProbe({ ffmpeg: exited('ffmpeg version 7.1.1 Copyright\n') })
    expect(await checkFf('ffmpeg', found('/usr/local/bin/ffmpeg'), probe)).toMatchObject({
      major: 7,
      meetsMinimum: false,
    })
  })

  it('rejects ffmpeg output where ffprobe was expected', async () => {
    const { probe } = stubProbe({ ffprobe: recorded.ffmpeg })
    expect(await checkFf('ffprobe', found('/opt/ff/ffprobe'), probe)).toEqual({
      status: 'error',
      path: '/opt/ff/ffprobe',
      source: 'path',
      message: '/opt/ff/ffprobe printed no ffprobe version we understand.',
    })
  })

  it('passes missing and broken locations through without probing', async () => {
    const { probe, calls } = stubProbe({})
    expect(await checkFf('ffmpeg', { kind: 'missing', message: 'not here' }, probe)).toEqual({
      status: 'missing',
      message: 'not here',
    })
    const broken = { kind: 'broken', path: '/x/ffprobe', source: 'env', message: 'nope' } as const
    expect(await checkFf('ffprobe', broken, probe)).toEqual({
      status: 'error',
      path: '/x/ffprobe',
      source: 'env',
      message: 'nope',
    })
    expect(calls).toEqual([])
  })
})

describe('checkJsRuntimes', () => {
  const ourNode = {
    name: 'node',
    path: process.execPath,
    version: process.versions.node,
    supported: true,
  }

  it('always offers our own Node', async () => {
    const empty = await dir('js/empty')
    const { probe, calls } = stubProbe({})
    expect(await checkJsRuntimes({ PATH: empty }, probe)).toEqual([ourNode])
    expect(calls).toEqual([])
  })

  it('lists deno from PATH first, in yt-dlp’s priority order', async () => {
    const bin = await binDir('js/deno', ['deno'])
    const { probe, calls } = stubProbe({ deno: recorded.deno })
    expect(await checkJsRuntimes({ PATH: bin }, probe)).toEqual([
      { name: 'deno', path: path.join(bin, 'deno'), version: '2.9.7', supported: true },
      ourNode,
    ])
    expect(calls[0]?.argv).toEqual(['--version'])
  })

  it('lists an old deno as unsupported', async () => {
    const bin = await binDir('js/old-deno', ['deno'])
    const { probe } = stubProbe({ deno: exited('deno 2.2.12 (stable, release, x86_64)\n') })
    expect((await checkJsRuntimes({ PATH: bin }, probe))[0]).toMatchObject({
      name: 'deno',
      version: '2.2.12',
      supported: false,
    })
  })

  it.each([
    ['fails to start', spawnError('deno', 'ENOENT')],
    ['exits with an error', exited('', { exitCode: 1 })],
    ['prints something else', exited('v24.12.0\n')],
  ])('leaves out a deno that %s', async (_label, answer) => {
    const bin = await binDir(unique('js/bad-deno'), ['deno'])
    const { probe } = stubProbe({ deno: answer })
    expect(await checkJsRuntimes({ PATH: bin }, probe)).toEqual([ourNode])
  })
})

describe('checkHealth', () => {
  const allTools = ['yt-dlp', 'ffmpeg', 'ffprobe'] as const

  it('is ok with the recorded Homebrew tools, and matches the contract', async () => {
    const bin = await binDir('health/all', allTools)
    const { probe } = stubProbe(recorded)
    const health = await checkHealth({ PATH: bin }, NOW, probe)
    expect(HealthSchema.parse(health)).toStrictEqual(health)
    expect(health).toMatchObject({
      ok: true,
      checkedAt: '2026-10-02T08:00:00.000Z',
      ytdlp: { status: 'ok', version: '2026.08.19', ageDays: 44, stale: false },
      ffmpeg: { status: 'ok', version: '8.0', major: 8, meetsMinimum: true, mp3: true },
      ffprobe: { status: 'ok', version: '8.0', major: 8, meetsMinimum: true },
      jsRuntimes: [{ name: 'node', path: process.execPath, supported: true }],
    })
  })

  it('never rejects when nothing is installed: every tool is reported missing', async () => {
    const empty = await dir('health/empty')
    const { probe } = stubProbe({})
    const health = await checkHealth({ PATH: empty }, NOW, probe)
    expect(HealthSchema.parse(health)).toStrictEqual(health)
    expect(health).toMatchObject({
      ok: false,
      ytdlp: { status: 'missing' },
      ffmpeg: { status: 'missing' },
      ffprobe: { status: 'missing' },
    })
  })

  it.each([
    ['yt-dlp is below the minimum release', { 'yt-dlp': exited('2025.10.22\n') }],
    ['ffmpeg is older than 8', { ffmpeg: exited('ffmpeg version 7.1.1\n') }],
    ['ffprobe is older than 8', { ffprobe: exited('ffprobe version 7.1.1\n') }],
    ['ffprobe’s major is unknown', { ffprobe: exited('ffprobe version custom-build\n') }],
    ['yt-dlp fails', { 'yt-dlp': exited('', { exitCode: 1 }) }],
  ])('is not ok when %s', async (_label, override) => {
    const bin = await binDir(unique('health/not-ok'), allTools)
    const { probe } = stubProbe({ ...recorded, ...override })
    expect((await checkHealth({ PATH: bin }, NOW, probe)).ok).toBe(false)
  })

  it('is not ok when ffprobe is missing', async () => {
    const bin = await binDir('health/no-ffprobe', ['yt-dlp', 'ffmpeg'])
    const { probe } = stubProbe(recorded)
    const health = await checkHealth({ PATH: bin }, NOW, probe)
    expect(health).toMatchObject({ ok: false, ffprobe: { status: 'missing' } })
  })

  it('stays ok when yt-dlp is merely stale (a warning, not a failure)', async () => {
    const bin = await binDir('health/stale', allTools)
    const { probe } = stubProbe(recorded)
    const health = await checkHealth({ PATH: bin }, new Date('2026-12-01T00:00:00Z'), probe)
    expect(health).toMatchObject({ ok: true, ytdlp: { ageDays: 104, stale: true } })
  })

  it('stays ok without libmp3lame (only MP3 downloads need it)', async () => {
    const bin = await binDir('health/no-lame', allTools)
    const { probe } = stubProbe({ ...recorded, ffmpeg: exited('ffmpeg version 8.0\n') })
    const health = await checkHealth({ PATH: bin }, NOW, probe)
    expect(health).toMatchObject({ ok: true, ffmpeg: { mp3: false } })
  })

  it('uses the overrides from the env it is given', async () => {
    const ytdlp = await file('health/env/yt-dlp_macos')
    const ff = await binDir('health/env/ff', ['ffmpeg', 'ffprobe'])
    const env: EngineEnv = { YTDLP_PATH: ytdlp, FFMPEG_PATH: ff, PATH: await dir('health/env/x') }
    const { probe } = stubProbe({ ...recorded, 'yt-dlp_macos': recorded['yt-dlp'] })
    expect(await checkHealth(env, NOW, probe)).toMatchObject({
      ok: true,
      ytdlp: { path: ytdlp, source: 'env' },
      ffmpeg: { path: path.join(ff, 'ffmpeg'), source: 'env' },
      ffprobe: { path: path.join(ff, 'ffprobe'), source: 'env' },
    })
  })

  it('probes the tools concurrently, so one slow tool does not delay the others', async () => {
    const bin = await binDir('health/parallel', [...allTools, 'deno'])
    let inFlight = 0
    let maxInFlight = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const answers: Record<string, RunResult> = recorded
    const slowRun: typeof run = async (bin) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (inFlight === 4) release()
      await gate
      inFlight--
      return answers[path.basename(bin)] ?? exited('', { exitCode: 127 })
    }
    const health = await checkHealth({ PATH: bin }, NOW, { run: slowRun, timeoutMs: 1_000 })
    expect(maxInFlight).toBe(4)
    expect(health.ok).toBe(true)
  })

  // The API reports `ok`; the boot log and the UI list healthProblems. They must never disagree
  // about whether the engine can run.
  describe('agrees with healthProblems', () => {
    /** 104 days after the recorded yt-dlp 2026.08.19, so it is stale. */
    const LATER = new Date('2026-12-01T00:00:00Z')
    const lame = 'configuration: --enable-libmp3lame\n'
    type EngineState = {
      tools?: readonly string[]
      answers?: Record<string, Answer>
      now?: Date
      /** Pretend our own Node is this version. */
      node?: string
    }

    it.each<[string, EngineState, boolean, string[]]>([
      ['all tools are ok', {}, true, []],
      ['yt-dlp is merely stale', { now: LATER }, true, ['warning yt-dlp']],
      [
        'yt-dlp is below the minimum release',
        { answers: { 'yt-dlp': exited('2025.10.22\n') } },
        false,
        ['error yt-dlp'],
      ],
      [
        'yt-dlp fails',
        { answers: { 'yt-dlp': exited('', { exitCode: 1 }) } },
        false,
        ['error yt-dlp'],
      ],
      [
        'nothing is installed',
        { tools: [] },
        false,
        ['error yt-dlp', 'error ffmpeg', 'error ffprobe'],
      ],
      ['ffprobe is missing', { tools: ['yt-dlp', 'ffmpeg'] }, false, ['error ffprobe']],
      [
        'ffmpeg is older than 8',
        { answers: { ffmpeg: exited(`ffmpeg version 7.1.1\n${lame}`) } },
        false,
        ['error ffmpeg'],
      ],
      [
        'ffmpeg’s major is unknown',
        { answers: { ffmpeg: exited(`ffmpeg version custom-build\n${lame}`) } },
        false,
        ['error ffmpeg'],
      ],
      [
        'ffprobe’s major is unknown',
        { answers: { ffprobe: exited('ffprobe version custom-build\n') } },
        false,
        ['error ffprobe'],
      ],
      [
        'ffmpeg has no libmp3lame',
        { answers: { ffmpeg: exited('ffmpeg version 8.0\n') } },
        true,
        ['warning ffmpeg'],
      ],
      [
        'yt-dlp is stale and ffmpeg has no libmp3lame',
        { now: LATER, answers: { ffmpeg: exited('ffmpeg version 8.0\n') } },
        true,
        ['warning yt-dlp', 'warning ffmpeg'],
      ],
      [
        'there is no supported JS runtime',
        {
          tools: [...allTools, 'deno'],
          answers: { deno: exited('deno 2.2.12 (stable, release, aarch64-apple-darwin)\n') },
          node: '20.19.0',
        },
        false,
        ['error js-runtime'],
      ],
      [
        'deno is supported but our Node is too old',
        { tools: [...allTools, 'deno'], node: '20.19.0' },
        true,
        [],
      ],
    ])('when %s', async (_label, state, ok, problems) => {
      const bin = await binDir(unique('health/agree'), state.tools ?? allTools)
      const { probe } = stubProbe({ ...recorded, ...state.answers })
      const check = () => checkHealth({ PATH: bin }, state.now ?? NOW, probe)
      const health = state.node === undefined ? await check() : await asNode(state.node, check)

      const found = healthProblems(health)
      expect(found.map(({ severity, tool }) => `${severity} ${tool}`)).toEqual(problems)
      expect(health.ok).toBe(ok)
      expect(health.ok).toBe(!found.some((problem) => problem.severity === 'error'))
    })
  })
})
