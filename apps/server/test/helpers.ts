// Shared helpers for the tests in this directory. Not a test file; never import from src/.
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** apps/server, the cwd `pnpm start` runs the entry from. */
export const SERVER_DIR = path.resolve(import.meta.dirname, '..')

/** The one fake engine binary; see the comment at its top for why tests symlink it. */
export const FAKE_TOOL = path.join(import.meta.dirname, 'fake-tool.sh')

/** A recorded engine output from test/fixtures/engine (see its README for versions and dates). */
export const engineFixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'engine', name), 'utf8')

export const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(path.join(tmpdir(), `dj-scraper-${prefix}-`))

/** The env that keeps a spawned server entry off the user's real data dir and home folder. */
export type ServerDirsEnv = { DJS_DATA_DIR: string; HOME: string }

/**
 * Every spawn of the server entry (src/index.ts) spreads this into its env: a fresh data dir and
 * home folder under `root` (removed with it), so the server never touches the user's
 * ~/Library/Application Support/DJ Scraper or ~/Music. HOME exists, as on a Mac; the data dir
 * doesn't yet, as on a first run (its parent does). Servers that must share a data dir share one env.
 */
export async function serverEnv(root: string): Promise<ServerDirsEnv> {
  const dir = await mkdtemp(path.join(root, 'server-'))
  const home = path.join(dir, 'home')
  await mkdir(home)
  return { DJS_DATA_DIR: path.join(dir, 'data'), HOME: home }
}

/**
 * Writes `body` to dir/name with the given mode (755 by default) and returns the absolute path.
 * Only for files that must fail before they run (bad #!, no #!): endpoint security scans every
 * new executable on its first successful exec, which is slow. Use writeFakeTool for anything
 * that should run.
 */
export async function writeExecutable(
  dir: string,
  name: string,
  body: string,
  mode = 0o755,
): Promise<string> {
  const file = path.join(dir, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
  await chmod(file, mode)
  return file
}

export type FakeToolBehavior = {
  /** Arguments it must be called with; any other argv exits 64 with "unexpected argv: …". */
  argv?: readonly string[]
  stdout?: string
  stderr?: string
  exitCode?: number
  /** Kills itself with this signal after printing, e.g. 'KILL'. */
  signal?: string
  /** Sleeps instead of exiting, until stopped. */
  hang?: boolean
}

/** A fake engine binary at dir/name: a symlink to fake-tool.sh, plus its behavior files. */
export async function writeFakeTool(
  dir: string,
  name: string,
  behavior: FakeToolBehavior,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const spec = (ext: string) => path.join(dir, `.${name}.${ext}`)
  const { argv, stdout, stderr, exitCode, signal, hang } = behavior
  if (argv !== undefined) await writeFile(spec('argv'), argv.join(' '))
  if (stdout !== undefined) await writeFile(spec('stdout'), stdout)
  if (stderr !== undefined) await writeFile(spec('stderr'), stderr)
  if (exitCode !== undefined) await writeFile(spec('exit'), String(exitCode))
  if (signal !== undefined) await writeFile(spec('signal'), signal)
  if (hang) await writeFile(spec('hang'), '')
  const file = path.join(dir, name)
  await symlink(FAKE_TOOL, file)
  return file
}

/** The fake yt-dlp that replays test/fixtures; see the comment at its top. */
export const FAKE_YTDLP = path.join(import.meta.dirname, 'fake-yt-dlp.mjs')

/** The fake ffmpeg and ffprobe (one script, by link name); see the comment at its top. */
export const FAKE_FFMPEG = path.join(import.meta.dirname, 'fake-ffmpeg.mjs')

/**
 * A rule of the fake's manifest (fixtures/fake-yt-dlp.json); the fake documents each field. A rule
 * with `download` answers download calls (the design's §4 argv) instead of -J calls.
 */
export type FakeYtdlpRule = {
  url: string
  playlist?: 'yes' | 'no'
  args?: readonly (string | readonly string[])[]
  /** Relative to test/fixtures, or absolute (for files a test writes itself). */
  stdout?: string
  stderr?: string
  exit?: number
  delayMs?: number
  hang?: boolean
  /** A case of test/fixtures/downloads, or the absolute prefix of a test's own `.stdout.log`/`.stderr.log`. */
  download?: string
  /** The ffprobe JSON the downloaded file probes as (relative to test/fixtures, or absolute). */
  probe?: string
  /** Sleeps this long before every replayed line after the first. */
  lineDelayMs?: number
  /** Hangs until SIGINT after this many replayed lines. */
  hangAfter?: number
  note?: string
}

/** A rule that answers download calls by replaying a recorded case. */
export type FakeDownloadRule = FakeYtdlpRule & { download: string }

/** One invocation of the fake, from its FAKE_YTDLP_CALLS log. `url` is null for --version. */
export type FakeYtdlpCall = { argv: string[]; url: string | null; time: number; pid: number }

export type FakeYtdlpKnobs = {
  FAKE_YTDLP_VERSION?: string
  FAKE_YTDLP_DELAY_MS?: string
  FAKE_YTDLP_HANG?: string
  /** How long a download's forced wait (a START `available_at` in the future) lasts instead. */
  FAKE_YTDLP_WAIT_MS?: string
}

export type FakeYtdlp = {
  /** dir/yt-dlp, for YTDLP_PATH. */
  path: string
  /**
   * YTDLP_PATH plus every FAKE_YTDLP_* knob, for a spawned server: `{ ...process.env, ...env }`.
   * In-process run() calls need none of it: the knobs also sit in a file beside the link.
   */
  env: Record<string, string>
  /** Every invocation so far, in order. */
  calls: () => Promise<FakeYtdlpCall[]>
  /** Resolves once `count` invocations have started (the fake is then ready for SIGINT). */
  waitForCalls: (count: number) => Promise<FakeYtdlpCall[]>
}

/** The JSON lines a fake logged so far (none before its first call). */
async function readCalls<T>(file: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T)
}

