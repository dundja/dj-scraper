import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  FfmpegHealth,
  FfprobeHealth,
  Health,
  JsRuntime,
  ToolSource,
  YtdlpHealth,
} from '@dj-scraper/shared'
import { type EngineBins, StepError } from '../jobs/types.ts'
import { type RunResult, run, SpawnError } from './run.ts'
import {
  isSupportedNode,
  meetsFfmpegMinimum,
  parseDenoVersion,
  parseFfVersion,
  parseYtdlpVersion,
  ytdlpFreshness,
} from './versions.ts'

/** Generous: a PyInstaller onefile yt-dlp took ~12 s per start on a Mac with endpoint security. */
export const PROBE_TIMEOUT_MS = 30_000

export const PROBE_ARGV = {
  ytdlp: ['--ignore-config', '--no-update', '--version'],
  ffmpeg: ['-version'],
  ffprobe: ['-version'],
  deno: ['--version'],
} as const

/** Where binaries come from: the overrides from config, and the PATH to search otherwise. */
export type EngineEnv = { YTDLP_PATH?: string; FFMPEG_PATH?: string; PATH?: string }

export type Executable = 'ok' | 'missing' | 'not_a_file' | 'not_executable'

/** stat follows symlinks (/opt/homebrew/bin/yt-dlp → Cellar); a dangling link counts as missing. */
export async function checkExecutable(file: string): Promise<Executable> {
  try {
    // Directories pass the X_OK check.
    if (!(await stat(file)).isFile()) return 'not_a_file'
  } catch {
    return 'missing'
  }
  try {
    await access(file, constants.X_OK)
    return 'ok'
  } catch {
    return 'not_executable'
  }
}

/** PATH entries worth searching: absolute only (an empty or relative entry means the cwd), deduped. */
export function pathDirs(pathEnv: string | undefined): string[] {
  const dirs = (pathEnv ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir))
  return [...new Set(dirs.map((dir) => path.resolve(dir)))]
}

/** Like `command -v`, without spawning: the first executable regular file named `name`. */
export async function findOnPath(
  name: string,
  pathEnv: string | undefined,
): Promise<string | null> {
  for (const dir of pathDirs(pathEnv)) {
    const file = path.join(dir, name)
    if ((await checkExecutable(file)) === 'ok') return file
  }
  return null
}

/**
 * ffprobe for an FFMPEG_PATH that names the ffmpeg binary, resolved like yt-dlp's
 * --ffmpeg-location: the same name with ffmpeg swapped for ffprobe (ffmpeg-8 → ffprobe-8), else
 * `ffprobe`, both in the same directory. yt-dlp never falls back to PATH here, so neither do we.
 */
export function ffprobeCandidates(ffmpegFile: string): string[] {
  const dir = path.dirname(ffmpegFile)
  const base = path.basename(ffmpegFile)
  const swapped = base.includes('ffmpeg')
    ? [path.join(dir, base.replaceAll('ffmpeg', 'ffprobe'))]
    : []
  return [...new Set([...swapped, path.join(dir, 'ffprobe')])]
}

export type Located =
  | { kind: 'found'; path: string; source: ToolSource }
  | { kind: 'missing'; message: string }
  | { kind: 'broken'; path: string; source: ToolSource; message: string }

/** YTDLP_PATH wins and never falls back to PATH, so a broken override isn't silently ignored. */
export async function locateYtdlp(env: EngineEnv): Promise<Located> {
  if (env.YTDLP_PATH) return fromOverride(env.YTDLP_PATH, 'YTDLP_PATH')
  return fromPath('yt-dlp', env.PATH, 'brew install yt-dlp', 'YTDLP_PATH')
}

