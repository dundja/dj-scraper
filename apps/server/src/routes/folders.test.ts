import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  type FolderPickResponse,
  FolderPickResponseSchema,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RunResult, run } from '../engine/run.ts'
import { createFolderPicker, type FolderPicker } from '../fs/folder-picker.ts'
import { type FolderOps, PRIVACY_MESSAGE } from '../fs/folders.ts'
import { ApiError, onError, onNotFound } from '../http/errors.ts'
import { guard } from '../http/guard.ts'
import { folderRoutes } from './folders.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

// Real folders in a temp dir (real paths: tmpdir() is a symlink away on macOS): `picked` is a usable
// download folder, `dataDir` stands in for the app data dir.
let root = ''
let picked = ''
let dataDir = ''
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-pick-route-')))
  picked = path.join(root, 'Sets')
  dataDir = path.join(root, 'data')
  await mkdir(picked)
  await mkdir(path.join(dataDir, 'jobs'), { recursive: true })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The routes as app.ts mounts them: under /api, behind the guard, with our error handlers. */
function setup(picker: FolderPicker, folderOps?: Partial<FolderOps>) {
  const app = new Hono()
  app.use(guard({ port: PORT }))
  app.route('/api', folderRoutes({ picker, dataDirReal: dataDir, folderOps }))
  app.notFound(onNotFound)
  app.onError(onError)
  return app
}

function fakePicker(pick: FolderPicker['pick'] = async () => ({ path: picked })) {
  return { pick: vi.fn<FolderPicker['pick']>(pick) }
}

const errno = (code: string) => Object.assign(new Error(`${code}: /Users/dj/Secret`), { code })

/** An open folder whose read answers as told. */
const fakeDir = (read: () => Promise<unknown> = async () => null) => ({
  read: vi.fn(read),
  close: vi.fn(async () => {}),
})

