import { ApiErrorBodySchema, type Health } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { isJson } from './guard.ts'

// Not the default 4747, so the guard is shown to use the port it was given.
const PORT = 4800
const SELF = `localhost:${PORT}`

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}
const stubHealth = { current: async () => health, recheck: async () => health }

const prod = createApp({ port: PORT, health: stubHealth })
// pnpm dev: Vite on 5173 proxies /api here and forwards the browser's Host and Origin unchanged.
const dev = createApp({ port: PORT, devPort: 5173, health: stubHealth })

type Case = {
  name: string
  app?: typeof prod
  method?: string
  path?: string
  /** Authority of the request target; differs from Host only for absolute-form targets. */
  urlHost?: string
  /** Host header; `null` sends none (app.request adds none by itself). */
  host?: string | null
  headers?: Record<string, string>
  body?: string
  status: number
  /** Expected error code and message, for rejections. */
  error?: [code: string, message: string]
}

const JSON_CT = { 'content-type': 'application/json' }
const RECHECK = { method: 'POST', path: '/api/health/recheck', headers: JSON_CT, body: '{}' }

const HOST_403: Case['error'] = ['forbidden', 'Host not allowed']
const ORIGIN_403: Case['error'] = ['forbidden', 'Origin not allowed']
const SITE_403: Case['error'] = ['forbidden', 'Cross-site request not allowed']
const CT_415: Case['error'] = ['invalid_request', 'Content-Type must be application/json']
const NOT_FOUND: Case['error'] = ['not_found', 'Not found']

/** Like a browser or curl request: Host defaults to localhost:<port>. */
function send(k: Case): Promise<Response> {
  const headers = new Headers(k.headers)
  const host = k.host === undefined ? SELF : k.host
  if (host !== null) headers.set('host', host)
  const url = `http://${k.urlHost ?? SELF}${k.path ?? '/api/health'}`
  return Promise.resolve(
    (k.app ?? prod).request(url, { method: k.method ?? 'GET', headers, body: k.body }),
  )
}

const hostCases: Case[] = [
  { name: 'Host localhost:<port>', status: 200 },
  { name: 'Host 127.0.0.1:<port>', host: `127.0.0.1:${PORT}`, status: 200 },
  { name: 'Host in upper case (curl, not browsers)', host: `LOCALHOST:${PORT}`, status: 200 },
  { name: 'no Host (HTTP/1.0)', host: null, status: 403, error: HOST_403 },
  { name: 'an empty Host', host: '', status: 403, error: HOST_403 },
  { name: 'Host with a trailing dot', host: `localhost.:${PORT}`, status: 403, error: HOST_403 },
  {
    name: 'Host on the Vite port in production',
    host: 'localhost:5173',
    status: 403,
    error: HOST_403,
  },
  { name: 'Host on the default port', host: 'localhost:4747', status: 403, error: HOST_403 },
  { name: 'Host without a port', host: 'localhost', status: 403, error: HOST_403 },
  {
    name: 'Host with a leading-zero port',
    host: `localhost:0${PORT}`,
    status: 403,
    error: HOST_403,
  },
  { name: 'Host [::1]', host: `[::1]:${PORT}`, status: 403, error: HOST_403 },
  { name: 'Host 0.0.0.0', host: `0.0.0.0:${PORT}`, status: 403, error: HOST_403 },
  { name: 'Host 127.1 shorthand', host: `127.1:${PORT}`, status: 403, error: HOST_403 },
  {
    name: 'a DNS-rebinding Host',
    host: `rebind.evil.test:${PORT}`,
    status: 403,
    error: HOST_403,
  },
  {
    name: 'Host localhost.evil.test',
    host: `localhost.evil.test:${PORT}`,
    status: 403,
    error: HOST_403,
  },
  {
    name: 'two Hosts joined into one value',
    host: `${SELF}, evil.test`,
    status: 403,
    error: HOST_403,
  },
  { name: 'Host with userinfo', host: `user@${SELF}`, status: 403, error: HOST_403 },
  {
    name: 'an absolute-form target for another host, with our Host',
    urlHost: 'evil.test',
    status: 403,
    error: HOST_403,
  },
  {
    name: 'an absolute-form target for us, with a foreign Host',
    host: 'evil.test',
    status: 403,
    error: HOST_403,
  },
  {
    name: 'a foreign Host on an unknown path (the guard runs before 404)',
    path: '/nope',
    host: 'evil.test',
    status: 403,
    error: HOST_403,
  },
  {
    name: 'a foreign Host on POST',
    ...RECHECK,
    host: `evil.test:${PORT}`,
    status: 403,
    error: HOST_403,
  },
]

