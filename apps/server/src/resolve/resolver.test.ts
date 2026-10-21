import {
  type Collection,
  classifyUrl,
  MAX_COLLECTION_ENTRIES,
  type ResolveMode,
  type Track,
  urlRejectionMessage,
} from '@dj-scraper/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEnv } from '../engine/binaries.ts'
import { type RunOptions, type RunResult, type run, SpawnError } from '../engine/run.ts'
import { resolveArgs } from '../engine/ytdlp-args.ts'
import { mapYtdlpError } from '../engine/ytdlp-errors.ts'
import { InfoParseError, normalizeInfo } from '../engine/ytdlp-parse.ts'
import { ApiError } from '../http/errors.ts'
import {
  SPOTIFY_NOT_FOUND,
  SPOTIFY_RATE_LIMITED,
  SPOTIFY_UNREACHABLE,
  SPOTIFY_UNREADABLE,
  type SpotifyClient,
  SpotifyError,
} from '../spotify/client.ts'
import { type SpotifyEntity, toResolveResult } from '../spotify/embed.ts'
import { OUT_OF_SCOPE_MESSAGE, SPOTIFY_OTHER_MESSAGE } from './input.ts'
import { createResolver } from './resolver.ts'
import { CANCELED, YTDLP_MAX_OUTPUT_BYTES } from './ytdlp-call.ts'

// The parser and the error mapper have their own fixture tests; here they are stand-ins.
vi.mock('../engine/ytdlp-parse.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/ytdlp-parse.ts')>()),
  normalizeInfo: vi.fn(),
  normalizeEntry: vi.fn(),
}))
vi.mock('../engine/ytdlp-errors.ts', () => ({ mapYtdlpError: vi.fn() }))

/** Any existing executable: the fake run never starts it. */
const ENGINE = { YTDLP_PATH: process.execPath }
const NODE = '/opt/homebrew/bin/node'

const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'
const WATCH_LIST_URL = `${VIDEO_URL}&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0`
const SECRET_URL = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'

const TRACK: Track = {
  id: 'jNQXAC9IVRw',
  platform: 'youtube',
  url: VIDEO_URL,
  title: 'Me at the zoo',
  uploader: 'jawed',
  durationSec: 19,
  availability: 'available',
  source: { codec: 'opus', bitrateKbps: 130 },
}

const COLLECTION: Collection = {
  id: 'PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  platform: 'youtube',
  url: PLAYLIST_URL,
  kind: 'playlist',
  title: 'Test playlist',
  truncated: false,
  entries: [{ ...TRACK, partial: false }],
}

const INFO = { _type: 'video', id: 'jNQXAC9IVRw' }

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify(INFO),
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 12,
  ...overrides,
})

function setup({
  run: runImpl = async () => result(),
  maxConcurrent = 4,
  engine = ENGINE,
  spotify,
}: {
  run?: typeof run
  maxConcurrent?: number
  engine?: EngineEnv
  spotify?: SpotifyClient
} = {}) {
  const runFn = vi.fn<typeof run>(runImpl)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const resolver = createResolver({
    engine,
    run: runFn,
    jsRuntime: NODE,
    maxConcurrent,
    log,
    ...(spotify === undefined ? {} : { spotify }),
  })
  const resolve = (url: string, mode: ResolveMode = 'auto', signal?: AbortSignal) =>
    resolver.resolve({ url, mode }, signal)
  return { resolve, run: runFn, log }
}

/** The ApiError a promise rejects with (fails the test if it resolves or rejects otherwise). */
async function apiError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  if (!(error instanceof ApiError)) throw error
  return { code: error.code, message: error.message }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Long enough for a resolve to locate yt-dlp (a few fs calls) and queue for a slot. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

