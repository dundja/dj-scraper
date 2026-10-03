import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Health } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import type { HealthCheck } from '../src/engine/health.ts'
import { type RunningServer, startServer } from '../src/server.ts'
import { UNUSED_DEPS } from '../src/stubs.ts'
import { FIXTURE_ASSET, FIXTURE_INDEX, makeTempDir, rawRequest, writeWebDist } from './helpers.ts'

// The built UI over a real socket, with request targets that fetch and the URL parser would
// normalize before they reach the app: raw dot segments, backslashes, control bytes.

const SECRET = 'SECRET-must-never-be-served'
const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}
const stubHealth: HealthCheck = { current: async () => health, recheck: async () => health }

let root = ''
let server: RunningServer | undefined
let host = ''
beforeAll(async () => {
  // <root>/package.json is what a traversal out of <root>/dist would reach.
  root = await makeTempDir('web')
  await writeFile(path.join(root, 'package.json'), `{"name":"${SECRET}"}`)
  const webRoot = await writeWebDist(path.join(root, 'dist'))
  server = await startServer(0, (port) =>
    createApp({ port, health: stubHealth, webRoot, ...UNUSED_DEPS }),
  )
  host = `127.0.0.1:${server.port}`
})
afterAll(async () => {
  await server?.close()
  await rm(root, { recursive: true, force: true })
})

async function get(target: string) {
  const res = await rawRequest(
    server?.port ?? 0,
    `GET ${target} HTTP/1.1\nHost: ${host}\nConnection: close\n\n`,
  )
  if (res === 'closed') throw new Error(`socket closed without a response for ${target}`)
  expect(res.body).not.toContain(SECRET)
  return res
}

describe('the built UI over a raw socket', () => {
  it('serves index.html and a hashed asset', async () => {
    expect(await get('/')).toMatchObject({ status: 200, body: FIXTURE_INDEX })
    expect(await get(FIXTURE_ASSET.path)).toMatchObject({ status: 200, body: FIXTURE_ASSET.body })
  })

  it.each([
    '/../package.json',
    '/./../package.json',
    '/assets/../../package.json',
    '/assets/../../../../../../etc/hosts.txt',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
    '/.%2e/package.json',
    '/assets/..\\..\\package.json',
    '/assets/..%5c..%5cpackage.json',
  ])('answers the traversal %s with 404, never a file outside the dist dir', async (target) => {
    const res = await get(target)
    expect(res.status).toBe(404)
    expect(res.headers).toContain('x-frame-options: deny')
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'not_found' } })
  })

  it.each(['//etc/passwd', '/../../../../etc/passwd', '/assets/..\\..\\etc\\passwd'])(
    'answers the extensionless %s with index.html at most',
    async (target) => {
      expect(await get(target)).toMatchObject({ status: 200, body: FIXTURE_INDEX })
    },
  )

  it('leaves a raw null byte in the target to Node, which answers 400 before the app runs', async () => {
    expect(await get('/index.html\0.js')).toMatchObject({ status: 400 })
  })
})
