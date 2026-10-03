import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type RunResult, type run, SpawnError } from '../engine/run.ts'
import { StepError } from '../jobs/types.ts'
import { REVEAL_TIMEOUT_MS, type RevealDeps, revealInFinder } from './reveal.ts'

// run() is faked here; test/reveal.test.ts runs it against a fake `open` binary.

let root = ''
let file = ''
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-reveal-'))
  file = path.join(root, 'Artist - Title.mp3')
  await writeFile(file, 'FAKEAUDIO')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const runResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 30,
  ...overrides,
})

const fakeRun = (answer: Partial<RunResult> = {}) =>
  vi.fn<typeof run>(async () => runResult(answer))

async function stepFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof StepError)) throw new Error(`expected a StepError, got ${String(error)}`)
  return error.info
}

const MOVED = {
  code: 'not_found',
  message: 'The file was moved, deleted, or its drive is unplugged',
} as const
const FAILED = { code: 'unknown', message: "The file couldn't be shown in Finder" } as const

describe('revealInFinder', () => {
  it('runs /usr/bin/open -R -- <file> with a 10 s timeout', async () => {
    const run = fakeRun()
    await expect(revealInFinder(file, { run })).resolves.toBeUndefined()
    expect(REVEAL_TIMEOUT_MS).toBe(10_000)
    expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/open', ['-R', '--', file], {
      timeoutMs: 10_000,
    })
  })

  it('puts a file name that looks like an option after --', async () => {
    const dashed = path.join(root, '-R')
    await writeFile(dashed, '')
    const run = fakeRun()
    await revealInFinder(dashed, { run, bin: '/opt/open' })
    expect(run).toHaveBeenCalledWith('/opt/open', ['-R', '--', dashed], expect.anything())
  })

  it.each([
    ['missing', 'gone.mp3'],
    ['under a file instead of a folder', 'Artist - Title.mp3/x.mp3'],
  ])('fails with not_found, without running open, when the file is %s', async (_label, name) => {
    const run = fakeRun()
    expect(await stepFailure(revealInFinder(path.join(root, name), { run }))).toStrictEqual(MOVED)
    expect(run).not.toHaveBeenCalled()
  })

  it('fails with unknown when the file cannot be looked up', async () => {
    const run = fakeRun()
    const lstat: RevealDeps['lstat'] = async () => {
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${file}'`), {
        code: 'EACCES',
      })
    }
    expect(await stepFailure(revealInFinder(file, { run, lstat }))).toStrictEqual(FAILED)
    expect(run).not.toHaveBeenCalled()
  })

  it('fails with not_found when open says the file does not exist', async () => {
    const run = fakeRun({ exitCode: 1, stderr: `The file ${file} does not exist.\n` })
    expect(await stepFailure(revealInFinder(file, { run }))).toStrictEqual(MOVED)
  })

  it.each([
    ['open fails otherwise', { exitCode: 1, stderr: 'LSOpenURLsWithRole() failed (-10814)\n' }],
    ['open is killed', { exitCode: null, signal: 'SIGKILL' as const }],
    ['open times out', { exitCode: null, signal: 'SIGINT' as const, timedOut: true }],
  ])('fails with unknown when %s', async (_label, answer) => {
    expect(await stepFailure(revealInFinder(file, { run: fakeRun(answer) }))).toStrictEqual(FAILED)
  })

  it('fails with unknown when open cannot start', async () => {
    const cannotStart: typeof run = async (bin) => {
      throw new SpawnError(bin, Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    }
    expect(await stepFailure(revealInFinder(file, { run: cannotStart }))).toStrictEqual(FAILED)
  })

  it('passes other errors on', async () => {
    const bug = new TypeError('bug')
    const buggy: typeof run = async () => {
      throw bug
    }
    await expect(revealInFinder(file, { run: buggy })).rejects.toBe(bug)
  })

  it('refuses a relative path', async () => {
    const run = fakeRun()
    await expect(revealInFinder('Artist - Title.mp3', { run })).rejects.toThrow(TypeError)
    expect(run).not.toHaveBeenCalled()
  })
})
