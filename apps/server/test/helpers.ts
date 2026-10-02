// Shared helpers for the tests in this directory. Not a test file; never import from src/.
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