// Vite's own host check lets file:*, *-extension:*, any IP and localhost:<anything> through, so
// the proxied Host must still match exactly here.
const devHostCases: Case[] = [
  {
    name: 'Host localhost:5173 (through the Vite proxy)',
    app: dev,
    host: 'localhost:5173',
    status: 200,
  },
  { name: 'Host 127.0.0.1:5173', app: dev, host: '127.0.0.1:5173', status: 200 },
  { name: 'our own Host still works', app: dev, status: 200 },
  {
    name: 'POST through the Vite proxy',
    app: dev,
    ...RECHECK,
    host: 'localhost:5173',
    headers: { ...JSON_CT, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
    status: 200,
  },
  { name: 'another port', app: dev, host: 'localhost:5174', status: 403, error: HOST_403 },
  {
    name: 'Host file:5173 (Vite allows it)',
    app: dev,
    host: 'file:5173',
    status: 403,
    error: HOST_403,
  },
  {
    name: 'Host x-extension:5173 (Vite allows it)',
    app: dev,
    host: 'attacker-extension:5173',
    status: 403,
    error: HOST_403,
  },
  {
    name: 'Host localhost:5173.evil.test (Vite reads only up to the colon)',
    app: dev,
    host: 'localhost:5173.evil.test',
    status: 403,
    error: HOST_403,
  },
  { name: 'Host [::1]:5173', app: dev, host: '[::1]:5173', status: 403, error: HOST_403 },
  { name: 'Host 0.0.0.0:5173', app: dev, host: '0.0.0.0:5173', status: 403, error: HOST_403 },
  {
    name: 'a Vite Host with a foreign Origin',
    app: dev,
    ...RECHECK,
    host: 'localhost:5173',
    headers: { ...JSON_CT, origin: 'http://localhost:3000' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'a Vite Host with a cross-site fetch',
    app: dev,
    host: 'localhost:5173',
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    status: 403,
    error: SITE_403,
  },
]

const originCases: Case[] = [
  { name: 'GET with Origin localhost:<port>', headers: { origin: `http://${SELF}` }, status: 200 },
  {
    name: 'GET with Origin 127.0.0.1:<port>',
    headers: { origin: `http://127.0.0.1:${PORT}` },
    status: 200,
  },
  {
    name: 'GET with a foreign Origin (cross-origin fetch or EventSource)',
    headers: { origin: 'http://evil.test' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'GET with Origin null (sandboxed iframe)',
    headers: { origin: 'null' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'GET with another localhost port as Origin',
    headers: { origin: 'http://localhost:3000' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'GET with the Vite Origin in production',
    headers: { origin: 'http://localhost:5173' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'GET with the Vite Origin in dev',
    app: dev,
    headers: { origin: 'http://localhost:5173' },
    status: 200,
  },
  {
    name: 'POST with the Vite Origin in dev',
    app: dev,
    ...RECHECK,
    headers: { ...JSON_CT, origin: 'http://localhost:5173' },
    status: 200,
  },
  {
    name: 'POST with the 127.0.0.1 Vite Origin in dev',
    app: dev,
    ...RECHECK,
    headers: { ...JSON_CT, origin: 'http://127.0.0.1:5173' },
    status: 200,
  },
  {
    name: 'POST with another localhost port as Origin in dev',
    app: dev,
    ...RECHECK,
    headers: { ...JSON_CT, origin: 'http://localhost:3000' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'POST with our own Origin',
    ...RECHECK,
    headers: { ...JSON_CT, origin: `http://${SELF}` },
    status: 200,
  },
  {
    name: 'POST JSON with a foreign Origin (Safari no-cors Blob, no preflight)',
    ...RECHECK,
    headers: { ...JSON_CT, origin: 'http://evil.test' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'POST with Origin null',
    ...RECHECK,
    headers: { ...JSON_CT, origin: 'null' },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'POST with two Origins joined into one value',
    ...RECHECK,
    headers: { ...JSON_CT, origin: `http://${SELF}, http://evil.test` },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'POST with our Origin plus a trailing slash',
    ...RECHECK,
    headers: { ...JSON_CT, origin: `http://${SELF}/` },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'POST with our Origin over https',
    ...RECHECK,
    headers: { ...JSON_CT, origin: `https://${SELF}` },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'a CORS preflight from a foreign Origin',
    method: 'OPTIONS',
    path: '/api/health/recheck',
    headers: {
      origin: 'http://evil.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
    status: 403,
    error: ORIGIN_403,
  },
  {
    name: 'OPTIONS without an Origin (curl): passes the guard, no route',
    method: 'OPTIONS',
    path: '/api/health/recheck',
    status: 404,
    error: NOT_FOUND,
  },
]

const fetchMetadataCases: Case[] = [
  { name: 'Sec-Fetch-Site same-origin', headers: { 'sec-fetch-site': 'same-origin' }, status: 200 },
  { name: 'Sec-Fetch-Site none (typed URL)', headers: { 'sec-fetch-site': 'none' }, status: 200 },
  {
    name: 'a cross-site <img> GET without Origin',
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'image',
    },
    status: 403,
    error: SITE_403,
  },
  {
    name: 'a same-site request (another port on localhost)',
    headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    status: 403,
    error: SITE_403,
  },
  {
    name: 'a cross-site top-level link (navigate, document)',
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    status: 200,
  },
  {
    name: 'a cross-site top-level HEAD navigation',
    method: 'HEAD',
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    status: 200,
  },
  {
    name: 'a cross-site iframe (clickjacking)',
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'iframe',
    },
    status: 403,
    error: SITE_403,
  },
  {
    name: 'a cross-site form POST navigation without Origin',
    ...RECHECK,
    headers: {
      ...JSON_CT,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    status: 403,
    error: SITE_403,
  },
  {
    name: 'a cross-site sendBeacon POST without Origin',
    ...RECHECK,
    headers: {
      ...JSON_CT,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'empty',
    },
    status: 403,
    error: SITE_403,
  },
]

const contentTypeCases: Case[] = [
  { name: 'POST application/json', ...RECHECK, status: 200 },
  {
    name: 'POST application/json; charset=utf-8',
    ...RECHECK,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status: 200,
  },
  {
    name: 'POST APPLICATION/JSON',
    ...RECHECK,
    headers: { 'content-type': 'APPLICATION/JSON' },
    status: 200,
  },
  { name: 'POST with a JSON type and no body', ...RECHECK, body: undefined, status: 200 },
  { name: 'POST without Content-Type', ...RECHECK, headers: {}, status: 415, error: CT_415 },
  ...[
    'text/plain;charset=UTF-8',
    'text/plain; x=application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/json-seq',
    'application/vnd.api+json',
    'text/json',
    'application/json, text/plain',
    'text/plain, application/json',
  ].map(
    (type): Case => ({
      name: `POST ${type}`,
      ...RECHECK,
      headers: { 'content-type': type },
      status: 415,
      error: CT_415,
    }),
  ),
  ...['PUT', 'PATCH', 'DELETE'].map(
    (method): Case => ({
      name: `${method} without Content-Type`,
      method,
      status: 415,
      error: CT_415,
    }),
  ),
  {
    name: 'DELETE with JSON: passes the guard, no route',
    method: 'DELETE',
    headers: JSON_CT,
    status: 404,
    error: NOT_FOUND,
  },
  { name: 'HEAD without Content-Type', method: 'HEAD', status: 200 },
  { name: 'GET on an unknown path', path: '/api/nope', status: 404, error: NOT_FOUND },
]

describe('guard', () => {
  describe.each([
    ['Host (DNS rebinding)', hostCases],
    ['Host in dev (Vite proxy)', devHostCases],
    ['Origin', originCases],
    ['Sec-Fetch-Site', fetchMetadataCases],
    ['Content-Type on unsafe methods', contentTypeCases],
  ])('%s', (_group, cases) => {
    it.each(cases)('$name -> $status', async (k) => {
      const res = await send(k)
      expect(res.status).toBe(k.status)
      expect([...res.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual(
        [],
      )
      if (k.error !== undefined) {
        expect(res.headers.get('content-type')).toMatch(/^application\/json/)
        const body = ApiErrorBodySchema.parse(await res.json())
        expect([body.error.code, body.error.message]).toEqual(k.error)
      }
    })
  })
})

describe('isJson', () => {
  it.each([
    ['application/json', true],
    ['application/json;charset=utf-8', true],
    [' Application/JSON ; charset=UTF-8', true],
    [undefined, false],
    ['', false],
    ['application/jsonx', false],
    ['application/json-seq', false],
    ['application/ld+json', false],
    ['application/json, text/plain', false],
    ['text/plain;application/json', false],
  ] as const)('%j -> %s', (value, expected) => {
    expect(isJson(value)).toBe(expected)
  })
})