/** Every string the logger got, to check that no URL leaks into it. */
const logged = (log: ReturnType<typeof setup>['log']) =>
  [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')

beforeEach(() => {
  vi.mocked(normalizeInfo).mockReturnValue({ kind: 'track', track: TRACK })
  vi.mocked(mapYtdlpError).mockReturnValue({ code: 'private', message: 'This video is private.' })
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('resolver.resolve', () => {
  it.each([
    ['  youtu.be/jNQXAC9IVRw\n', 'https://youtu.be/jNQXAC9IVRw'],
    ['HTTPS://WWW.YOUTUBE.COM./watch?v=jNQXAC9IVRw', VIDEO_URL],
  ])('passes yt-dlp the normalized URL of %j, not the pasted text', async (pasted, normalized) => {
    const { resolve, run } = setup()
    await resolve(pasted)
    expect(run.mock.calls[0]?.[1].at(-1)).toBe(normalized)
    expect(vi.mocked(normalizeInfo).mock.calls[0]?.[1].input.url).toBe(normalized)
  })

  it('runs yt-dlp once with the planned argv and returns the normalized track', async () => {
    const { resolve, run, log } = setup()
    const controller = new AbortController()

    await expect(resolve(VIDEO_URL, 'auto', controller.signal)).resolves.toStrictEqual({
      kind: 'track',
      track: TRACK,
    })

    expect(run).toHaveBeenCalledOnce()
    const [bin, argv, options] = run.mock.calls[0] ?? []
    expect(bin).toBe(process.execPath)
    expect(argv).toEqual(
      resolveArgs({
        url: VIDEO_URL,
        playlist: 'no',
        limit: MAX_COLLECTION_ENTRIES,
        jsRuntime: NODE,
      }),
    )
    expect(options).toEqual({
      timeoutMs: 60_000,
      signal: controller.signal,
      maxOutputBytes: YTDLP_MAX_OUTPUT_BYTES,
    } satisfies RunOptions)

    const input = classifyUrl(VIDEO_URL)
    expect(normalizeInfo).toHaveBeenCalledWith(INFO, { input, limit: MAX_COLLECTION_ENTRIES })
    expect(log.info).toHaveBeenCalledOnce()
  })

  it('lists a playlist with the long timeout and returns the collection', async () => {
    vi.mocked(normalizeInfo).mockReturnValue({ kind: 'collection', collection: COLLECTION })
    const { resolve, run } = setup()

    await expect(resolve(PLAYLIST_URL)).resolves.toStrictEqual({
      kind: 'collection',
      collection: COLLECTION,
    })
    const [, argv, options] = run.mock.calls[0] ?? []
    expect(argv).toEqual(
      resolveArgs({ url: PLAYLIST_URL, limit: MAX_COLLECTION_ENTRIES, jsRuntime: NODE }),
    )
    expect(options?.timeoutMs).toBe(180_000)
  })

  it.each([
    ['empty input', '   ', 'empty'],
    ['text that is not a URL', 'hello world', 'not_a_url'],
    ['a non-http scheme', 'javascript:alert(1)', 'not_http'],
    [
      'embedded credentials',
      'https://dj:secret@www.youtube.com/watch?v=jNQXAC9IVRw',
      'credentials',
    ],
    [
      'a URL over the length cap',
      `https://www.youtube.com/watch?v=${'a'.repeat(2048)}`,
      'too_long',
    ],
  ] as const)(
    'refuses %s with invalid_url without starting yt-dlp',
    async (_label, url, reason) => {
      const { resolve, run } = setup()
      expect(await apiError(resolve(url))).toEqual({
        code: 'invalid_url',
        message: urlRejectionMessage(reason),
      })
      expect(run).not.toHaveBeenCalled()
    },
  )

  it.each([
    'https://music.apple.com/us/album/x/123',
    'https://tidal.com/browse/track/1',
    'https://www.deezer.com/track/1',
    'https://www.beatport.com/track/x/1',
  ])('refuses the DRM service %s with unsupported_url without starting yt-dlp', async (url) => {
    const { resolve, run } = setup()
    expect(await apiError(resolve(url))).toEqual({
      code: 'unsupported_url',
      message: OUT_OF_SCOPE_MESSAGE,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('answers engine_missing with the locate message when YTDLP_PATH points nowhere', async () => {
    const { resolve, run } = setup({ engine: { YTDLP_PATH: '/nonexistent/yt-dlp' } })
    expect(await apiError(resolve(VIDEO_URL))).toEqual({
      code: 'engine_missing',
      message: 'YTDLP_PATH: /nonexistent/yt-dlp does not exist.',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('answers engine_missing when yt-dlp is not on PATH', async () => {
    const { resolve } = setup({ engine: { PATH: '' } })
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'engine_missing' })
  })

  it('answers engine_missing when yt-dlp cannot start', async () => {
    const { resolve } = setup({
      run: async (bin) => {
        throw new SpawnError(bin, Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
      },
    })
    expect(await apiError(resolve(VIDEO_URL))).toEqual({
      code: 'engine_missing',
      message: "yt-dlp can't start (EACCES).",
    })
  })

  it('answers network when yt-dlp times out, naming the limit', async () => {
    const { resolve } = setup({ run: async () => result({ timedOut: true, exitCode: null }) })
    expect(await apiError(resolve(VIDEO_URL))).toEqual({
      code: 'network',
      message: "yt-dlp didn't answer within 60 s.",
    })
  })

  it('answers canceled when the run was aborted', async () => {
    const { resolve } = setup({
      run: async () => result({ aborted: true, exitCode: null, signal: 'SIGINT' }),
    })
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'canceled' })
  })

  it('answers canceled when the signal is already aborted', async () => {
    const { resolve } = setup({
      run: async (_bin, _argv, options = {}) => {
        options.signal?.throwIfAborted()
        return result()
      },
    })
    const signal = AbortSignal.abort('Client connection prematurely closed.')
    expect(await apiError(resolve(VIDEO_URL, 'auto', signal))).toMatchObject({ code: 'canceled' })
  })

  it('maps a failed run through mapYtdlpError', async () => {
    const stderr = 'ERROR: [youtube] jNQXAC9IVRw: Private video. Sign in if you have access\n'
    const { resolve } = setup({ run: async () => result({ exitCode: 1, stdout: '', stderr }) })
    expect(await apiError(resolve(VIDEO_URL))).toEqual({
      code: 'private',
      message: 'This video is private.',
    })
    expect(mapYtdlpError).toHaveBeenCalledWith({ stderr, exitCode: 1 })
  })

  it('maps a run killed by a signal it did not send, with a null exit code', async () => {
    const { resolve } = setup({
      run: async () => result({ exitCode: null, signal: 'SIGKILL', stdout: '' }),
    })
    await apiError(resolve(VIDEO_URL))
    expect(mapYtdlpError).toHaveBeenCalledWith({ stderr: '', exitCode: null })
  })

  it('answers unknown when the output went over the limit', async () => {
    const { resolve, log } = setup({ run: async () => result({ truncated: true }) })
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'unknown' })
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('answers unknown when stdout is not JSON, logging its size but not its content', async () => {
    const stdout = `{"webpage_url": "${SECRET_URL}", oops`
    const { resolve, log } = setup({ run: async () => result({ stdout }) })
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'unknown' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`${stdout.length} bytes`))
    expect(logged(log)).not.toContain('s-8Pjrp')
  })

  it('answers unknown when the parser rejects the JSON, and logs why', async () => {
    vi.mocked(normalizeInfo).mockImplementation(() => {
      throw new InfoParseError('no id')
    })
    const { resolve, log } = setup()
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'unknown' })
    expect(log.warn).toHaveBeenCalledWith('[resolve] youtube_video: no id')
  })

  it('lets a parser bug through as is, for the 500 handler', async () => {
    vi.mocked(normalizeInfo).mockImplementation(() => {
      throw new TypeError('cannot read properties of undefined')
    })
    const { resolve, log } = setup()
    await expect(resolve(VIDEO_URL)).rejects.toThrow(TypeError)
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^\[resolve\] youtube_video → unknown in /),
    )
  })

  it('answers unknown when the normalized result breaks the contract', async () => {
    vi.mocked(normalizeInfo).mockReturnValue({
      kind: 'track',
      track: { ...TRACK, url: 'javascript:alert(1)' },
    })
    const { resolve, log } = setup()
    expect(await apiError(resolve(VIDEO_URL))).toMatchObject({ code: 'unknown' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('track.url'))
  })

  it('returns the validated copy, without fields the contract does not know', async () => {
    vi.mocked(normalizeInfo).mockReturnValue({
      kind: 'track',
      track: { ...TRACK, formats: [] } as Track,
    })
    const { resolve } = setup()
    await expect(resolve(VIDEO_URL)).resolves.toStrictEqual({ kind: 'track', track: TRACK })
  })

  describe('watch?v=…&list=…', () => {
    it('looks up only the track in auto mode and offers the list as ambiguous', async () => {
      const { resolve, run } = setup()
      await expect(resolve(WATCH_LIST_URL)).resolves.toStrictEqual({
        kind: 'ambiguous',
        track: TRACK,
        collectionUrl: PLAYLIST_URL,
        collectionKind: 'playlist',
      })
      const [, argv, options] = run.mock.calls[0] ?? []
      expect(argv).toContain('--no-playlist')
      expect(argv?.at(-1)).toBe(WATCH_LIST_URL)
      expect(options?.timeoutMs).toBe(60_000)
    })

    it('answers unknown if the track lookup comes back as a list', async () => {
      vi.mocked(normalizeInfo).mockReturnValue({ kind: 'collection', collection: COLLECTION })
      const { resolve } = setup()
      expect(await apiError(resolve(WATCH_LIST_URL))).toMatchObject({ code: 'unknown' })
    })

    it('returns just the track in track mode', async () => {
      const { resolve } = setup()
      await expect(resolve(WATCH_LIST_URL, 'track')).resolves.toStrictEqual({
        kind: 'track',
        track: TRACK,
      })
    })

    it('lists the playlist URL in collection mode', async () => {
      vi.mocked(normalizeInfo).mockReturnValue({ kind: 'collection', collection: COLLECTION })
      const { resolve, run } = setup()
      await resolve(WATCH_LIST_URL, 'collection')
      const [, argv] = run.mock.calls[0] ?? []
      expect(argv).toEqual(
        resolveArgs({
          url: PLAYLIST_URL,
          playlist: 'yes',
          limit: MAX_COLLECTION_ENTRIES,
          jsRuntime: NODE,
        }),
      )
    })
  })

  describe('concurrency', () => {
    it('runs at most maxConcurrent yt-dlp processes and starts the next when one ends', async () => {
      const gates = [deferred<RunResult>(), deferred<RunResult>(), deferred<RunResult>()]
      let calls = 0
      const { resolve, run } = setup({
        maxConcurrent: 2,
        run: () => gates[calls++]?.promise ?? Promise.reject(new Error('too many runs')),
      })
      const pending = [resolve(VIDEO_URL), resolve(VIDEO_URL), resolve(VIDEO_URL)]
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      await settle()
      expect(run).toHaveBeenCalledTimes(2)

      gates[0]?.resolve(result())
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))

      gates[1]?.resolve(result())
      gates[2]?.resolve(result())
      await expect(Promise.all(pending)).resolves.toHaveLength(3)
    })

    it('drops a waiting request whose client gave up, without starting yt-dlp for it', async () => {
      const gate = deferred<RunResult>()
      const { resolve, run } = setup({ maxConcurrent: 1, run: () => gate.promise })
      const first = resolve(VIDEO_URL)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const controller = new AbortController()
      const second = resolve(VIDEO_URL, 'auto', controller.signal)
      await settle()
      controller.abort('Client connection prematurely closed.')

      expect(await apiError(second)).toMatchObject({ code: 'canceled' })
      gate.resolve(result())
      await first
      expect(run).toHaveBeenCalledOnce()
    })
  })

  describe('logging', () => {
    it('writes one line with the URL kind, outcome and duration, never the URL', async () => {
      const { resolve, log } = setup()
      await resolve(SECRET_URL)
      expect(log.info).toHaveBeenCalledOnce()
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(/^\[resolve\] soundcloud_track → track in \d+\.\d s$/),
      )
      expect(logged(log)).not.toContain('s-8Pjrp')
      expect(logged(log)).not.toContain('--ignore-config')
    })

    it('counts entries, partial rows and truncation for a collection', async () => {
      vi.mocked(normalizeInfo).mockReturnValue({
        kind: 'collection',
        collection: {
          ...COLLECTION,
          truncated: true,
          entries: [
            { ...TRACK, partial: false },
            {
              id: '2',
              platform: 'youtube',
              url: VIDEO_URL,
              availability: 'unknown',
              partial: true,
            },
          ],
        },
      })
      const { resolve, log } = setup()
      await resolve(PLAYLIST_URL)
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[resolve\] youtube_playlist → playlist of 2, 1 partial, truncated in /,
        ),
      )
    })

    it('logs the error code for a failure', async () => {
      const { resolve, log } = setup({ run: async () => result({ exitCode: 1 }) })
      await apiError(resolve(VIDEO_URL))
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(/^\[resolve\] youtube_video → private in /),
      )
    })

    it.each([
      ['nope', 'invalid → invalid_url'],
      ['https://music.apple.com/us/album/x/123', 'out_of_scope → unsupported_url'],
      ['https://open.spotify.com/track/1', 'spotify_other → unsupported_url'],
    ])('logs the refused URL %s without its text', async (url, outcome) => {
      const { resolve, log } = setup()
      await apiError(resolve(url))
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(`^\\[resolve\\] ${outcome} in `))
      expect(logged(log)).not.toContain(url)
    })
  })
})

