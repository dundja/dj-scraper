import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEmbedPage } from '../src/spotify/embed.ts'
import {
  readFakeMedia,
  SPOTIFY_FIXTURE_COVER,
  SPOTIFY_FIXTURES,
  SPOTIFY_PAGES,
  type SpotifyFixtureServer,
  startSpotifyFixtures,
} from './helpers.ts'

// The Spotify embed page fixtures: the scrubber that made them (fixtures/spotify/trim-embed.mjs)
// and the local server that serves them to the integration and e2e tests (startSpotifyFixtures).

const TRIM = path.join(SPOTIFY_FIXTURES, 'trim-embed.mjs')
const fixture = (name: string) => readFileSync(path.join(SPOTIFY_FIXTURES, name), 'utf8')

/** Runs the scrubber on `html`, as the README's recording pipe does. */
function trim(html: string) {
  const result = spawnSync(process.execPath, [TRIM], { input: html, encoding: 'utf8' })
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A page shaped like the live one: data beside the secrets the embed page carries, `<` escaped in
 * the JSON as Next.js does.
 */
function livePage(data: unknown): string {
  const next = {
    props: {
      pageProps: {
        state: {
          data,
          settings: {
            rtl: false,
            session: {
              accessToken: 'BQD-anonymous-access-token-value',
              accessTokenExpirationTimestampMs: 1790000000000,
              isAnonymous: true,
            },
            entityContext: 'track',
            clientId: 'client-id-0123456789abcdef',
          },
          machineState: { initialized: true },
        },
        config: {
          correlationId: 'correlation-id-feedface',
          clientId: 'client-id-0123456789abcdef',
          restrictionId: 'restriction-id-1',
        },
        _sentryTraceData: 'sentry-trace-0123',
        _sentryBaggage: 'sentry-environment=production,sentry-public_key=abc',
      },
      __N_SSP: true,
    },
    page: '/[type]/[id]',
    query: { id: '4uLU6hMCjMI75M1A2tKUQC' },
    buildId: 'build-xyz',
  }
  return `<!DOCTYPE html><html><head><script src="https://open.spotifycdn.com/cdn/build/x.js"></script><script>window.__sentry = 1</script></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next).replaceAll('<', '\\u003c')}</script></body></html>`
}

const ENTITY = {
  type: 'playlist',
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Mix <script>alert(1)</script>',
  title: 'Mix',
  subtitle: 'Spotify',
  attributes: [
    { key: 'correlation-id', value: 'ssp~0123' },
    { key: 'moveFollowersJobId', value: 'x' },
  ],
  trackList: [
    {
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      title: 'Never Gonna Give You Up',
      subtitle: 'Rick Astley',
      duration: 213573,
      audioPreview: { format: 'MP3_96', url: 'https://p.scdn.co/mp3-preview/40a780b231e5ed13' },
      entityType: 'track',
    },
  ],
}

describe('trim-embed.mjs', () => {
  it('keeps only the page data: no token, ids, tracing, preview URLs or scripts', () => {
    const { exit, stdout, stderr } = trim(livePage({ entity: ENTITY, embeded_entity_uri: 'x' }))
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    for (const secret of [
      'access-token-value',
      'accessToken',
      'client-id',
      'clientId',
      'correlation',
      'restriction',
      'sentry',
      'build-xyz',
      'mp3-preview',
      'moveFollowersJobId',
      'spotifycdn.com/cdn',
    ]) {
      expect(stdout).not.toContain(secret)
    }
    expect(stdout.match(/<script\b/g)).toHaveLength(1)
    // A title can't end the script: `<` and `>` are escaped as Next.js escapes them.
    expect(stdout).not.toContain('<script>alert')
    const entity = parseEmbedPage(stdout)
    expect(entity).toMatchObject({
      type: 'playlist',
      title: 'Mix <script>alert(1)</script>',
      rows: [{ id: '4uLU6hMCjMI75M1A2tKUQC', title: 'Never Gonna Give You Up' }],
    })
  })

  it.each([
    ['an access token', { entity: { ...ENTITY, accessToken: 'BQD-leak' } }],
    ['a token field', { entity: ENTITY, refresh_token: 'x' }],
    ['a client id', { entity: { ...ENTITY, clientId: 'abc' } }],
    ['a correlation id', { entity: { ...ENTITY, subtitle: 'correlationId' } }],
    ['Sentry data', { entity: { ...ENTITY, name: 'sentry' } }],
    ['a session', { entity: ENTITY, session: { anonymous: true } }],
    ['a preview stream URL', { entity: { ...ENTITY, preview: 'https://p.scdn.co/mp3-preview/x' } }],
  ])('refuses to write a page whose data still holds %s', (_label, data) => {
    expect(trim(livePage(data))).toEqual({
      exit: 1,
      stdout: '',
      stderr: expect.stringMatching(/^trim-embed: refusing to write, possible leaks: .+\n$/),
    })
  })

  it.each([
    ['no data script', '<html><body>Spotify</body></html>', 'no __NEXT_DATA__ script'],
    ['a data script that is no JSON', '<script id="__NEXT_DATA__">{nope</script>', 'is not JSON'],
    ['no state data', '<script id="__NEXT_DATA__">{"props":{}}</script>', 'no props.pageProps'],
  ])('refuses a page with %s', (_label, html, message) => {
    const { exit, stdout, stderr } = trim(html)
    expect({ exit, stdout }).toEqual({ exit: 1, stdout: '' })
    expect(stderr).toContain(message)
  })

  it.each(readdirSync(SPOTIFY_FIXTURES).filter((name) => name.endsWith('.html')))(
    'leaves the checked-in %s as it is: it is the scrubber’s own output',
    (name) => {
      expect(trim(fixture(name))).toEqual({ exit: 0, stdout: fixture(name), stderr: '' })
    },
  )
})

describe('startSpotifyFixtures', () => {
  const servers: SpotifyFixtureServer[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })
  const start = async (options?: Parameters<typeof startSpotifyFixtures>[0]) => {
    const server = await startSpotifyFixtures(options)
    servers.push(server)
    return server
  }

  it('serves every recorded page on 127.0.0.1, its covers rewritten to itself', async () => {
    const server = await start()
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(Object.values(SPOTIFY_PAGES).toSorted()).toEqual(
      readdirSync(SPOTIFY_FIXTURES)
        .filter((name) => name.endsWith('.html'))
        .toSorted(),
    )
    for (const [route, file] of Object.entries(SPOTIFY_PAGES)) {
      const res = await fetch(`${server.origin}${route}`)
      expect(res.status, route).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const html = await res.text()
      expect(html).toBe(server.page(file))
      expect(html, route).not.toMatch(/spotifycdn\.com|scdn\.co/)
      expect(html).toContain(`${server.origin}/image/`)
    }
  })

  it('answers every cover with the fake 640 px JPEG', async () => {
    const server = await start()
    const res = await fetch(server.coverUrl('ab67616d0000b273255e131abc1410833be95673'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(readFakeMedia(new Uint8Array(await res.arrayBuffer()))).toEqual({
      kind: 'image',
      info: SPOTIFY_FIXTURE_COVER,
    })
  })

  it("answers 404 for anything else, and a test's own pages, statuses and missing covers", async () => {
    const server = await start({
      pages: { '/embed/track/0000000000000000000001': '<html>own</html>' },
      status: { '/embed/track/4uLU6hMCjMI75M1A2tKUQC': 429 },
      cover: null,
    })
    const get = async (route: string) => (await fetch(`${server.origin}${route}`)).status
    expect(await get('/embed/track/0000000000000000000001')).toBe(200)
    expect(await get('/embed/track/4uLU6hMCjMI75M1A2tKUQC')).toBe(429)
    expect(await get('/image/ab67616d0000b273')).toBe(404)
    expect(await get('/track/4uLU6hMCjMI75M1A2tKUQC')).toBe(404)
    expect(await get('/embed/artist/0gxyHStUsqpMadRV0Di1Qt')).toBe(404)
    expect(server.requests()).toEqual([
      '/embed/track/0000000000000000000001',
      '/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      '/image/ab67616d0000b273',
      '/track/4uLU6hMCjMI75M1A2tKUQC',
      '/embed/artist/0gxyHStUsqpMadRV0Di1Qt',
    ])
  })
})
