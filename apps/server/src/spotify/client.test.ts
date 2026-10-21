import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyUrl, type ValidUrl } from '@dj-scraper/shared'
import { describe, expect, it, vi } from 'vitest'
import { CANCELED } from '../resolve/ytdlp-call.ts'
import {
  createSpotifyClient,
  SPOTIFY_NOT_FOUND,
  SPOTIFY_ORIGIN,
  SPOTIFY_RATE_LIMITED,
  SPOTIFY_TIMEOUT_MS,
  SPOTIFY_UNREACHABLE,
  SPOTIFY_UNREADABLE,
  SpotifyError,
} from './client.ts'
import { parseEmbedPage } from './embed.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/spotify')
const TRACK_PAGE = readFileSync(path.join(fixturesDir, 'track.html'), 'utf8')
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_COVER_BYTES = 5 * 1024 * 1024
const COVER = 'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

function classified(url: string): ValidUrl {
  const result = classifyUrl(url)
  if (!result.ok) throw new Error(`not a valid URL: ${url}`)
  return result
}

const TRACK = classified('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=share')
const ALBUM = classified('https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4')

type FetchArgs = Parameters<typeof fetch>
type Body = ConstructorParameters<typeof Response>[0]

/** A fetch that answers `respond`, recording what it was asked. */
function fakeFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = input instanceof URL ? input : new URL(String(input))
    return respond(url, init ?? {})
  })
}

const html = (body: Body, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers },
  })

/** A body that sends `chunks` and then stalls until the request is aborted. */
function stalling(signal: AbortSignal | null | undefined, ...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      signal?.addEventListener('abort', () => controller.error(signal.reason))
    },
  })
}

/** A fetch that never answers until its signal aborts, as a stalled connection does. */
const hangingFetch = () =>
  fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // As fetch does: an aborted signal rejects at once, a later abort when it comes.
        if (init.signal?.aborted) reject(init.signal.reason)
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
  )

/** The SpotifyError a promise rejects with. */
async function spotifyError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  if (!(error instanceof SpotifyError)) throw error
  return { info: error.info, detail: error.detail }
}