/** Polls `calls` until it has `count` entries (10 s at most). */
async function waitForCalls<T>(
  name: string,
  calls: () => Promise<T[]>,
  count: number,
): Promise<T[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const seen = await calls()
    if (seen.length >= count) return seen
    if (Date.now() > deadline) {
      throw new Error(`${name}: expected ${count} calls within 10 s, saw ${seen.length}`)
    }
    await delay(10)
  }
}

/** Knobs as the fakes read them from `.<link>.fake.json`: only the ones that are set. */
function definedKnobs(knobs: Record<string, string | undefined>): Record<string, string> {
  const set: Record<string, string> = {}
  for (const [name, value] of Object.entries(knobs)) if (value !== undefined) set[name] = value
  return set
}

/**
 * The fake yt-dlp at dir/yt-dlp: a symlink to fake-yt-dlp.mjs, with its calls logged to
 * dir/.yt-dlp.calls.jsonl. `manifestRules` are tried before the recorded fixtures' rules, and
 * `env` sets knobs such as FAKE_YTDLP_HANG. `dir` must not hold a yt-dlp yet.
 */
export async function writeFakeYtdlp(
  dir: string,
  options: { manifestRules?: readonly FakeYtdlpRule[]; env?: FakeYtdlpKnobs } = {},
): Promise<FakeYtdlp> {
  await mkdir(dir, { recursive: true })
  const link = path.join(dir, 'yt-dlp')
  const callsFile = path.join(dir, '.yt-dlp.calls.jsonl')
  const knobs: Record<string, string> = { FAKE_YTDLP_CALLS: callsFile }
  if (options.manifestRules !== undefined) {
    const manifest = path.join(dir, '.yt-dlp.manifest.json')
    await writeFile(manifest, JSON.stringify({ rules: options.manifestRules }, null, 2))
    knobs.FAKE_YTDLP_MANIFEST = manifest
  }
  Object.assign(knobs, definedKnobs(options.env ?? {}))
  await writeFile(path.join(dir, '.yt-dlp.fake.json'), JSON.stringify(knobs, null, 2))
  await symlink(FAKE_YTDLP, link)

  const calls = () => readCalls<FakeYtdlpCall>(callsFile)
  return {
    path: link,
    env: { YTDLP_PATH: link, ...knobs },
    calls,
    waitForCalls: (count) => waitForCalls('fake yt-dlp', calls, count),
  }
}

/**
 * Knobs of the fake ffmpeg/ffprobe. A value may start with `<scopes>@`, a comma-separated list of
 * audio (ffmpeg writing audio), cover (ffmpeg writing an image), ffmpeg (both) and ffprobe.
 */
