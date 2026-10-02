import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.ts'
import { type RunResult, SpawnError } from './engine/run.ts'
import { type AfterListenDeps, afterListen, type OpenBrowserDeps, openBrowser } from './startup.ts'

const URL = 'http://127.0.0.1:4747/'

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 40,
  ...overrides,
})

/** openBrowser's deps with a fake run; nothing is ever spawned. */
function openDeps(platform: NodeJS.Platform, run: OpenBrowserDeps['run']) {
  return {
    platform,
    run: vi.fn<OpenBrowserDeps['run']>(run),
    log: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
  }
}

describe('openBrowser', () => {
  it('runs /usr/bin/open with exactly the URL on macOS, with a short timeout', async () => {
    const deps = openDeps('darwin', async () => result())
    await openBrowser(URL, deps)
    expect(deps.run).toHaveBeenCalledOnce()
    const [bin, argv, options] = deps.run.mock.calls[0] ?? []
    expect(bin).toBe('/usr/bin/open')
    expect(argv).toStrictEqual([URL])
    expect(options).toMatchObject({ timeoutMs: 10_000 })
    expect(deps.log).not.toHaveBeenCalled()
    expect(deps.warn).not.toHaveBeenCalled()
  })

  it.each([
    [
      'open exits non-zero',
      async () => result({ exitCode: 1, stderr: 'LSOpenURLsWithRole() failed: -10814\nmore\n' }),
      'open exited with 1: LSOpenURLsWithRole() failed: -10814',
    ],
    [
      'open is killed by a signal',
      async () => result({ exitCode: null, signal: 'SIGKILL' }),
      'open exited with SIGKILL',
    ],
    [
      'open hangs past the timeout',
      async () => result({ exitCode: null, signal: 'SIGINT', timedOut: true }),
      'open timed out after 10 s',
    ],
    [
      'open cannot be started',
      async () => {
        throw new SpawnError('/usr/bin/open', Object.assign(new Error('nope'), { code: 'ENOENT' }))
      },
      'Cannot start /usr/bin/open: ENOENT',
    ],
  ])('only warns when %s', async (_label, run, reason) => {
    const deps = openDeps('darwin', run)
    await expect(openBrowser(URL, deps)).resolves.toBeUndefined()
    expect(deps.warn).toHaveBeenCalledExactlyOnceWith(
      `[server] Could not open the browser (${reason}). Open ${URL} yourself.`,
    )
  })

  it.each(['linux', 'win32'] as const)('prints the URL on %s instead of opening it', async (os) => {
    const deps = openDeps(os, async () => result())
    await openBrowser(URL, deps)
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(`[server] Open ${URL} in your browser.`)
  })
})

describe('afterListen', () => {
  let root = ''
  let built = ''
  let missing = ''
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-startup-'))
    built = path.join(root, 'dist')
    missing = path.join(root, 'missing')
    await mkdir(built)
    await writeFile(path.join(built, 'index.html'), '<!doctype html>')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Runs afterListen for `argv` the way index.ts does, with a fake opener. */
  async function start(argv: string[], webDist = built) {
    const deps = {
      openBrowser: vi.fn<AfterListenDeps['openBrowser']>(async () => {}),
      warn: vi.fn<AfterListenDeps['warn']>(),
    }
    await afterListen(loadConfig({ DJS_WEB_DIST: webDist }, argv), 4747, deps)
    return deps
  }

  it('opens exactly the server URL with --open', async () => {
    const deps = await start(['--open'])
    expect(deps.openBrowser).toHaveBeenCalledExactlyOnceWith(URL)
    expect(deps.warn).not.toHaveBeenCalled()
  })

  it('opens the bound port, not the default one', async () => {
    const deps = {
      openBrowser: vi.fn<AfterListenDeps['openBrowser']>(async () => {}),
      warn: vi.fn<AfterListenDeps['warn']>(),
    }
    await afterListen({ dev: false, open: true, webDist: built }, 5050, deps)
    expect(deps.openBrowser).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5050/')
  })

  it.each([
    ['without --open', []],
    ['with --dev', ['--dev']],
    ['with --dev and --open', ['--dev', '--open']],
  ])('never opens the browser %s', async (_label, argv) => {
    const deps = await start(argv)
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })

  it('warns once when there is no built UI, and still opens the browser', async () => {
    const deps = await start(['--open'], missing)
    expect(deps.warn).toHaveBeenCalledExactlyOnceWith(
      `[server] No built UI in ${missing}. Run \`pnpm build\` (pnpm start does).`,
    )
    expect(deps.openBrowser).toHaveBeenCalledExactlyOnceWith(URL)
  })

  it('does not look for a built UI with --dev, where Vite serves it', async () => {
    const deps = await start(['--dev'], missing)
    expect(deps.warn).not.toHaveBeenCalled()
  })

  it('warns when the dist dir exists but has no index.html', async () => {
    const empty = path.join(root, 'empty')
    await mkdir(empty, { recursive: true })
    const deps = await start([], empty)
    expect(deps.warn).toHaveBeenCalledOnce()
  })
})