describe('spotifyClient.entity', () => {
  it("reads the embed page built from the link's id alone, as a desktop browser, without redirects", async () => {
    const fetchFn = fakeFetch(() => html(TRACK_PAGE))
    const client = createSpotifyClient({ fetch: fetchFn })
    const controller = new AbortController()
    expect(await client.entity(TRACK, controller.signal)).toStrictEqual(parseEmbedPage(TRACK_PAGE))

    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(String(url)).toBe(`${SPOTIFY_ORIGIN}/embed/track/4uLU6hMCjMI75M1A2tKUQC`)
    expect(init).toMatchObject({ redirect: 'error' })
    const headers = new Headers(init?.headers)
    expect(headers.get('user-agent')).toMatch(/^Mozilla\/5\.0 \(Macintosh;.* Chrome\/\d+/)
    expect(headers.get('accept-language')).toBe('en')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    // The caller's signal and the timeout, combined.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
    controller.abort()
    expect(init?.signal?.aborted).toBe(true)
  })

  it.each([
    ['http://127.0.0.1:4850', 'http://127.0.0.1:4850/embed/album/6N9PS4QXF1D0OWPk0Sxtb4'],
    ['http://127.0.0.1:4850/', 'http://127.0.0.1:4850/embed/album/6N9PS4QXF1D0OWPk0Sxtb4'],
    ['https://spotify.test/some/path', 'https://spotify.test/embed/album/6N9PS4QXF1D0OWPk0Sxtb4'],
  ])('reads the pages from the origin %s instead, when one is set', async (origin, expected) => {
    const fetchFn = fakeFetch(() => html(TRACK_PAGE))
    await createSpotifyClient({ origin, fetch: fetchFn }).entity(ALBUM)
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(expected)
  })

  it.each(['ftp://spotify.test', 'file:///etc', 'javascript:alert(1)'])(
    'refuses the origin %s',
    (origin) => {
      expect(() => createSpotifyClient({ origin })).toThrow(RangeError)
    },
  )

  it('refuses a classified URL without a Spotify id, before fetching', async () => {
    const fetchFn = fakeFetch(() => html(TRACK_PAGE))
    const client = createSpotifyClient({ fetch: fetchFn })
    await expect(
      client.entity(classified('https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt')),
    ).rejects.toThrow(RangeError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [404, SPOTIFY_NOT_FOUND],
    [429, SPOTIFY_RATE_LIMITED],
    [403, { code: 'network', message: 'Spotify answered with an error (HTTP 403).' }],
    [500, { code: 'network', message: 'Spotify answered with an error (HTTP 500).' }],
    [503, { code: 'network', message: 'Spotify answered with an error (HTTP 503).' }],
  ] as const)('maps HTTP %i to %j', async (status, info) => {
    const client = createSpotifyClient({ fetch: fakeFetch(() => html('nope', { status })) })
    expect(await spotifyError(client.entity(TRACK))).toEqual({ info, detail: `HTTP ${status}` })
  })

  it('maps a failed fetch (DNS, refused, a redirect) to network, logging only its name', async () => {
    const failure = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND open.spotify.com'),
    })
    const client = createSpotifyClient({
      fetch: fakeFetch(() => {
        throw failure
      }),
    })
    expect(await spotifyError(client.entity(TRACK))).toEqual({
      info: SPOTIFY_UNREACHABLE,
      detail: 'TypeError',
    })
  })

  it('gives up on a page that does not answer in time, as network', async () => {
    const client = createSpotifyClient({ fetch: hangingFetch(), timeoutMs: 20 })
    expect(await spotifyError(client.entity(TRACK))).toEqual({
      info: { code: 'network', message: "Spotify didn't answer in time. Try again." },
      detail: 'timeout',
    })
  })

  it('gives up on a body that stalls halfway, as network', async () => {
    const client = createSpotifyClient({
      fetch: fakeFetch((_url, init) => html(stalling(init.signal, new Uint8Array(10)))),
      timeoutMs: 20,
    })
    expect(await spotifyError(client.entity(TRACK))).toMatchObject({ detail: 'timeout' })
  })

  it('waits 20 s by default', () => {
    expect(SPOTIFY_TIMEOUT_MS).toBe(20_000)
  })

  it('answers canceled when the caller aborts, while waiting or while reading', async () => {
    const waiting = new AbortController()
    const client = createSpotifyClient({ fetch: hangingFetch() })
    const pending = client.entity(TRACK, waiting.signal)
    waiting.abort()
    expect(await spotifyError(pending)).toEqual({ info: CANCELED, detail: 'aborted' })

    const reading = new AbortController()
    const slowBody = createSpotifyClient({
      fetch: fakeFetch((_url, init) => html(stalling(init.signal, new Uint8Array(10)))),
    })
    const read = slowBody.entity(TRACK, reading.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    reading.abort()
    expect(await spotifyError(read)).toEqual({ info: CANCELED, detail: 'aborted' })
  })

  it('answers canceled at once for a signal that is already aborted', async () => {
    const client = createSpotifyClient({ fetch: hangingFetch() })
    expect(await spotifyError(client.entity(TRACK, AbortSignal.abort()))).toMatchObject({
      info: CANCELED,
    })
  })

  it.each([
    ['a page without its data', '<html><body>Spotify</body></html>', 'no __NEXT_DATA__ script'],
    ['an empty answer', null, 'no __NEXT_DATA__ script'],
    [
      'an artist page',
      '<script id="__NEXT_DATA__">{"props":{"pageProps":{"state":{"data":{"entity":{"type":"artist"}}}}}}</script>',
      'not a track, album or playlist',
    ],
  ])('answers unknown for %s, with a detail that quotes nothing', async (_label, body, detail) => {
    const client = createSpotifyClient({ fetch: fakeFetch(() => html(body)) })
    const error = await spotifyError(client.entity(TRACK))
    expect(error.info).toEqual(SPOTIFY_UNREADABLE)
    expect(error.detail).toContain(detail)
    expect(error.detail).not.toContain('Spotify<')
  })

  it('refuses a page that says it is over 2 MiB without reading it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const client = createSpotifyClient({
      fetch: fakeFetch(() =>
        html(body, { headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } }),
      ),
    })
    expect(await spotifyError(client.entity(TRACK))).toEqual({
      info: SPOTIFY_UNREADABLE,
      detail: `the answer is over ${MAX_PAGE_BYTES} bytes`,
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('stops reading a page once it grows past 2 MiB, whatever its length says', async () => {
    let pulled = 0
    const chunk = new Uint8Array(512 * 1024)
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
      },
    })
    const client = createSpotifyClient({
      fetch: fakeFetch(() => html(endless, { headers: { 'content-length': '100' } })),
    })
    expect(await spotifyError(client.entity(TRACK))).toEqual({
      info: SPOTIFY_UNREADABLE,
      detail: `the answer is over ${MAX_PAGE_BYTES} bytes`,
    })
    expect(pulled).toBeLessThanOrEqual(6)
  })

  it('reads a page of exactly 2 MiB', async () => {
    const page = TRACK_PAGE.padEnd(MAX_PAGE_BYTES, ' ')
    expect(Buffer.byteLength(page)).toBe(MAX_PAGE_BYTES)
    const client = createSpotifyClient({ fetch: fakeFetch(() => html(page)) })
    expect((await client.entity(TRACK)).type).toBe('track')
  })
})