export type FakeFfmpegKnobs = {
  /** `[scopes@]<exit>:<stderr text>`: exit at once, writing nothing. Unscoped: ffmpeg. */
  FAKE_FFMPEG_FAIL?: string
  /** `[scopes@]1`: ffmpeg leaves a 0-byte output and hangs; ffprobe hangs. Unscoped: ffmpeg. */
  FAKE_FFMPEG_HANG?: string
  /** `[scopes@]1`: audio is written (or probed) at half its duration. Unscoped: audio. */
  FAKE_FFMPEG_SHORT?: string
  /** `[scopes@]1`: audio is written (or probed) without tags. Unscoped: audio. */
  FAKE_FFMPEG_DROP_TAGS?: string
}

/** One invocation of the fake ffmpeg or ffprobe, from their shared FAKE_FFMPEG_CALLS log. */
export type FakeFfmpegCall = {
  tool: 'ffmpeg' | 'ffprobe'
  argv: string[]
  time: number
  pid: number
}

export type FakeFfmpeg = {
  /** dir/ffmpeg, for FFMPEG_PATH (the server finds ffprobe beside it). */
  ffmpeg: string
  ffprobe: string
  /** FFMPEG_PATH plus every FAKE_FFMPEG_* knob, for a spawned server. */
  env: Record<string, string>
  /** Every ffmpeg and ffprobe invocation so far, in order. */
  calls: () => Promise<FakeFfmpegCall[]>
  waitForCalls: (count: number) => Promise<FakeFfmpegCall[]>
}

/**
 * The fake ffmpeg and ffprobe at dir/ffmpeg and dir/ffprobe: symlinks to fake-ffmpeg.mjs, both
 * logging to dir/.ffmpeg.calls.jsonl, with `env`'s knobs in a file beside each link. `dir` must
 * not hold an ffmpeg or ffprobe yet.
 */
export async function writeFakeFfmpeg(
  dir: string,
  options: { env?: FakeFfmpegKnobs } = {},
): Promise<FakeFfmpeg> {
  await mkdir(dir, { recursive: true })
  const callsFile = path.join(dir, '.ffmpeg.calls.jsonl')
  const knobs = { FAKE_FFMPEG_CALLS: callsFile, ...definedKnobs(options.env ?? {}) }
  const links = { ffmpeg: path.join(dir, 'ffmpeg'), ffprobe: path.join(dir, 'ffprobe') }
  for (const [name, link] of Object.entries(links)) {
    await writeFile(path.join(dir, `.${name}.fake.json`), JSON.stringify(knobs, null, 2))
    await symlink(FAKE_FFMPEG, link)
  }
  const calls = () => readCalls<FakeFfmpegCall>(callsFile)
  return {
    ...links,
    env: { FFMPEG_PATH: links.ffmpeg, ...knobs },
    calls,
    waitForCalls: (count) => waitForCalls('fake ffmpeg', calls, count),
  }
}

export type FakeEngine = {
  /** Holds yt-dlp, ffmpeg and ffprobe; prepend it to PATH for a spawn that should find them there. */
  binDir: string
  ytdlp: FakeYtdlp
  ffmpeg: FakeFfmpeg
  /** YTDLP_PATH, FFMPEG_PATH and every knob, for a spawned server: `{ ...process.env, ...env }`. */
  env: Record<string, string>
}

/**
 * The whole fake engine in `binDir`: yt-dlp (writeFakeYtdlp, with `ytdlpRules` tried first) and
 * ffmpeg + ffprobe (writeFakeFfmpeg). A download through it leaves FAKEAUDIO files that the fake
 * ffmpeg converts and the fake ffprobe reads back.
 */
export async function writeFakeEngine(
  binDir: string,
  options: {
    ytdlpRules?: readonly FakeYtdlpRule[]
    ytdlpEnv?: FakeYtdlpKnobs
    ffmpegEnv?: FakeFfmpegKnobs
  } = {},
): Promise<FakeEngine> {
  const ytdlp = await writeFakeYtdlp(binDir, {
    ...(options.ytdlpRules === undefined ? {} : { manifestRules: options.ytdlpRules }),
    ...(options.ytdlpEnv === undefined ? {} : { env: options.ytdlpEnv }),
  })
  const ffmpeg = await writeFakeFfmpeg(
    binDir,
    options.ffmpegEnv === undefined ? {} : { env: options.ffmpegEnv },
  )
  return { binDir, ytdlp, ffmpeg, env: { ...ytdlp.env, ...ffmpeg.env } }
}

/** What a fake audio file tells the fake ffprobe (test/fake-media.mjs documents the format). */
export type FakeAudioHeader = {
  /** The recorded ffprobe JSON it is based on: relative to test/fixtures, absolute, or `synthetic:ogg`. */
  probe: string
  codec: string
  durationSec: number
  sampleRate: number
  channels: number
  bitRate?: number
  tags: Record<string, string>
  cover: boolean
}