/** FFMPEG_PATH may be the ffmpeg binary or a directory holding ffmpeg and ffprobe. */
export async function locateFfmpeg(env: EngineEnv): Promise<{ ffmpeg: Located; ffprobe: Located }> {
  const override = env.FFMPEG_PATH
  if (!override) {
    const [ffmpeg, ffprobe] = await Promise.all([
      fromPath('ffmpeg', env.PATH, 'brew install ffmpeg', 'FFMPEG_PATH'),
      fromPath('ffprobe', env.PATH, 'brew install ffmpeg', 'FFMPEG_PATH'),
    ])
    return { ffmpeg, ffprobe }
  }
  const isDir = await stat(override).then(
    (stats) => stats.isDirectory(),
    () => false,
  )
  if (isDir) {
    return {
      ffmpeg: await fromOverride(path.join(override, 'ffmpeg'), 'FFMPEG_PATH'),
      ffprobe: await fromOverride(path.join(override, 'ffprobe'), 'FFMPEG_PATH'),
    }
  }
  const candidates = ffprobeCandidates(override)
  let ffprobe = path.join(path.dirname(override), 'ffprobe')
  for (const candidate of candidates) {
    if ((await checkExecutable(candidate)) !== 'missing') {
      ffprobe = candidate
      break
    }
  }
  return {
    ffmpeg: await fromOverride(override, 'FFMPEG_PATH'),
    ffprobe: await fromOverride(ffprobe, 'FFMPEG_PATH'),
  }
}

async function fromPath(
  name: string,
  pathEnv: string | undefined,
  install: string,
  variable: string,
): Promise<Located> {
  const found = await findOnPath(name, pathEnv)
  return found
    ? { kind: 'found', path: found, source: 'path' }
    : { kind: 'missing', message: `${name} is not on PATH. Run \`${install}\` or set ${variable}.` }
}

async function fromOverride(file: string, variable: string): Promise<Located> {
  const problem: Record<Exclude<Executable, 'ok'>, string> = {
    missing: `${variable}: ${file} does not exist.`,
    not_a_file: `${variable}: ${file} is not a file.`,
    not_executable: `${variable}: ${file} is not executable (chmod +x).`,
  }
  const state = await checkExecutable(file)
  return state === 'ok'
    ? { kind: 'found', path: file, source: 'env' }
    : { kind: 'broken', path: file, source: 'env', message: problem[state] }
}

/**
 * yt-dlp, ffmpeg and ffprobe for a download, found as the health check finds them (an override,
 * else PATH) but without running them: cheap enough for every request and every attempt, so
 * installing a tool needs no restart. Throws `StepError('engine_missing')`, whose message names no
 * path (it ends up in a job's error).
 */
export async function locateEngine(env: EngineEnv): Promise<EngineBins> {
  const [ytdlp, ff] = await Promise.all([locateYtdlp(env), locateFfmpeg(env)])
  return {
    ytdlp: usable('yt-dlp', ytdlp, 'YTDLP_PATH'),
    ffmpeg: usable('ffmpeg', ff.ffmpeg, 'FFMPEG_PATH'),
    ffprobe: usable('ffprobe', ff.ffprobe, 'FFMPEG_PATH'),
  }
}

function usable(name: string, located: Located, variable: string): string {
  if (located.kind === 'found') return located.path
  // A missing tool's message names no path; a broken override's does.
  throw new StepError(
    'engine_missing',
    located.kind === 'missing'
      ? located.message
      : `${variable} doesn't point at a working ${name}. Fix it, then retry.`,
  )
}

/** Why a finished probe failed, in words; null when it exited 0 (then parse its stdout). */
export function probeFailure(name: string, result: RunResult, timeoutMs: number): string | null {
  if (result.timedOut) return `${name} didn't answer within ${formatDuration(timeoutMs)}.`
  if (result.exitCode === 0) return null
  const last = result.stderr.trim().split(/\r?\n/).at(-1)
  const how = result.signal
    ? `was killed by ${result.signal}`
    : `exited with code ${result.exitCode}`
  return last ? `${name} ${how}: ${last}` : `${name} ${how}.`
}

const formatDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`)

/** Why a found binary couldn't start. It exists (checked first), so ENOENT means its #! interpreter is gone. */
export function spawnFailure(name: string, code: string): string {
  return code === 'ENOENT'
    ? `${name} can't start: the interpreter in its #! line is missing. Reinstall ${name}.`
    : `${name} can't start (${code}).`
}

export type Probe = { run: typeof run; timeoutMs: number }
const defaultProbe: Probe = { run, timeoutMs: PROBE_TIMEOUT_MS }

