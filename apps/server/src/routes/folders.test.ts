import {
  ApiErrorBodySchema,
  type FolderPickResponse,
  FolderPickResponseSchema,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { RunResult, run } from '../engine/run.ts'
import { createFolderPicker, type FolderPicker } from '../fs/folder-picker.ts'
import { ApiError, onError, onNotFound } from '../http/errors.ts'
import { guard } from '../http/guard.ts'
import { folderRoutes } from './folders.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

/** The routes as app.ts mounts them: under /api, behind the guard, with our error handlers. */
function setup(picker: FolderPicker) {
  const app = new Hono()
  app.use(guard({ port: PORT }))
  app.route('/api', folderRoutes({ picker }))
  app.notFound(onNotFound)
  app.onError(onError)
  return app
}

function fakePicker(pick: FolderPicker['pick'] = async () => ({ path: '/Volumes/USB' })) {
  return { pick: vi.fn<FolderPicker['pick']>(pick) }
}

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
    expect(await pickOf(res)).toStrictEqual({ path: '/Volumes/USB' })
    expect(picker.pick).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
  })

  it('passes the start folder on', async () => {
    const picker = fakePicker()
    await send(setup(picker), post({ startIn: '/Users/dj/Music/DJ Scraper' }))
    expect(picker.pick).toHaveBeenCalledWith('/Users/dj/Music/DJ Scraper', expect.any(AbortSignal))
  })

  it('answers a canceled pick with 200', async () => {
    const picker = fakePicker(async () => ({ canceled: true }))
    expect(await pickOf(await send(setup(picker), post({})))).toStrictEqual({ canceled: true })
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
      stdout: '/\n',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 1,
    })
    expect(await pickOf(await first)).toStrictEqual({ path: '/' })
    expect(fakeRun).toHaveBeenCalledOnce()
  })
})