describe('resolver.resolve: Spotify links (ADR-026)', () => {
  const TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC'
  const SPOTIFY_TRACK_URL = `https://open.spotify.com/track/${TRACK_ID}`
  const SPOTIFY_ALBUM_URL = 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4'
  const SPOTIFY_PLAYLIST_URL = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'
  const COVER = 'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673'

  const TRACK_ENTITY: SpotifyEntity = {
    type: 'track',
    track: {
      id: TRACK_ID,
      title: 'Never Gonna Give You Up',
      artists: ['Rick Astley'],
      durationSec: 213.573,
      releaseYear: 1987,
      coverUrl: COVER,
    },
  }
  const list = (type: 'album' | 'playlist', id: string): SpotifyEntity => ({
    type,
    id,
    title: type === 'album' ? 'Whenever You Need Somebody' : 'Today’s Top Hits',
    owner: type === 'album' ? 'Rick Astley' : 'Spotify',
    coverUrl: COVER,
    rows: [
      {
        id: TRACK_ID,
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
        durationSec: 213.573,
      },
      { id: '6aiKIFjPwa3UvDCD5ecoJj', title: 'Whenever You Need Somebody', artist: 'Rick Astley' },
    ],
    skipped: 0,
    listed: 2,
  })
  const ALBUM_ENTITY = list('album', '6N9PS4QXF1D0OWPk0Sxtb4')
  const PLAYLIST_ENTITY = list('playlist', '37i9dQZF1DXcBWIGoYBM5M')

  /** A client that answers `answer` (or throws it), and never fetches covers here. */
  function fakeSpotify(answer: SpotifyEntity | Error | (() => Promise<SpotifyEntity>)) {
    const entity = vi.fn<SpotifyClient['entity']>(async () => {
      if (typeof answer === 'function') return answer()
      if (answer instanceof Error) throw answer
      return answer
    })
    const cover = vi.fn<SpotifyClient['cover']>(async () => undefined)
    return { entity, cover }
  }

  it.each([
    [SPOTIFY_TRACK_URL, TRACK_ENTITY, 'spotify_track → track'],
    [SPOTIFY_ALBUM_URL, ALBUM_ENTITY, 'spotify_album → album of 2'],
    [SPOTIFY_PLAYLIST_URL, PLAYLIST_ENTITY, 'spotify_playlist → playlist of 2'],
  ] as const)('reads %s from Spotify, never through yt-dlp', async (url, entity, outcome) => {
    const spotify = fakeSpotify(entity)
    const { resolve, run, log } = setup({ spotify })
    const controller = new AbortController()
    await expect(resolve(url, 'auto', controller.signal)).resolves.toStrictEqual(
      toResolveResult(entity),
    )
    expect(run).not.toHaveBeenCalled()
    expect(spotify.entity).toHaveBeenCalledExactlyOnceWith(classifyUrl(url), controller.signal)
    expect(spotify.cover).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(new RegExp(`^\\[resolve\\] ${outcome} in \\d+\\.\\d s$`)),
    )
    expect(logged(log)).not.toContain('open.spotify.com')
    expect(logged(log)).not.toContain('Never Gonna')
  })

  it('asks Spotify for the canonical link, not the pasted one with its share token', async () => {
    const spotify = fakeSpotify(TRACK_ENTITY)
    const { resolve } = setup({ spotify })
    await resolve(`open.spotify.com/intl-de/track/${TRACK_ID}?si=abc123`)
    expect(spotify.entity.mock.calls[0]?.[0]).toMatchObject({
      url: SPOTIFY_TRACK_URL,
      kind: 'spotify_track',
      spotifyId: TRACK_ID,
    })
  })

  it.each(['auto', 'track', 'collection'] as const)(
    'reads a playlist the same way in %s mode: a Spotify link is never ambiguous',
    async (mode) => {
      const { resolve } = setup({ spotify: fakeSpotify(PLAYLIST_ENTITY) })
      await expect(resolve(SPOTIFY_PLAYLIST_URL, mode)).resolves.toMatchObject({
        kind: 'collection',
      })
    },
  )

  it.each([
    [SPOTIFY_TRACK_URL, ALBUM_ENTITY, 'album'],
    [SPOTIFY_ALBUM_URL, TRACK_ENTITY, 'track'],
    [SPOTIFY_PLAYLIST_URL, ALBUM_ENTITY, 'album'],
    [SPOTIFY_ALBUM_URL, PLAYLIST_ENTITY, 'playlist'],
  ] as const)(
    'answers unknown when %s comes back as a %s, and logs only the types',
    async (url, entity, type) => {
      const { resolve, log } = setup({ spotify: fakeSpotify(entity) })
      expect(await apiError(resolve(url))).toEqual({
        code: 'unknown',
        message: "Spotify's page has changed, and DJ Scraper can't read it.",
      })
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^\\[resolve\\] spotify_\\w+: Spotify answered with a ${type}$`),
        ),
      )
      expect(logged(log)).not.toContain('open.spotify.com')
    },
  )

  it.each([
    [SPOTIFY_NOT_FOUND, 'HTTP 404'],
    [SPOTIFY_RATE_LIMITED, 'HTTP 429'],
    [SPOTIFY_UNREACHABLE, 'TypeError'],
    [{ code: 'network', message: 'Spotify answered with an error (HTTP 503).' }, 'HTTP 503'],
  ] as const)('passes on the client failure %j, logging no warning', async (info, detail) => {
    const { resolve, run, log } = setup({ spotify: fakeSpotify(new SpotifyError(info, detail)) })
    expect(await apiError(resolve(SPOTIFY_TRACK_URL))).toEqual(info)
    expect(run).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(`^\\[resolve\\] spotify_track → ${info.code} in `),
    )
  })

  it('answers unknown for a page it cannot read, logging the parser’s detail', async () => {
    const error = new SpotifyError(SPOTIFY_UNREADABLE, 'the page has no __NEXT_DATA__ script')
    const { resolve, log } = setup({ spotify: fakeSpotify(error) })
    expect(await apiError(resolve(SPOTIFY_ALBUM_URL))).toEqual(SPOTIFY_UNREADABLE)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[resolve] spotify_album: the page has no __NEXT_DATA__ script',
    )
  })

  it('answers unknown when the page’s entity breaks the contract, and logs no names', async () => {
    const broken: SpotifyEntity = {
      ...TRACK_ENTITY,
      track: { ...TRACK_ENTITY.track, coverUrl: 'javascript:alert(1)' },
    }
    const { resolve, log } = setup({ spotify: fakeSpotify(broken) })
    expect(await apiError(resolve(SPOTIFY_TRACK_URL))).toMatchObject({ code: 'unknown' })
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "[resolve] spotify_track: the track doesn't fit the contract",
    )
    expect(logged(log)).not.toContain('Never Gonna')
    expect(logged(log)).not.toContain('javascript:')
  })

  it('answers unknown when a list breaks the contract, naming only its kind', async () => {
    if (ALBUM_ENTITY.type === 'track') throw new Error('a list')
    const broken: SpotifyEntity = { ...ALBUM_ENTITY, coverUrl: 'ftp://example.com/cover.jpg' }
    const { resolve, log } = setup({ spotify: fakeSpotify(broken) })
    expect(await apiError(resolve(SPOTIFY_ALBUM_URL))).toEqual(SPOTIFY_UNREADABLE)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "[resolve] spotify_album: the album doesn't fit the contract",
    )
  })

  it('leaves out a row the contract refuses, counting it as skipped', async () => {
    if (PLAYLIST_ENTITY.type === 'track') throw new Error('a list')
    const odd: SpotifyEntity = {
      ...PLAYLIST_ENTITY,
      rows: [
        ...PLAYLIST_ENTITY.rows,
        { id: '0000000000000000000009', title: 'Odd', durationSec: -1 },
      ],
      listed: 3,
    }
    const { resolve } = setup({ spotify: fakeSpotify(odd) })
    const result = await resolve(SPOTIFY_PLAYLIST_URL)
    if (result.kind !== 'collection') throw new Error(`resolved ${result.kind}`)
    expect(result.collection.entries.map((entry) => entry.id)).toEqual(
      PLAYLIST_ENTITY.rows.map((row) => row.id),
    )
    expect(result.collection.skippedEntries).toBe(1)
  })

  it('lets a client bug through as is, for the 500 handler', async () => {
    const bug = new TypeError('a bug')
    const { resolve } = setup({ spotify: fakeSpotify(bug) })
    await expect(resolve(SPOTIFY_TRACK_URL)).rejects.toBe(bug)
  })

  it('answers canceled when the client was aborted', async () => {
    const controller = new AbortController()
    const spotify = fakeSpotify(async () => {
      controller.abort()
      throw new SpotifyError(CANCELED, 'aborted')
    })
    const { resolve } = setup({ spotify })
    expect(await apiError(resolve(SPOTIFY_TRACK_URL, 'auto', controller.signal))).toEqual(CANCELED)
  })

  it('waits for a slot like a yt-dlp lookup, and drops the read when its client gave up', async () => {
    const running = deferred<RunResult>()
    const spotify = fakeSpotify(TRACK_ENTITY)
    const { resolve } = setup({ maxConcurrent: 1, run: () => running.promise, spotify })
    const lookup = resolve(VIDEO_URL)
    await settle()
    const controller = new AbortController()
    const waiting = resolve(SPOTIFY_TRACK_URL, 'auto', controller.signal)
    await settle()
    expect(spotify.entity).not.toHaveBeenCalled()
    controller.abort()
    expect(await apiError(waiting)).toEqual(CANCELED)
    running.resolve(result())
    await lookup
    expect(spotify.entity).not.toHaveBeenCalled()
  })

  it('refuses a Spotify link with unsupported_url when it has no Spotify client', async () => {
    const { resolve, run } = setup()
    expect(await apiError(resolve(SPOTIFY_TRACK_URL))).toEqual({
      code: 'unsupported_url',
      message: "This server can't read Spotify links.",
    })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt',
    'https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ',
    'https://spotify.link/abc123',
    'https://open.spotify.com/track/tooShort',
  ])('refuses the Spotify page %s with unsupported_url without asking Spotify', async (url) => {
    const spotify = fakeSpotify(TRACK_ENTITY)
    const { resolve, run } = setup({ spotify })
    expect(await apiError(resolve(url))).toEqual({
      code: 'unsupported_url',
      message: SPOTIFY_OTHER_MESSAGE,
    })
    expect(spotify.entity).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
