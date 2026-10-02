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

/** A rule of the fake's manifest (fixtures/fake-yt-dlp.json); the fake documents each field. */
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
  note?: string
}

/** One invocation of the fake, from its FAKE_YTDLP_CALLS log. `url` is null for --version. */
export type FakeYtdlpCall = { argv: string[]; url: string | null; time: number; pid: number }

export type FakeYtdlpKnobs = {
  FAKE_YTDLP_VERSION?: string
  FAKE_YTDLP_DELAY_MS?: string
  FAKE_YTDLP_HANG?: string
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
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) knobs[name] = value
  }
  await writeFile(path.join(dir, '.yt-dlp.fake.json'), JSON.stringify(knobs, null, 2))
  await symlink(FAKE_YTDLP, link)

  const calls = async (): Promise<FakeYtdlpCall[]> => {
    let text: string
    try {
      text = await readFile(callsFile, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as FakeYtdlpCall)
  }
  const waitForCalls = async (count: number): Promise<FakeYtdlpCall[]> => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const seen = await calls()
      if (seen.length >= count) return seen
      if (Date.now() > deadline) {
        throw new Error(`fake yt-dlp: expected ${count} calls within 10 s, saw ${seen.length}`)
      }
      await delay(10)
    }
  }
  return { path: link, env: { YTDLP_PATH: link, ...knobs }, calls, waitForCalls }
}

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