const send = (app: Hono, init: RequestInit = {}, path = '/api/folders/pick') => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}${path}`, { ...init, headers }))
}

const post = (body: unknown, init: RequestInit = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...init,
})

async function pickOf(res: Response): Promise<FolderPickResponse> {
  expect(res.status).toBe(200)
  return FolderPickResponseSchema.parse(await res.json())
}

async function errorOf(res: Response) {
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

describe('POST /api/folders/pick', () => {
  it('opens the picker and returns the chosen folder', async () => {
    const picker = fakePicker()
    const res = await send(setup(picker), post({}))
    expect(await pickOf(res)).toStrictEqual({ path: picked })
    expect(picker.pick).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
  })

  it('passes the start folder on', async () => {
    const picker = fakePicker()
    await send(setup(picker), post({ startIn: '/Users/dj/Music/DJ Scraper' }))
    expect(picker.pick).toHaveBeenCalledWith('/Users/dj/Music/DJ Scraper', expect.any(AbortSignal))
  })

  it('answers a canceled pick with 200, checking no folder', async () => {
    const picker = fakePicker(async () => ({ canceled: true }))
    const realpathOp = vi.fn(async (file: string) => file)
    const res = await send(setup(picker, { realpath: realpathOp }), post({}))
    expect(await pickOf(res)).toStrictEqual({ canceled: true })
    expect(realpathOp).not.toHaveBeenCalled()
  })

  describe('the picked folder', () => {
    it('is read before the answer, so macOS asks for access at pick time', async () => {
      const handle = fakeDir()
      const opendir = vi.fn(async (_dir: string) => handle)
      expect(await pickOf(await send(setup(fakePicker(), { opendir }), post({})))).toStrictEqual({
        path: picked,
      })
      expect(opendir).toHaveBeenCalledExactlyOnceWith(picked)
      expect(handle.read).toHaveBeenCalledOnce()
      expect(handle.close).toHaveBeenCalledOnce()
    })

    it('holds the answer while macOS shows its privacy prompt', async () => {
      // The read blocks until the user answers the prompt.
      let answerPrompt: () => void = () => {}
      const prompt = new Promise<void>((resolve) => {
        answerPrompt = resolve
      })
      const handle = fakeDir(() => prompt)
      let settled = false
      const response = send(setup(fakePicker(), { opendir: async () => handle }), post({})).finally(
        () => {
          settled = true
        },
      )
      await vi.waitFor(() => expect(handle.read).toHaveBeenCalledOnce())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      answerPrompt()
      expect(await pickOf(await response)).toStrictEqual({ path: picked })
    })

    it('answers 422 folder_unavailable naming the privacy settings when macOS refuses access', async () => {
      const opendir = async () => fakeDir(() => Promise.reject(errno('EPERM')))
      expect(await errorOf(await send(setup(fakePicker(), { opendir }), post({})))).toStrictEqual({
        status: 422,
        code: 'folder_unavailable',
        message: PRIVACY_MESSAGE,
      })
    })

    it.each([
      [
        'gone',
        async () => path.join(root, 'gone'),
        {},
        "That folder doesn't exist. Check the path, or that its drive is connected.",
      ],
      [
        'a file',
        async () => {
          const file = path.join(root, 'set.mp3')
          await writeFile(file, 'x')
          return file
        },
        {},
        "That path isn't a folder.",
      ],
      [
        'inside the data dir',
        async () => path.join(dataDir, 'jobs'),
        {},
        "That folder is inside DJ Scraper's own data folder. Choose another one.",
      ],
      [
        'not writable',
        async () => picked,
        { access: () => Promise.reject(errno('EACCES')) },
        "DJ Scraper isn't allowed to write to that folder.",
      ],
      [
        'on a read-only drive',
        async () => picked,
        { access: () => Promise.reject(errno('EROFS')) },
        'That folder is on a read-only drive.',
      ],
      [
        'too long a path for macOS',
        async () => picked,
        { realpath: () => Promise.reject(errno('ENAMETOOLONG')) },
        'That folder path is too long.',
      ],
    ] satisfies [string, () => Promise<string>, Partial<FolderOps>, string][])(
      'answers 422 folder_unavailable when it is %s, with the words enqueue uses',
      async (_label, folder, ops, message) => {
        const chosen = await folder()
        const res = await send(
          setup(
            fakePicker(async () => ({ path: chosen })),
            ops,
          ),
          post({}),
        )
        expect(await errorOf(res)).toStrictEqual({
          status: 422,
          code: 'folder_unavailable',
          message,
        })
      },
    )

    it('answers 500 for an error that is no folder refusal', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const stat = async () => ({
          isDirectory: (): boolean => {
            throw new TypeError('bug')
          },
        })
        expect(await errorOf(await send(setup(fakePicker(), { stat }), post({})))).toStrictEqual({
          status: 500,
          code: 'unknown',
          message: 'Internal server error',
        })
        expect(consoleError).toHaveBeenCalledOnce()
      } finally {
        consoleError.mockRestore()
      }
    })
  })

  it.each([
    ['a start folder with a trailing slash', { startIn: '/Volumes/USB/' }],
    ['a start folder with ~', { startIn: '~/Music' }],
    ['a start folder that is not a string', { startIn: 42 }],
    ['malformed JSON', '{"startIn": '],
    ['a JSON array', '[]'],
    ['no body', ''],
  ])('answers %s with 400 invalid_request without opening the picker', async (_label, body) => {
    const picker = fakePicker()
    expect(await errorOf(await send(setup(picker), post(body)))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(picker.pick).not.toHaveBeenCalled()
  })

  it('refuses a request without a JSON Content-Type with 415', async () => {
    const picker = fakePicker()
    const res = await send(setup(picker), { method: 'POST', body: '{}' })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(picker.pick).not.toHaveBeenCalled()
  })

  it('cannot be triggered with GET', async () => {
    const picker = fakePicker()
    expect(await errorOf(await send(setup(picker)))).toMatchObject({ status: 404 })
    expect(picker.pick).not.toHaveBeenCalled()
  })

  it.each([
    [new ApiError('invalid_request', 'A folder picker is already open', { status: 409 }), 409],
    [new ApiError('unknown', 'The folder picker needs the Mac desktop session'), 500],
    [new ApiError('folder_unavailable', 'The chosen folder is no longer available'), 422],
  ])('answers the picker error %s with its status', async (error, status) => {
    const picker = fakePicker(async () => {
      throw error
    })
    expect(await errorOf(await send(setup(picker), post({})))).toStrictEqual({
      status,
      code: error.code,
      message: error.message,
    })
  })

  it('hands the picker a signal that aborts when the request is dropped', async () => {
    let received: AbortSignal | undefined
    const picker = fakePicker(async (_startIn, signal) => {
      received = signal
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
      return { canceled: true }
    })
    const controller = new AbortController()
    const response = send(setup(picker), post({}, { signal: controller.signal }))
    await vi.waitFor(() => expect(received).toBeDefined())
    expect(received?.aborted).toBe(false)
    controller.abort()
    await response.catch(() => {})
    expect(received?.aborted).toBe(true)
  })

  it('answers a second pick while the first is open with 409, using the real picker', async () => {
    let answer: (result: RunResult) => void = () => {}
    const fakeRun = vi.fn<typeof run>(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const app = setup(createFolderPicker({ run: fakeRun }))
    const first = send(app, post({}))
    await vi.waitFor(() => expect(fakeRun).toHaveBeenCalledOnce())
    expect(await errorOf(await send(app, post({})))).toStrictEqual({
      status: 409,
      code: 'invalid_request',
      message: 'A folder picker is already open',
    })
    answer({
      pid: 1,
      exitCode: 0,
      signal: null,
      stdout: `${picked}/\n`,
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 1,
    })
    expect(await pickOf(await first)).toStrictEqual({ path: picked })
    expect(fakeRun).toHaveBeenCalledOnce()
  })
})
