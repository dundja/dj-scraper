import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  DEFAULT_SETTINGS,
  type Settings,
  SettingsSchema,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onError, onNotFound } from '../http/errors.ts'
import { guard } from '../http/guard.ts'
import { createSettingsStore, SETTINGS_FILE } from '../settings/store.ts'
import { settingsRoutes } from './settings.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`
const DEFAULT_FOLDER = '/Users/dj/Music/DJ Scraper'
const defaults: Settings = { ...DEFAULT_SETTINGS, recentFolders: [], folder: DEFAULT_FOLDER }
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

let root = ''
let dataDir = ''
let count = 0
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-settings-route-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
beforeEach(() => {
  dataDir = path.join(root, `data-${++count}`)
})

/** The routes as app.ts mounts them: under /api, behind the guard, with our error handlers. */
async function setup({ withCallback = true } = {}) {
  const settings = await createSettingsStore({
    dataDir,
    defaultFolder: DEFAULT_FOLDER,
    log: quiet,
  })
  const onConcurrency = vi.fn<(concurrency: number) => void>()
  const app = new Hono()
  app.use(guard({ port: PORT }))
  app.route(
    '/api',
    settingsRoutes({ settings, onConcurrency: withCallback ? onConcurrency : undefined }),
  )
  app.notFound(onNotFound)
  app.onError(onError)
  return { app, settings, onConcurrency }
}

const send = (app: Hono, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('host', HOST)
  return Promise.resolve(app.request(`http://${HOST}/api/settings`, { ...init, headers }))
}

const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

async function settingsOf(res: Response): Promise<Settings> {
  expect(res.status).toBe(200)
  return SettingsSchema.parse(await res.json())
}

async function errorOf(res: Response) {
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}

const saved = async (): Promise<unknown> =>
  JSON.parse(await readFile(path.join(dataDir, SETTINGS_FILE), 'utf8'))

describe('GET /api/settings', () => {
  it('returns the settings, defaults filled in', async () => {
    const { app } = await setup()
    expect(await settingsOf(await send(app))).toStrictEqual(defaults)
  })

  it('returns what PUT changed', async () => {
    const { app, settings } = await setup()
    await settings.update({ format: 'flac' })
    expect(await settingsOf(await send(app))).toStrictEqual({ ...defaults, format: 'flac' })
  })
})

describe('PUT /api/settings', () => {
  it('changes only the fields given, saves them and returns all settings', async () => {
    const { app, settings } = await setup()
    const updated = await settingsOf(await send(app, put({ format: 'aiff', embedArtwork: false })))
    const expected = { ...defaults, format: 'aiff', embedArtwork: false }
    expect(updated).toStrictEqual(expected)
    expect(settings.get()).toStrictEqual(expected)
    expect(await saved()).toStrictEqual(expected)
  })

  it('adds a new folder to the recent folders', async () => {
    const { app } = await setup()
    expect(await settingsOf(await send(app, put({ folder: '/Volumes/USB' })))).toMatchObject({
      folder: '/Volumes/USB',
      recentFolders: ['/Volumes/USB'],
    })
  })

  it('drops recentFolders and unknown keys: the server keeps that list', async () => {
    const { app } = await setup()
    const body = { recentFolders: ['/Users/dj/Desktop'], theme: 'light' }
    expect(await settingsOf(await send(app, put(body)))).toStrictEqual(defaults)
  })

  it.each([
    ['a folder with a trailing slash', { folder: '/Volumes/USB/' }],
    ['a relative folder', { folder: 'Music' }],
    ['an unknown format', { format: 'opus' }],
    ['a template without a title', { filenameTemplate: '{artist}' }],
    ['a concurrency of 0', { concurrency: 0 }],
    ['a concurrency of 7', { concurrency: 7 }],
    ['a boolean as a string', { embedArtwork: 'false' }],
    ['malformed JSON', '{"format": '],
    ['a JSON array', '[]'],
  ])('answers %s with 400 invalid_request and changes nothing', async (_label, body) => {
    const { app, settings, onConcurrency } = await setup()
    expect(await errorOf(await send(app, put(body)))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(settings.get()).toStrictEqual(defaults)
    expect(onConcurrency).not.toHaveBeenCalled()
  })

  it('refuses a body without a JSON Content-Type with 415', async () => {
    const { app, settings } = await setup()
    const res = await send(app, { method: 'PUT', body: JSON.stringify({ concurrency: 1 }) })
    expect(await errorOf(res)).toMatchObject({ status: 415, code: 'invalid_request' })
    expect(settings.get()).toStrictEqual(defaults)
  })

  it('refuses a body over 64 KiB with 413', async () => {
    const { app } = await setup()
    const res = await send(app, put({ filenameTemplate: 'x'.repeat(70_000) }))
    expect(await errorOf(res)).toMatchObject({ status: 413, code: 'invalid_request' })
  })

  describe('onConcurrency', () => {
    it('is called with the new value when concurrency changes', async () => {
      const { app, onConcurrency } = await setup()
      await settingsOf(await send(app, put({ concurrency: 5 })))
      expect(onConcurrency).toHaveBeenCalledExactlyOnceWith(5)
    })

    it.each([
      ['concurrency stays the same', { concurrency: DEFAULT_SETTINGS.concurrency }],
      ['other settings change', { format: 'wav', folder: '/Volumes/USB' }],
    ])('is not called when %s', async (_label, body) => {
      const { app, onConcurrency } = await setup()
      await settingsOf(await send(app, put(body)))
      expect(onConcurrency).not.toHaveBeenCalled()
    })

    it('is optional', async () => {
      const { app } = await setup({ withCallback: false })
      expect(await settingsOf(await send(app, put({ concurrency: 1 })))).toMatchObject({
        concurrency: 1,
      })
    })
  })
})

describe('settingsRoutes', () => {
  it('serves no other methods', async () => {
    const { app } = await setup()
    const res = await send(app, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await errorOf(res)).toMatchObject({ status: 404, code: 'not_found' })
  })
})
