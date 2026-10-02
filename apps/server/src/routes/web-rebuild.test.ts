import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Health } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { UNUSED_RESOLVE_DEPS } from '../resolve/unused.ts'

// A file found by the lookup can vanish before it is read: `pnpm build` empties the dist dir while
// the server runs. Only readFile is faked, to fail as if that happened.
const vanished = vi.hoisted(() => ({ code: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile: typeof actual.readFile = (async (file: string) => {
    if (vanished.code !== '') throw Object.assign(new Error(vanished.code), { code: vanished.code })
    return actual.readFile(file)
  }) as typeof actual.readFile
  return { ...actual, readFile }
})

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}

let dist = ''
beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), 'dj-scraper-rebuild-'))
  await mkdir(path.join(dist, 'assets'))
  await writeFile(path.join(dist, 'index.html'), '<!doctype html>')
  await writeFile(path.join(dist, 'assets', 'index-Ab12.js'), 'app')
})
afterAll(async () => {
  await rm(dist, { recursive: true, force: true })
})

const get = (target: string) =>
  Promise.resolve(
    createApp({
      port: 4747,
      health: { current: async () => health, recheck: async () => health },
      webRoot: dist,
      ...UNUSED_RESOLVE_DEPS,
    }).request(`http://127.0.0.1:4747${target}`, { headers: { host: '127.0.0.1:4747' } }),
  )

describe('a file that vanishes between lookup and read', () => {
  it('is a plain 404, without the cache headers meant for the file', async () => {
    vanished.code = 'ENOENT'
    try {
      for (const target of ['/assets/index-Ab12.js', '/', '/downloads']) {
        const res = await get(target)
        expect(res.status, target).toBe(404)
        expect(res.headers.get('cache-control'), target).toBeNull()
        expect(res.headers.get('content-type'), target).toMatch(/^application\/json/)
        expect(res.headers.get('x-frame-options'), target).toBe('DENY')
      }
    } finally {
      vanished.code = ''
    }
    expect((await get('/assets/index-Ab12.js')).status).toBe(200)
  })

  it('answers any other read error with 500, logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vanished.code = 'EIO'
    try {
      const res = await get('/')
      expect(res.status).toBe(500)
      expect(res.headers.get('cache-control')).toBeNull()
      expect(log).toHaveBeenCalledOnce()
    } finally {
      vanished.code = ''
      log.mockRestore()
    }
  })
})