describe('spotifyClient.cover', () => {
  const image = (body: Body = JPEG, init: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      ...init,
      headers: { 'content-type': 'image/jpeg', ...init.headers },
    })

  it.each([
    COVER,
    'https://i.scdn.co/image/ab67706f0000000230888e59410296f950502d00',
    'https://scdn.co/image/x',
    'https://spotifycdn.com/image/x',
  ])("fetches %s from Spotify's image CDNs, with the same care as a page", async (url) => {
    const fetchFn = fakeFetch(() => image())
    const bytes = await createSpotifyClient({ fetch: fetchFn }).cover(url)
    expect(bytes && new Uint8Array(bytes)).toEqual(JPEG)
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(url)
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })

  it.each([
    ['plain http', 'http://i.scdn.co/image/x'],
    ['another host', 'https://example.com/image/x'],
    ['a look-alike host', 'https://scdn.co.example.com/image/x'],
    ['a host ending in the name', 'https://evilscdn.co/image/x'],
    ['the origin over plain http', 'http://open.spotify.com/image/x'],
    ['a data URL', 'data:image/jpeg;base64,/9j/'],
    ['a file URL', 'file:///etc/passwd'],
    ['no URL', 'not a url'],
    ['the loopback host when the origin is Spotify', 'http://127.0.0.1:4850/image/x'],
  ])('fetches nothing for %s', async (_label, url) => {
    const fetchFn = fakeFetch(() => image())
    expect(await createSpotifyClient({ fetch: fetchFn }).cover(url)).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fetches covers from the configured origin too, but no other port of its host', async () => {
    const fetchFn = fakeFetch(() => image())
    const client = createSpotifyClient({ origin: 'http://127.0.0.1:4850', fetch: fetchFn })
    const bytes = await client.cover('http://127.0.0.1:4850/image/abc')
    expect(bytes && new Uint8Array(bytes)).toEqual(JPEG)
    expect(await client.cover('http://127.0.0.1:4851/image/abc')).toBeUndefined()
    expect(await client.cover('http://localhost:4850/image/abc')).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it.each([
    ['an HTML answer', () => html('<html></html>')],
    ['no content type', () => new Response(JPEG, { status: 200 })],
    ['a 404', () => image(null, { status: 404 })],
    ['a 429', () => image(null, { status: 429 })],
    ['a 500', () => image(null, { status: 500 })],
    ['a failed fetch', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'an image over 5 MiB',
      () =>
        image(new Uint8Array(1), { headers: { 'content-length': String(MAX_COVER_BYTES + 1) } }),
    ],
  ])('answers undefined for %s: a cover is never worth a failure', async (_label, respond) => {
    const client = createSpotifyClient({ fetch: fakeFetch(respond) })
    expect(await client.cover(COVER)).toBeUndefined()
  })

  it('answers undefined when the image does not come in time', async () => {
    const client = createSpotifyClient({ fetch: hangingFetch(), timeoutMs: 20 })
    expect(await client.cover(COVER)).toBeUndefined()
  })

  it("rethrows the caller's abort, so the attempt ends canceled", async () => {
    const controller = new AbortController()
    const client = createSpotifyClient({ fetch: hangingFetch() })
    const pending = client.cover(COVER, controller.signal)
    const reason = new Error('canceled by the user')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