export type FakeImageInfo = {
  format: 'jpeg' | 'png' | 'webp'
  width: number
  height: number
  probe?: string
}

export type FakeMedia =
  | {
      kind: 'audio'
      header: FakeAudioHeader
      payload: Buffer
      /** `aiff`: inside a FORM container's FAKE chunk. */
      container: 'plain' | 'aiff'
      /** The size of the ID3v2 tags in front of a plain file. */
      id3Bytes: number
    }
  | { kind: 'image'; info: FakeImageInfo }

const FAKE_AUDIO = 'FAKEAUDIO '
const FAKE_IMAGE = 'FAKEIMAGE '

/** The header of a file that ffprobe reports as the recorded `probe` (e.g. 'ffprobe/src-…json'). */
export function fakeSourceHeader(probe: string): FakeAudioHeader {
  const file = path.isAbsolute(probe) ? probe : path.join(import.meta.dirname, 'fixtures', probe)
  const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const streams = record(json).streams
  const audio = Array.isArray(streams)
    ? streams.map(record).find((stream) => stream.codec_type === 'audio')
    : undefined
  if (audio === undefined) throw new Error(`${probe} has no audio stream`)
  return {
    probe,
    codec: String(audio.codec_name),
    durationSec: Number(record(record(json).format).duration),
    sampleRate: Number(audio.sample_rate),
    channels: Number(audio.channels),
    ...(audio.bit_rate === undefined ? {} : { bitRate: Number(audio.bit_rate) }),
    tags: {},
    cover: false,
  }
}

/** A fake audio file: `FAKEAUDIO <header>\n` + payload. */
export const fakeAudioBytes = (
  header: FakeAudioHeader,
  payload: string | Uint8Array = 'fake audio\n',
): Buffer =>
  Buffer.concat([Buffer.from(`${FAKE_AUDIO}${JSON.stringify(header)}\n`), Buffer.from(payload)])

/** A fake image: the format's magic bytes, then `FAKEIMAGE <info>\n`. */
export function fakeImageBytes(info: FakeImageInfo): Buffer {
  const body = Buffer.from(`${FAKE_IMAGE}${JSON.stringify(info)}\n`)
  switch (info.format) {
    case 'jpeg':
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body, Buffer.from([0xff, 0xd9])])
    case 'png':
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body])
    case 'webp': {
      const riff = Buffer.alloc(12)
      riff.write('RIFF', 0, 'latin1')
      riff.writeUInt32LE(4 + body.length, 4)
      riff.write('WEBP', 8, 'latin1')
      return Buffer.concat([riff, body])
    }
  }
}

function isFakeAudioHeader(value: unknown): value is FakeAudioHeader {
  if (typeof value !== 'object' || value === null) return false
  const header = value as Record<string, unknown>
  const tags = header.tags
  return (
    typeof header.probe === 'string' &&
    typeof header.codec === 'string' &&
    typeof header.durationSec === 'number' &&
    Number.isInteger(header.sampleRate) &&
    Number.isInteger(header.channels) &&
    (header.bitRate === undefined || typeof header.bitRate === 'number') &&
    typeof tags === 'object' &&
    tags !== null &&
    Object.values(tags).every((tag) => typeof tag === 'string') &&
    typeof header.cover === 'boolean'
  )
}

function isFakeImageInfo(value: unknown): value is FakeImageInfo {
  if (typeof value !== 'object' || value === null) return false
  const info = value as Record<string, unknown>
  return (
    (info.format === 'jpeg' || info.format === 'png' || info.format === 'webp') &&
    typeof info.width === 'number' &&
    typeof info.height === 'number' &&
    (info.probe === undefined || typeof info.probe === 'string')
  )
}

