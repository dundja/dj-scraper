// @vitest-environment node
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { devGuardMiddleware } from './dev-guard.ts'

const PORT = 5173
const middleware = devGuardMiddleware(PORT)

type Request = { method?: string; url?: string; headers?: IncomingMessage['headers'] }

/** Runs the middleware on a fake request; returns whether it passed and what it answered. */
function run({ method = 'GET', url = '/', headers = {} }: Request) {
  const req = { method, url, headers: { host: `localhost:${PORT}`, ...headers } } as IncomingMessage
  const answer = { status: 0, headers: new Map<string, string>(), body: '' }
  const res = {
    set statusCode(value: number) {
      answer.status = value
    },
    setHeader: (name: string, value: string) => answer.headers.set(name.toLowerCase(), value),
    end: (body: string) => {
      answer.body = body
    },
  } as unknown as ServerResponse
  const next = vi.fn()
  middleware(req, res, next)
  return { passed: next.mock.calls.length === 1, ...answer }
}

const sameOrigin = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
}
const crossSiteLink = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}
const otherPortLink = { ...crossSiteLink, 'sec-fetch-site': 'same-site' }

const refused = (body: string) => ({ passed: false, status: 403, body })

describe('the dev server guard', () => {
  it.each<[string, Request]>([
    [
      'a module the app loads',
      { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } },
    ],
    ['a typed URL', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } }],
    ['a link from another site', { headers: crossSiteLink }],
    ['Host 127.0.0.1:5173', { headers: { host: '127.0.0.1:5173' } }],
    ['Host in upper case (curl)', { headers: { host: 'LOCALHOST:5173' } }],
    ['curl without Fetch Metadata', { method: 'POST', url: '/api/health/recheck' }],
    [
      "Vite's error overlay opening a file",
      { url: '/__open-in-editor?file=src/main.tsx', headers: sameOrigin },
    ],
  ])('passes %s on to Vite', (_label, request) => {
    expect(run(request)).toMatchObject({ passed: true, status: 0 })
  })

  describe('Host (DNS rebinding: Vite lets these through)', () => {
    it.each([
      'file:5173',
      'attacker-extension:5173',
      'localhost:5173.evil.example',
      'evil.localhost:5173',
      '[::1]:5173',
      '0.0.0.0:5173',
      '192.168.1.10:5173',
      'localhost:5174',
      'localhost',
      '',
    ])('refuses Host %j', (host) => {
      expect(run({ headers: { host } })).toMatchObject(refused('Host not allowed'))
    })

    it('refuses a request without Host (HTTP/1.0)', () => {
      const req = { method: 'GET', url: '/', headers: {} } as IncomingMessage
      const res = { setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse
      const next = vi.fn()
      middleware(req, res, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(403)
    })
  })

  describe('Fetch Metadata', () => {
    it.each<[string, Request]>([
      [
        'another site framing the app',
        { headers: { ...crossSiteLink, 'sec-fetch-dest': 'iframe' } },
      ],
      [
        'another site loading a file as an image',
        {
          url: '/src/main.tsx',
          headers: {
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'image',
          },
        },
      ],
      [
        'another localhost port loading a module',
        {
          url: '/src/main.tsx',
          headers: {
            'sec-fetch-site': 'same-site',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'script',
          },
        },
      ],
      [
        'a cross-site form POST to /api',
        { method: 'POST', url: '/api/health/recheck', headers: crossSiteLink },
      ],
    ])('refuses %s', (_label, request) => {
      expect(run(request)).toMatchObject(refused('Cross-site request not allowed'))
    })
  })

  describe("Vite's /__open-in-editor (opens files in the developer's editor)", () => {
    it.each<[string, Request]>([
      [
        'a link from another site',
        { url: '/__open-in-editor?file=/etc/hosts', headers: crossSiteLink },
      ],
      [
        'a link from another localhost port',
        { url: '/__open-in-editor?file=/etc/hosts', headers: otherPortLink },
      ],
      [
        'a typed URL',
        {
          url: '/__open-in-editor?file=/etc/hosts',
          headers: { ...crossSiteLink, 'sec-fetch-site': 'none' },
        },
      ],
      [
        'a different case (connect matches routes case-insensitively)',
        { url: '/__OPEN-IN-EDITOR?file=/etc/hosts', headers: crossSiteLink },
      ],
      ['a trailing slash', { url: '/__open-in-editor/?file=/etc/hosts', headers: crossSiteLink }],
      [
        'an absolute-form target',
        { url: 'http://localhost:5173/__open-in-editor?file=/etc/hosts', headers: crossSiteLink },
      ],
      [
        'an <img> from another site',
        {
          url: '/__open-in-editor?file=/etc/hosts',
          headers: {
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'image',
          },
        },
      ],
    ])('refuses %s', (_label, request) => {
      expect(run(request)).toMatchObject(refused('Cross-site request not allowed'))
    })
  })

  it('answers refusals as plain text', () => {
    expect(run({ headers: { host: 'file:5173' } }).headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    )
  })
})