/** Runs a found binary's version command and parses stdout; any failure becomes a message. */
async function probeVersion<T>(
  name: string,
  file: string,
  argv: readonly string[],
  parse: (stdout: string) => T | null,
  probe: Probe,
): Promise<{ parsed: T } | { message: string }> {
  let result: RunResult
  try {
    result = await probe.run(file, argv, { timeoutMs: probe.timeoutMs, maxOutputBytes: 64 * 1024 })
  } catch (error) {
    if (error instanceof SpawnError) return { message: spawnFailure(name, error.code) }
    throw error
  }
  const failure = probeFailure(name, result, probe.timeoutMs)
  if (failure) return { message: failure }
  const parsed = parse(result.stdout)
  return parsed ? { parsed } : { message: `${file} printed no ${name} version we understand.` }
}

export async function checkYtdlp(
  env: EngineEnv,
  now: Date,
  probe = defaultProbe,
): Promise<YtdlpHealth> {
  const loc = await locateYtdlp(env)
  if (loc.kind === 'missing') return { status: 'missing', message: loc.message }
  const where = { path: loc.path, source: loc.source }
  if (loc.kind === 'broken') return { status: 'error', ...where, message: loc.message }
  const probed = await probeVersion('yt-dlp', loc.path, PROBE_ARGV.ytdlp, parseYtdlpVersion, probe)
  if ('message' in probed) return { status: 'error', ...where, message: probed.message }
  const { version, releaseDate } = probed.parsed
  return { status: 'ok', ...where, version, releaseDate, ...ytdlpFreshness(releaseDate, now) }
}

export function checkFf(program: 'ffmpeg', loc: Located, probe?: Probe): Promise<FfmpegHealth>
export function checkFf(program: 'ffprobe', loc: Located, probe?: Probe): Promise<FfprobeHealth>
export async function checkFf(
  program: 'ffmpeg' | 'ffprobe',
  loc: Located,
  probe = defaultProbe,
): Promise<FfmpegHealth | FfprobeHealth> {
  if (loc.kind === 'missing') return { status: 'missing', message: loc.message }
  const where = { path: loc.path, source: loc.source }
  if (loc.kind === 'broken') return { status: 'error', ...where, message: loc.message }
  const parse = (stdout: string) => parseFfVersion(stdout, program)
  const probed = await probeVersion(program, loc.path, PROBE_ARGV[program], parse, probe)
  if ('message' in probed) return { status: 'error', ...where, message: probed.message }
  const { version, major, mp3 } = probed.parsed
  const ok = {
    status: 'ok' as const,
    ...where,
    version,
    ...(major === undefined ? {} : { major }),
    meetsMinimum: meetsFfmpegMinimum(major),
  }
  return program === 'ffmpeg' ? { ...ok, mp3 } : ok
}

/** yt-dlp's priority order: deno (if on PATH and it runs), then our own Node. */
export async function checkJsRuntimes(env: EngineEnv, probe = defaultProbe): Promise<JsRuntime[]> {
  const runtimes: JsRuntime[] = []
  const deno = await findOnPath('deno', env.PATH)
  if (deno) {
    const probed = await probeVersion('deno', deno, PROBE_ARGV.deno, parseDenoVersion, probe)
    if ('parsed' in probed) runtimes.push({ name: 'deno', path: deno, ...probed.parsed })
  }
  const version = process.versions.node
  runtimes.push({
    name: 'node',
    path: process.execPath,
    version,
    supported: isSupportedNode(version),
  })
  return runtimes
}

/** Finds and probes every engine binary in parallel. Never rejects for a broken tool: that's a status. */
export async function checkHealth(
  env: EngineEnv,
  now: Date,
  probe = defaultProbe,
): Promise<Health> {
  const ff = await locateFfmpeg(env)
  const [ytdlp, ffmpeg, ffprobe, jsRuntimes] = await Promise.all([
    checkYtdlp(env, now, probe),
    checkFf('ffmpeg', ff.ffmpeg, probe),
    checkFf('ffprobe', ff.ffprobe, probe),
    checkJsRuntimes(env, probe),
  ])
  const ok =
    ytdlp.status === 'ok' &&
    ytdlp.meetsMinimum &&
    ffmpeg.status === 'ok' &&
    ffmpeg.meetsMinimum &&
    ffprobe.status === 'ok' &&
    ffprobe.meetsMinimum &&
    jsRuntimes.some((runtime) => runtime.supported)
  return { ok, checkedAt: now.toISOString(), ytdlp, ffmpeg, ffprobe, jsRuntimes }
}
