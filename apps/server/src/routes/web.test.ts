import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApiErrorBodySchema, type Health } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { HealthCheck } from '../engine/health.ts'
import { SECURITY_HEADERS } from '../http/security-headers.ts'
import { hasBuiltUi, NO_UI_MESSAGE } from './web.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`

const INDEX = '<!doctype html><html><head><title>DJ Scraper</title></head><body></body></html>\n'
const SCRIPT = { path: '/assets/index-DuTPbFGu.js', body: "console.log('app')\n" }
/** Anything outside the dist dir, or hidden in it. A response must never contain this. */
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

/*
 * <base>/package.json, secret.txt   outside the dist dir
 * <base>/dist/                      a Vite build, plus dotfiles, an empty dir and symlinks
 */
let base = ''
let dist = ''
beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dj-scraper-web-'))
  dist = path.join(base, 'dist')
  const files: Record<string, string> = {
    'package.json': `{"name":"${SECRET}"}`,
    'secret.txt': SECRET,
    'dist/index.html': INDEX,
    [`dist${SCRIPT.path}`]: SCRIPT.body,
    'dist/assets/index-DMI3-OIr.css': 'body{color:red}',
    'dist/assets/geist-latin-wght-normal-BgDaEnEv.woff2': 'wOF2',
    'dist/assets/blob-x1y2.unknownext': 'bytes',
    'dist/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'dist/.env': SECRET,
    'dist/assets/.DS_Store': SECRET,
    'dist/.hidden/app.js': SECRET,
  }
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, name)), { recursive: true })
    await writeFile(path.join(base, name), body)
  }
  await mkdir(path.join(dist, 'assets', 'sub'))
  // Symlinks out of the dist dir (to a file and to a directory), and one that stays inside.
  await symlink(path.join(base, 'secret.txt'), path.join(dist, 'escape.txt'))
  await symlink(base, path.join(dist, 'assets', 'escape-dir'))
  await symlink(path.join(dist, SCRIPT.path), path.join(dist, 'linked.js'))
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

const appFor = (webRoot: string | undefined) =>
  createApp({ port: PORT, health: stubHealth, webRoot })

/** app.request sends no Host, so add ours (absolute URL, since the guard checks the URL too). */
const send = (target: string, init: RequestInit = {}, app = appFor(dist)) => {
  const headers = new Headers(init.headers)
  if (!headers.has('host')) headers.set('host', HOST)
  const url = target.startsWith('http') ? target : `http://${HOST}${target}`
  return Promise.resolve(app.request(url, { ...init, headers }))
}

function expectSecurityHeaders(res: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value)
  }
  expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
}

async function expectIndex(res: Response) {
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-cache')
  expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(INDEX)))
  expectSecurityHeaders(res)
  expect(await res.text()).toBe(INDEX)
}

async function expectNotFound(res: Response, message = 'Not found') {
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  expect(res.headers.get('cache-control')).toBeNull()
  expectSecurityHeaders(res)
  const body = await res.text()
  expect(body).not.toContain(SECRET)
  expect(ApiErrorBodySchema.parse(JSON.parse(body)).error).toEqual({ code: 'not_found', message })
}