/** The JSON in `bytes`, or undefined when it isn't JSON. */
function jsonIn(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

function parseFakeAudio(
  bytes: Buffer,
  container: 'plain' | 'aiff',
  id3Bytes: number,
): FakeMedia | undefined {
  const end = bytes.indexOf(0x0a)
  if (bytes.toString('latin1', 0, FAKE_AUDIO.length) !== FAKE_AUDIO || end === -1) return undefined
  const header = jsonIn(bytes.subarray(FAKE_AUDIO.length, end))
  if (!isFakeAudioHeader(header)) return undefined
  return { kind: 'audio', header, payload: bytes.subarray(end + 1), container, id3Bytes }
}

/**
 * Reads a file the fake engine wrote, independently of fake-media.mjs: skips leading ID3v2 tags,
 * finds the FAKE chunk of a FORM/AIFF (checking the FORM size and every chunk's bounds), and
 * reads fake images by their magic bytes. undefined: not fake media, or a broken container.
 */
export function readFakeMedia(data: Uint8Array): FakeMedia | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const text = (start: number, length: number) => bytes.toString('latin1', start, start + length)
  let offset = 0
  while (text(offset, 3) === 'ID3') {
    if (bytes.length < offset + 10) return undefined
    const size = bytes.subarray(offset + 6, offset + 10)
    if (size.some((byte) => byte > 0x7f)) return undefined
    const footer = (bytes.readUInt8(offset + 5) & 0x10) === 0 ? 0 : 10
    offset += 10 + size.reduce((total, byte) => (total << 7) | byte, 0) + footer
    if (offset > bytes.length) return undefined
  }
  if (text(offset, 4) === 'FORM') {
    if (
      text(offset + 8, 4) !== 'AIFF' ||
      bytes.readUInt32BE(offset + 4) !== bytes.length - offset - 8
    ) {
      return undefined
    }
    let audio: FakeMedia | undefined
    for (let at = offset + 12; at < bytes.length; ) {
      if (at + 8 > bytes.length) return undefined
      const length = bytes.readUInt32BE(at + 4)
      if (at + 8 + length > bytes.length) return undefined
      if (text(at, 4) === 'FAKE')
        audio = parseFakeAudio(bytes.subarray(at + 8, at + 8 + length), 'aiff', 0)
      at += 8 + length + (length % 2)
    }
    return audio
  }
  if (text(offset, FAKE_AUDIO.length) === FAKE_AUDIO) {
    return parseFakeAudio(bytes.subarray(offset), 'plain', offset)
  }
  const start = bytes.indexOf(FAKE_IMAGE)
  const end = bytes.indexOf(0x0a, start)
  if (offset !== 0 || start === -1 || start > 16 || end === -1) return undefined
  const info = jsonIn(bytes.subarray(start + FAKE_IMAGE.length, end))
  if (!isFakeImageInfo(info)) return undefined
  const magic =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpeg'
      : bytes[0] === 0x89 && text(1, 3) === 'PNG'
        ? 'png'
        : text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP'
          ? 'webp'
          : undefined
  return magic === info.format ? { kind: 'image', info } : undefined
}

export const readFakeMediaFile = async (file: string): Promise<FakeMedia | undefined> =>
  readFakeMedia(await readFile(file))

/** A port that was free a moment ago. Only for spawning a server that needs a fixed PORT. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'))
        else resolve(address.port)
      })
    })
  })

/** Today's (UTC) date as a yt-dlp stable version, so a fake yt-dlp is never stale. */
export const todaysYtdlpVersion = (now = new Date()): string =>
  now.toISOString().slice(0, 10).replaceAll('-', '.')

export type RawResponse = { status: number; headers: string; body: string }

/**
 * Sends raw bytes to 127.0.0.1:port (\n becomes \r\n) and parses the reply once the server closes
 * the socket. For requests fetch can't make: duplicate headers, un-normalized targets.
 */
export function rawRequest(port: number, request: string): Promise<RawResponse | 'closed'> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request.replaceAll('\n', '\r\n')))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    socket.on('error', reject)
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(data)
      if (match?.[1] === undefined) return resolve('closed')
      const split = data.indexOf('\r\n\r\n')
      resolve({
        status: Number(match[1]),
        headers: data.slice(0, split).toLowerCase(),
        body: data.slice(split + 4),
      })
    })
  })
}

/** The index.html of a fixture UI build (see writeWebDist). */
export const FIXTURE_INDEX =
  '<!doctype html><html><head><title>DJ Scraper fixture</title></head><body></body></html>\n'
/** A hashed asset of a fixture UI build, as Vite names them. */
export const FIXTURE_ASSET = { path: '/assets/index-Fx7a2B_c.js', body: "console.log('fixture')\n" }

/** Writes a minimal UI build (like apps/web/dist) to `dir` and returns `dir`. */
export async function writeWebDist(dir: string): Promise<string> {
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  await writeFile(path.join(dir, 'index.html'), FIXTURE_INDEX)
  await writeFile(path.join(dir, FIXTURE_ASSET.path), FIXTURE_ASSET.body)
  return dir
}
