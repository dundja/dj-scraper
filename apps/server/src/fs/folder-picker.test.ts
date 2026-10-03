import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FolderPickResponseSchema } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type RunOptions, type RunResult, type run, SpawnError } from '../engine/run.ts'
import { ApiError } from '../http/errors.ts'
import {
  createFolderPicker,
  type FolderPickerDeps,
  PICK_SCRIPT,
  PICKER_TIMEOUT_MS,
  pickerArgv,
} from './folder-picker.ts'

// run() is faked here; test/folder-picker.test.ts runs the picker against a fake osascript binary.

let root = ''
let realRoot = ''
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-picker-'))
  // tmpdir() is /var/folders/…, a symlink away from its real path /private/var/folders/….
  realRoot = await realpath(root)
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
  durationMs: 12,
  ...overrides,
})

function setup(answer: Partial<RunResult> = {}, deps: FolderPickerDeps = {}) {
  const fakeRun = vi.fn<typeof run>(async (_bin, _argv, options?: RunOptions) => {
    options?.signal?.throwIfAborted()
    return runResult(answer)
  })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const picker = createFolderPicker({ run: fakeRun, log, ...deps })
  const logged = () => [...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')
  return { picker, run: fakeRun, log, logged }
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`)
  return { code: error.code, status: error.status, message: error.message }
}

describe('PICK_SCRIPT', () => {
  it('runs choose folder in osascript itself, the start folder from argv', () => {
    expect(PICK_SCRIPT.join('\n')).toBe(
      [
        'on run argv',
        'set startIn to missing value',
        'if (count of argv) > 0 then',
        'try',
        'set startIn to (POSIX file (item 1 of argv)) as alias',
        'end try',
        'end if',
        'activate',
        'try',
        'if startIn is missing value then',
        'set chosen to choose folder with prompt "Choose a download folder"',
        'else',
        'set chosen to choose folder with prompt "Choose a download folder" default location startIn',
        'end if',
        'on error number -128',
        'return ""',
        'end try',
        'return POSIX path of chosen',
        'end run',
      ].join('\n'),
    )
    // A `tell` block would need Automation consent and put the dialog in another process.
    expect(PICK_SCRIPT.some((line) => /\btell\b/.test(line))).toBe(false)
  })
})

describe('pickerArgv', () => {
  it('passes each script line after -e, then --, then the start folder', () => {
    const script = PICK_SCRIPT.flatMap((line) => ['-e', line])
    expect(pickerArgv(undefined)).toStrictEqual([...script, '--'])
    expect(pickerArgv('/Volumes/USB "Sets"; $(x)')).toStrictEqual([
      ...script,
      '--',
      '/Volumes/USB "Sets"; $(x)',
    ])
  })
})

describe('createFolderPicker', () => {
  it('runs /usr/bin/osascript with a 300 s timeout and the request signal', async () => {
    const { picker, run } = setup({ stdout: '\n' })
    const signal = new AbortController().signal
    await picker.pick(undefined, signal)
    expect(PICKER_TIMEOUT_MS).toBe(300_000)
    expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/osascript', pickerArgv(undefined), {
      timeoutMs: 300_000,
      signal,
    })
  })

  it('takes another binary and timeout', async () => {
    const { picker, run } = setup({ stdout: '\n' }, { bin: '/opt/osascript', timeoutMs: 50 })
    await picker.pick(undefined)
    expect(run).toHaveBeenCalledWith('/opt/osascript', pickerArgv(undefined), {
      timeoutMs: 50,
      signal: undefined,
    })
  })

  describe('start folder', () => {
    it('is passed when it is an existing folder', async () => {
      const { picker, run } = setup({ stdout: '\n' })
      await picker.pick(root)
      expect(run.mock.calls[0]?.[1]).toStrictEqual(pickerArgv(root))
    })

    it.each([
      ['a file', 'file.txt'],
      ['missing', 'missing'],
    ])('is left out when it is %s', async (_label, name) => {
      await writeFile(path.join(root, 'file.txt'), '')
      const { picker, run } = setup({ stdout: '\n' })
      await picker.pick(path.join(root, name))
      expect(run.mock.calls[0]?.[1]).toStrictEqual(pickerArgv(undefined))
    })

    it('is left out when it is relative, without looking it up', async () => {
      const stat = vi.fn(async () => ({ isDirectory: () => true }))
      const { picker, run } = setup({ stdout: '\n' }, { stat })
      await picker.pick('Music')
      expect(stat).not.toHaveBeenCalled()
      expect(run.mock.calls[0]?.[1]).toStrictEqual(pickerArgv(undefined))
    })
  })

  describe('answers', () => {
    it('returns the real path of the chosen folder, without its trailing slash', async () => {
      const { picker } = setup({ stdout: `${root}/\n` })
      const response = await picker.pick(undefined)
      expect(response).toStrictEqual({ path: realRoot })
      expect(FolderPickResponseSchema.parse(response)).toStrictEqual(response)
    })

    it('follows a symlinked folder to its real path', async () => {
      const target = path.join(root, 'target')
      await mkdir(target, { recursive: true })
      await symlink(target, path.join(root, 'link'))
      const { picker } = setup({ stdout: `${root}/link/\n` })
      expect(await picker.pick(undefined)).toStrictEqual({ path: path.join(realRoot, 'target') })
    })

    it('keeps the root folder as /', async () => {
      const { picker } = setup({ stdout: '/\n' })
      expect(await picker.pick(undefined)).toStrictEqual({ path: '/' })
    })

    it.each([
      ['an empty line (the user canceled)', '\n'],
      ['nothing', ''],
    ])('is canceled for %s', async (_label, stdout) => {
      const { picker } = setup({ stdout })
      expect(await picker.pick(undefined)).toStrictEqual({ canceled: true })
    })

    it('strips exactly one newline: a folder name may end in one', async () => {
      await mkdir(path.join(root, 'Set\n'), { recursive: true })
      const { picker } = setup({ stdout: `${root}/Set\n/\n` })
      expect(await failure(picker.pick(undefined))).toStrictEqual({
        code: 'folder_unavailable',
        status: 422,
        message:
          "DJ Scraper can't use this folder: its path is too long or has a control character in it",
      })
    })

    it.each([
      ['a file', 'file.txt'],
      ['missing', 'gone'],
    ])('fails with folder_unavailable when the chosen path is %s', async (_label, name) => {
      await writeFile(path.join(root, 'file.txt'), '')
      const { picker } = setup({ stdout: `${root}/${name}/\n` })
      expect(await failure(picker.pick(undefined))).toStrictEqual({
        code: 'folder_unavailable',
        status: 422,
        message: 'The chosen folder is no longer available',
      })
    })

    it('fails with unknown, logging no output, when the answer is not a POSIX path', async () => {
      const { picker, log, logged } = setup({ stdout: 'Macintosh HD:Users:dj:Secret:\n' })
      expect(await failure(picker.pick(undefined))).toStrictEqual({
        code: 'unknown',
        status: 500,
        message: 'The folder picker failed',
      })
      expect(log.warn).toHaveBeenCalledOnce()
      expect(logged()).not.toContain('Secret')
    })
  })

  describe('failures', () => {
    it.each([
      ['the time ran out', { timedOut: true, exitCode: null, signal: 'SIGINT' as const }],
      ['the request was dropped', { aborted: true, exitCode: null, signal: 'SIGINT' as const }],
      [
        'osascript reports a user cancel (-128)',
        { exitCode: 1, stderr: '0:17: execution error: User canceled. (-128)\n' },
      ],
    ])('is canceled when %s', async (_label, answer) => {
      const { picker, log } = setup(answer)
      expect(await picker.pick(undefined)).toStrictEqual({ canceled: true })
      expect(log.warn).not.toHaveBeenCalled()
    })

    it('is canceled when the signal has already aborted (run refuses to start)', async () => {
      const { picker, run } = setup({ stdout: `${root}/\n` })
      expect(await picker.pick(root, AbortSignal.abort())).toStrictEqual({ canceled: true })
      expect(run).toHaveBeenCalledOnce()
    })

    it('needs the desktop session when there is none (-1713)', async () => {
      const { picker } = setup({
        exitCode: 1,
        stderr: '191:282: execution error: No user interaction allowed. (-1713)\n',
      })
      expect(await failure(picker.pick(undefined))).toStrictEqual({
        code: 'unknown',
        status: 500,
        message: 'The folder picker needs the Mac desktop session',
      })
    })

    it.each([
      [
        'an AppleScript error',
        { exitCode: 1, stderr: "22:28: execution error: Can't get /Users/dj/Secret. (-1743)\n" },
        '(exit 1, error -1743)',
      ],
      [
        'a usage error',
        { exitCode: 2, stderr: 'osascript: option requires an argument -- e /Users/dj/Secret\n' },
        '(exit 2)',
      ],
      ['a signal', { exitCode: null, signal: 'SIGKILL' as const }, '(SIGKILL)'],
    ])(
      'fails with unknown on %s, logging the exit but never stderr',
      async (_label, answer, exit) => {
        const { picker, log, logged } = setup(answer)
        expect(await failure(picker.pick(undefined))).toStrictEqual({
          code: 'unknown',
          status: 500,
          message: 'The folder picker failed',
        })
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
          `[folders] the folder picker failed ${exit}`,
        )
        expect(logged()).not.toContain('Secret')
      },
    )

    it('fails with unknown when osascript cannot start', async () => {
      const cause = Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' })
      const { picker, log } = setup(
        {},
        {
          run: async (bin) => {
            throw new SpawnError(bin, cause)
          },
        },
      )
      expect(await failure(picker.pick(undefined))).toMatchObject({ code: 'unknown', status: 500 })
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        '[folders] cannot start the folder picker (ENOENT)',
      )
    })

    it('passes other errors on', async () => {
      const bug = new TypeError('bug')
      const { picker } = setup(
        {},
        {
          run: async () => {
            throw bug
          },
        },
      )
      await expect(picker.pick(undefined)).rejects.toBe(bug)
    })
  })

  describe('one picker at a time', () => {
    it('refuses a second pick with 409 while one is open, and allows one after it settles', async () => {
      let answer: (result: RunResult) => void = () => {}
      const fakeRun = vi.fn<typeof run>(
        () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      )
      const picker = createFolderPicker({ run: fakeRun })
      // Both start in the same tick, before the first one's start folder lookup.
      const first = picker.pick(root)
      expect(await failure(picker.pick(root))).toStrictEqual({
        code: 'invalid_request',
        status: 409,
        message: 'A folder picker is already open',
      })
      await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledOnce())
      answer(runResult({ stdout: '\n' }))
      expect(await first).toStrictEqual({ canceled: true })

      const second = picker.pick(undefined)
      await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledTimes(2))
      answer(runResult({ stdout: '/\n' }))
      expect(await second).toStrictEqual({ path: '/' })
    })

    it('allows a new pick after one failed', async () => {
      const { picker, run } = setup({ exitCode: 1, stderr: 'boom (-1)\n' })
      await expect(picker.pick(undefined)).rejects.toBeInstanceOf(ApiError)
      await expect(picker.pick(undefined)).rejects.toBeInstanceOf(ApiError)
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('keeps separate pickers independent', async () => {
      const never = vi.fn<typeof run>(() => new Promise(() => {}))
      void createFolderPicker({ run: never }).pick(undefined)
      const { picker } = setup({ stdout: '\n' })
      expect(await picker.pick(undefined)).toStrictEqual({ canceled: true })
    })
  })
})