describe('the built UI', () => {
  it.each(['/', '/index.html'])('serves index.html for %s, never cached', async (target) => {
    await expectIndex(await send(target))
  })

  it.each([
    ['a hashed script', SCRIPT.path, 'text/javascript; charset=utf-8'],
    ['a hashed stylesheet', '/assets/index-DMI3-OIr.css', 'text/css; charset=utf-8'],
    ['a hashed font', '/assets/geist-latin-wght-normal-BgDaEnEv.woff2', 'font/woff2'],
    [
      'a hashed file of an unknown type',
      '/assets/blob-x1y2.unknownext',
      'application/octet-stream',
    ],
  ])('serves %s with its type, cached for a year', async (_label, target, type) => {
    const res = await send(target)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(type)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expectSecurityHeaders(res)
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
  })

  it('serves a script byte for byte', async () => {
    expect(await (await send(SCRIPT.path)).text()).toBe(SCRIPT.body)
  })

  it('serves an unhashed file from public/ with revalidation', async () => {
    const res = await send('/favicon.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it.each([
    ['/', INDEX],
    [SCRIPT.path, SCRIPT.body],
  ])('answers HEAD %s with the headers and no body', async (target, body) => {
    const res = await send(target, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
    expectSecurityHeaders(res)
    expect(await res.text()).toBe('')
  })

  it('ignores the query string', async () => {
    await expectIndex(await send('/?url=https%3A%2F%2Fyoutu.be%2Fx'))
    expect((await send(`${SCRIPT.path}?v=2`)).status).toBe(200)
  })
})

describe('the SPA fallback', () => {
  it.each([
    '/downloads',
    '/downloads/',
    '/settings/audio',
    '/collections/PLx-12_ab',
    '/a%20b',
    // Directories are never listed.
    '/assets',
    '/assets/',
    '/assets/sub',
    '/assets/sub/',
    // /api is only the exact prefix.
    '/apix',
    '/API/health',
  ])('answers %s with index.html', async (target) => {
    await expectIndex(await send(target))
  })

  it('answers HEAD on a client route like GET, without a body', async () => {
    const res = await send('/downloads', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('')
  })

  it.each([
    ['a missing hashed asset', '/assets/missing-AbC123.js'],
    ['a missing favicon.ico', '/favicon.ico'],
    ['a missing file at the root', '/robots.txt'],
    ['a dotted last segment', '/downloads/v1.2'],
    ['a file below a file', '/index.html/app.js'],
    ['the /api prefix', '/api'],
    ['/api/', '/api/'],
    ['an unknown API path', '/api/nope'],
    ['a deeper unknown API path', '/api/nope/deeper'],
    ['an API route with a trailing slash', '/api/health/'],
    ['a percent-encoded /api path', '/%61pi/nope'],
  ])('answers %s with 404 not_found JSON, never index.html', async (_label, target) => {
    await expectNotFound(await send(target))
  })

  it('leaves other methods to the guard and the 404 handler', async () => {
    expect((await send('/', { method: 'POST' })).status).toBe(415)
    const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    await expectNotFound(await send('/', json))
    await expectNotFound(await send('/downloads', { method: 'OPTIONS' }))
  })
})

describe('path safety', () => {
  it.each([
    // Encoded traversal: %2f and %5c stay encoded or turn into `\`, never into a path separator.
    '/..%2fpackage.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
    '/assets/..%2f..%2fpackage.json',
    '/assets/..%5c..%5cpackage.json',
    '/assets/..%5Csecret.txt',
    '/..%255c..%255cpackage.json',
    '/assets%2findex-DuTPbFGu.js',
    // The URL parser resolves these before routing.
    '/../package.json',
    '/assets/../../package.json',
    '/assets/..\\..\\package.json',
    // Dotfiles and dot directories.
    '/.env',
    '/%2eenv',
    '/assets/.DS_Store',
    '/.hidden/app.js',
    // Symlinks out of the dist dir, to a file and through a directory.
    '/escape.txt',
    '/assets/escape-dir/secret.txt',
    '/assets/escape-dir/package.json',
    // Null bytes.
    '/index.html%00',
    '/index.html%00.js',
    `${SCRIPT.path}%00`,
    // Overlong paths and names.
    `/assets/${'a'.repeat(2_000)}.js`,
    `/${'a'.repeat(300)}.js`,
  ])('never serves a file outside the dist dir or hidden in it: %s', async (target) => {
    await expectNotFound(await send(target))
  })

  it.each(['//etc/passwd', '/etc/passwd', '/%00', '/assets/escape-dir', `/${'a'.repeat(5_000)}`])(
    'answers the extensionless %s with index.html at most',
    async (target) => {
      await expectIndex(await send(target))
    },
  )

  it('follows a symlink that stays inside the dist dir', async () => {
    const res = await send('/linked.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SCRIPT.body)
  })
})

describe('the guard runs first, for the UI too', () => {
  const crossSite = (dest: string, mode: string) => ({
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': mode,
    'sec-fetch-dest': dest,
  })

  it.each([
    ['a foreign Host on /', 'http://evil.test/', { host: 'evil.test' }],
    [
      'a DNS-rebinding Host on /',
      'http://rebind.evil.test:4747/',
      { host: 'rebind.evil.test:4747' },
    ],
    ['a foreign Host on an asset', `http://evil.test${SCRIPT.path}`, { host: 'evil.test' }],
    ['a foreign Origin', '/', { origin: 'http://evil.test' }],
    ['a cross-site iframe of /', '/', crossSite('iframe', 'navigate')],
    [
      'a same-site iframe from another localhost port',
      '/',
      { ...crossSite('iframe', 'navigate'), 'sec-fetch-site': 'same-site' },
    ],
    ['a cross-site <script> of an asset', SCRIPT.path, crossSite('script', 'no-cors')],
    ['a cross-site fetch of /', '/', crossSite('empty', 'cors')],
  ])('refuses %s with 403 and the security headers', async (_label, target, headers) => {
    const res = await send(target, { headers })
    expect(res.status).toBe(403)
    expectSecurityHeaders(res)
    const body = await res.text()
    expect(body).not.toContain('<!doctype html>')
    expect(ApiErrorBodySchema.parse(JSON.parse(body)).error.code).toBe('forbidden')
  })

  it('serves index.html to a link from another site (a top-level navigation)', async () => {
    await expectIndex(await send('/', { headers: crossSite('document', 'navigate') }))
  })

  it('serves index.html on localhost:<port> too', async () => {
    await expectIndex(
      await send(`http://localhost:${PORT}/`, { headers: { host: `localhost:${PORT}` } }),
    )
  })
})

describe('without a built UI', () => {
  it('keeps serving the API and explains the 404 for pages', async () => {
    const missing = path.join(base, 'missing')
    expect((await send('/api/health', {}, appFor(missing))).status).toBe(200)
    await expectNotFound(await send('/', {}, appFor(missing)), NO_UI_MESSAGE)
    await expectNotFound(await send('/downloads', {}, appFor(missing)), NO_UI_MESSAGE)
    await expectNotFound(await send(SCRIPT.path, {}, appFor(missing)))
  })

  it('picks up a build made while the server runs', async () => {
    const later = path.join(base, 'later')
    await mkdir(later)
    // One app for both requests, so a cached lookup would show.
    const app = appFor(later)
    await expectNotFound(await send('/', {}, app), NO_UI_MESSAGE)
    await writeFile(path.join(later, 'index.html'), INDEX)
    await expectIndex(await send('/', {}, app))
  })

  it('serves no UI at all without a web root (--dev: Vite serves it)', async () => {
    await expectNotFound(await send('/', {}, appFor(undefined)))
    await expectNotFound(await send(SCRIPT.path, {}, appFor(undefined)))
  })
})

describe('hasBuiltUi', () => {
  it('is true for a dir with an index.html', () => {
    expect(hasBuiltUi(dist)).toBe(true)
  })

  it.each([
    ['a missing dir', () => path.join(base, 'nope')],
    ['a dir without index.html', () => path.join(dist, 'assets')],
    ['a file', () => path.join(base, 'secret.txt')],
  ])('is false for %s', (_label, dir) => {
    expect(hasBuiltUi(dir())).toBe(false)
  })
})
