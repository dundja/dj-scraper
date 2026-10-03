import {
  CancelJobsRequestSchema,
  ClearJobsRequestSchema,
  type Collection,
  type DownloadRequest,
  DownloadRequestSchema,
  type EntryResult,
  FolderPickRequestSchema,
  type ResolveEntriesRequest,
  ResolveEntriesRequestSchema,
  type ResolveEntriesResponse,
  ResolveRequestSchema,
  type ResolveResult,
  RetryJobsRequestSchema,
  SettingsUpdateSchema,
  type Track,
} from '@dj-scraper/shared'
import { soundcloudRowRef, testUuid, youtubeRef } from '@dj-scraper/shared/test-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { doneJob, failedJob, jobWith, queuedJob, settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, networkError, noAnswer, text } from '@/test/fake-api.ts'
import { healthWith, healthy } from '@/test/health.ts'
import { ApiError, api } from './api.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

/** The rejection of `promise`; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the request to fail, but it succeeded')
}

describe('api.health', () => {
  it('asks the same-origin GET /api/health for JSON, with no Content-Type and no body', async () => {
    server.on('GET /api/health', () => json(healthy))

    await api.health()

    const [call] = server.callsTo('GET /api/health')
    expect(call?.url).toBe('/api/health')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.headers.has('Content-Type')).toBe(false)
    expect(call?.body).toBeUndefined()
  })

  it('returns the health check when the body matches the contract', async () => {
    server.on('GET /api/health', () => json(healthy))

    await expect(api.health()).resolves.toEqual(healthy)
  })

  it('passes the AbortSignal through to fetch', async () => {
    server.on('GET /api/health', () => json(healthy))
    const controller = new AbortController()

    await api.health(controller.signal)

    expect(server.callsTo('GET /api/health')[0]?.signal).toBe(controller.signal)
  })
})

describe('api.recheckHealth', () => {
  it('posts to /api/health/recheck with Content-Type: application/json even though it has no body', async () => {
    const rechecked = healthWith({ checkedAt: '2026-10-02T08:05:00.000Z' })
    server.on('POST /api/health/recheck', () => json(rechecked))

    await expect(api.recheckHealth()).resolves.toEqual(rechecked)

    const [call] = server.callsTo('POST /api/health/recheck')
    expect(call?.url).toBe('/api/health/recheck')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBeUndefined()
  })
})

describe('API failures', () => {
  it.each([
    {
      name: 'a refused Host',
      call: () => api.health(),
      route: 'GET /api/health',
      status: 403,
      code: 'forbidden',
      message: 'Host not allowed',
    },
    {
      name: 'a mutation without a JSON Content-Type',
      call: () => api.recheckHealth(),
      route: 'POST /api/health/recheck',
      status: 415,
      code: 'invalid_request',
      message: 'Content-Type must be application/json',
    },
  ] as const)(
    'reports $name as an api error with the status, code and message from the server',
    async ({ call, route, status, code, message }) => {
      server.on(route, () => json({ error: { code, message } }, status))

      const error = await rejection(call())

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ kind: 'api', status, code, message })
    },
  )

  it('reports a success whose body breaks the contract as an invalid response', async () => {
    const { ffprobe: _, ...withoutFfprobe } = healthy
    server.on('GET /api/health', () => json(withoutFfprobe))

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'invalid_response',
      status: 200,
      code: undefined,
      message: 'Unexpected response from GET /api/health.',
    })
  })

  it('reports a success that is not JSON at all as an invalid response', async () => {
    server.on('GET /api/health', () =>
      text('<!doctype html><title>DJ Scraper</title>', 200, 'text/html'),
    )

    const error = await rejection(api.health())

    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 })
  })

  it.each([
    { name: 'the Vite proxy while the server is down (502, empty text/plain)', status: 502 },
    { name: 'an empty 500 text/plain reply', status: 500 },
  ])('reports $name as unreachable', async ({ status }) => {
    server.on('GET /api/health', () => text('', status))

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'unreachable',
      status,
      code: undefined,
      message: "Can't reach the DJ Scraper server.",
    })
  })

  it.each([
    { name: 'a text page from another app on the port', reply: () => text('404 Not Found', 404) },
    {
      name: 'JSON outside the error contract',
      reply: () => json({ error: 'Internal Server Error' }, 500),
    },
  ])('reports $name as unreachable, not as an api error', async ({ reply }) => {
    server.on('GET /api/health', reply)

    const error = await rejection(api.health())

    expect(error).toMatchObject({ kind: 'unreachable', code: undefined })
  })

  it('reports a network failure as unreachable and keeps the cause', async () => {
    server.on('GET /api/health', networkError)

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'unreachable',
      status: undefined,
      cause: expect.any(TypeError),
    })
  })

  it('rejects with the abort itself, not an ApiError, when the request is aborted', async () => {
    server.on('GET /api/health', noAnswer)
    const controller = new AbortController()

    const request = api.health(controller.signal)
    controller.abort()
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(controller.signal.reason)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('reports a connection dropped while the body is still arriving as unreachable', async () => {
    server.on('GET /api/health', () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"ok":'))
          stream.error(new TypeError('network error'))
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const error = await rejection(api.health())

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'unreachable', cause: expect.any(TypeError) })
  })

  it('rejects with the abort when it happens while the body is still arriving', async () => {
    const controller = new AbortController()
    const bodyRead = Promise.withResolvers<void>()
    server.on('GET /api/health', ({ signal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"ok":'))
          signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true })
        },
        // Called once the reader has taken the first chunk, i.e. response.text() is running.
        pull() {
          bodyRead.resolve()
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const request = api.health(controller.signal)
    await bodyRead.promise
    controller.abort()
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(controller.signal.reason)
  })
})

// Contract-shaped resolve bodies: the YouTube track mirrors fixtures/youtube/mix-track.json; the
// SoundCloud rows are synthetic.

const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const mixUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'

const youtubeTrack = {
  id: 'dQw4w9WgXcQ',
  platform: 'youtube',
  url: videoUrl,
  title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
  artist: 'Rick Astley',
  uploader: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  availability: 'available',
  source: { codec: 'mp4a.40.2', bitrateKbps: 129.502 },
} satisfies Track

const enrichedTrack = {
  id: '1234567893',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/warehouse-dub',
  title: 'Some Artist - Warehouse Dub',
  artist: 'Some Artist',
  uploader: 'Some Artist',
  durationSec: 212.53,
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000987654322-abcdef-t500x500.jpg',
  availability: 'available',
  source: { codec: 'mp3', bitrateKbps: 128 },
} satisfies Track

/** A SoundCloud set whose second row is bare (id + API url) until it is enriched. */
const soundcloudSet = {
  id: '1876543210',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/some-artist/sets/summer-2026',
  kind: 'set',
  title: 'Summer 2026',
  owner: 'Some Artist',
  trackCount: 2,
  durationSec: 425.06,
  truncated: false,
  entries: [
    {
      id: '1234567890',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/some-artist/deep-house-edit',
      title: 'Some Artist - Deep House Edit',
      durationSec: 212.53,
      availability: 'available',
      partial: false,
    },
    {
      id: '1234567893',
      platform: 'soundcloud',
      url: 'https://api-v2.soundcloud.com/tracks/1234567893',
      availability: 'unknown',
      partial: true,
    },
  ],
} satisfies Collection

const trackResult = { kind: 'track', track: youtubeTrack } satisfies ResolveResult
const collectionResult = { kind: 'collection', collection: soundcloudSet } satisfies ResolveResult
const ambiguousResult = {
  kind: 'ambiguous',
  track: youtubeTrack,
  collectionUrl: mixUrl,
  collectionKind: 'mix',
} satisfies ResolveResult

/** The bare rows in view: one the platform still has, one it deleted. */
const entriesRequest = {
  entries: [
    {
      platform: 'soundcloud',
      id: '1234567893',
      url: 'https://api-v2.soundcloud.com/tracks/1234567893',
    },
    {
      platform: 'soundcloud',
      id: '1234567894',
      url: 'https://api-v2.soundcloud.com/tracks/1234567894',
    },
  ],
} satisfies ResolveEntriesRequest

const enrichedRow = {
  status: 'ok',
  platform: 'soundcloud',
  id: '1234567893',
  track: enrichedTrack,
} satisfies EntryResult

const failedRow = {
  status: 'error',
  platform: 'soundcloud',
  id: '1234567894',
  error: { code: 'unavailable', message: 'Not found: deleted, private, or a wrong link.' },
} satisfies EntryResult

const entriesResponse = {
  results: [enrichedRow, failedRow],
} satisfies ResolveEntriesResponse

describe('api.resolve', () => {
  it('posts the request as its exact JSON body to the same-origin /api/resolve, asking for JSON', async () => {
    server.on('POST /api/resolve', () => json(collectionResult))
    const request = { url: mixUrl, mode: 'collection' } as const

    await api.resolve(request)

    const [call] = server.callsTo('POST /api/resolve')
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('/api/resolve')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBe(JSON.stringify(request))
  })

  it("sends a body the server's ResolveRequestSchema reads back as the same request", async () => {
    server.on('POST /api/resolve', () => json(trackResult))
    const request = { url: videoUrl, mode: 'track' } as const

    await api.resolve(request)

    const sent = ResolveRequestSchema.safeParse(jsonBody(server.callsTo('POST /api/resolve')[0]))
    expect(sent.success).toBe(true)
    expect(sent.data).toEqual(request)
  })

  it('leaves mode out of the body when the caller does, so the server defaults it to auto', async () => {
    server.on('POST /api/resolve', () => json(ambiguousResult))

    await api.resolve({ url: mixUrl })

    const sent = jsonBody(server.callsTo('POST /api/resolve')[0])
    expect(sent).not.toHaveProperty('mode')
    expect(ResolveRequestSchema.parse(sent)).toEqual({ url: mixUrl, mode: 'auto' })
  })

  it.each([
    { name: 'a track', result: trackResult },
    { name: 'a collection with a partial row', result: collectionResult },
    { name: 'an ambiguous watch-list link with the kind of its list', result: ambiguousResult },
  ])('returns $name when the body matches the contract', async ({ result }) => {
    server.on('POST /api/resolve', () => json(result))

    await expect(api.resolve({ url: mixUrl })).resolves.toEqual(result)
  })

  it("rejects with the signal's reason, not an ApiError, when the resolve is aborted", async () => {
    server.on('POST /api/resolve', noAnswer)
    const controller = new AbortController()
    const reason = new DOMException('A new link was pasted', 'AbortError')

    const request = api.resolve({ url: videoUrl }, controller.signal)
    controller.abort(reason)
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(reason)
  })
})

describe('api.resolveEntries', () => {
  it('posts the rows as their exact JSON body to the same-origin /api/resolve/entries, asking for JSON', async () => {
    server.on('POST /api/resolve/entries', () => json(entriesResponse))

    await api.resolveEntries(entriesRequest)

    const [call] = server.callsTo('POST /api/resolve/entries')
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('/api/resolve/entries')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBe(JSON.stringify(entriesRequest))
  })

  it("sends a body the server's ResolveEntriesRequestSchema reads back as the same rows", async () => {
    server.on('POST /api/resolve/entries', () => json(entriesResponse))

    await api.resolveEntries(entriesRequest)

    const sent = ResolveEntriesRequestSchema.safeParse(
      jsonBody(server.callsTo('POST /api/resolve/entries')[0]),
    )
    expect(sent.success).toBe(true)
    expect(sent.data).toEqual(entriesRequest)
  })

  it('returns a full track for a row that resolved and the error for a row that failed', async () => {
    server.on('POST /api/resolve/entries', () => json(entriesResponse))

    await expect(api.resolveEntries(entriesRequest)).resolves.toEqual(entriesResponse)
  })

  it("rejects with the signal's reason, not an ApiError, when the enrichment is aborted", async () => {
    server.on('POST /api/resolve/entries', noAnswer)
    const controller = new AbortController()
    const reason = new DOMException('The rows scrolled out of view', 'AbortError')

    const request = api.resolveEntries(entriesRequest, controller.signal)
    controller.abort(reason)
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(reason)
  })
})

describe('resolve failures', () => {
  it.each([
    {
      name: 'a link the server refuses as invalid',
      call: () => api.resolve({ url: 'not a link' }),
      route: 'POST /api/resolve',
      status: 400,
      code: 'invalid_url',
      message: "That doesn't look like a link.",
    },
    {
      name: 'a DRM service',
      call: () => api.resolve({ url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT' }),
      route: 'POST /api/resolve',
      status: 422,
      code: 'unsupported_url',
      message:
        "DJ Scraper doesn't download from Spotify, Apple Music, Amazon Music, Tidal, Deezer or Beatport: their streams are DRM-protected.",
    },
    {
      name: 'a missing yt-dlp on resolve',
      call: () => api.resolve({ url: videoUrl }),
      route: 'POST /api/resolve',
      status: 503,
      code: 'engine_missing',
      message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
    },
    {
      name: 'a missing yt-dlp on enrichment',
      call: () => api.resolveEntries(entriesRequest),
      route: 'POST /api/resolve/entries',
      status: 503,
      code: 'engine_missing',
      message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
    },
  ] as const)(
    'reports $name as an api error with the status, code and message from the server',
    async ({ call, route, status, code, message }) => {
      server.on(route, () => json({ error: { code, message } }, status))

      const error = await rejection(call())

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ kind: 'api', status, code, message })
    },
  )

  const { truncated: _, ...setWithoutTruncated } = soundcloudSet
  const { track: __, ...rowWithoutTrack } = enrichedRow

  it.each([
    {
      name: 'a collection without truncated',
      call: () => api.resolve({ url: soundcloudSet.url }),
      route: 'POST /api/resolve',
      body: { kind: 'collection', collection: setWithoutTruncated },
    },
    {
      name: 'an ok row without its track',
      call: () => api.resolveEntries(entriesRequest),
      route: 'POST /api/resolve/entries',
      body: { results: [rowWithoutTrack, failedRow] },
    },
  ] as const)(
    'reports a success with $name as an invalid response',
    async ({ call, route, body }) => {
      server.on(route, () => json(body))

      const error = await rejection(call())

      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({
        kind: 'invalid_response',
        status: 200,
        code: undefined,
        message: `Unexpected response from ${route}.`,
      })
    },
  )
})

// Downloads, settings and the folder picker: request shapes the shared schemas read back, and the
// answers validated on the way in.

const downloadRequest = {
  items: [youtubeRef, soundcloudRowRef],
  folder: '/Users/dj/Music/DJ Scraper',
  options: {
    format: 'mp3',
    filenameTemplate: '{artist} - {title}',
    embedArtwork: true,
    sourceUrlComment: true,
    subfolder: 'Summer 2026',
  },
  label: 'Summer 2026',
} satisfies DownloadRequest

const created = { batchId: testUuid(100), jobIds: [testUuid(1), testUuid(4)], duplicates: 0 }

describe('api.createDownloads', () => {
  it('posts the request as its exact JSON body to /api/downloads, which the server reads back as the same request', async () => {
    server.on('POST /api/downloads', () => json(created))

    await expect(api.createDownloads(downloadRequest)).resolves.toEqual(created)

    const [call] = server.callsTo('POST /api/downloads')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBe(JSON.stringify(downloadRequest))
    expect(DownloadRequestSchema.parse(jsonBody(call))).toEqual(downloadRequest)
  })

  it('returns a response without a batch when every item was a duplicate', async () => {
    const allDuplicates = { jobIds: [testUuid(1), testUuid(1)], duplicates: 2 }
    server.on('POST /api/downloads', () => json(allDuplicates))

    await expect(api.createDownloads(downloadRequest)).resolves.toEqual(allDuplicates)
  })

  it.each([
    {
      status: 422,
      code: 'folder_unavailable',
      message: 'The folder /Volumes/USB is not there any more. Plug the drive in or pick another.',
    },
    {
      status: 503,
      code: 'engine_missing',
      message: 'ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
    },
  ] as const)('reports $code ($status) as an api error', async ({ status, code, message }) => {
    server.on('POST /api/downloads', () => json({ error: { code, message } }, status))

    const error = await rejection(api.createDownloads(downloadRequest))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'api', status, code, message })
  })

  it('reports job ids that are not UUIDs as an invalid response', async () => {
    server.on('POST /api/downloads', () => json({ ...created, jobIds: ['job-1'] }))

    const error = await rejection(api.createDownloads(downloadRequest))

    expect(error).toMatchObject({
      kind: 'invalid_response',
      status: 200,
      message: 'Unexpected response from POST /api/downloads.',
    })
  })
})

describe.each([
  {
    name: 'api.cancelDownload',
    action: 'cancel',
    call: api.cancelDownload,
    answer: jobWith({ ...queuedJob, status: 'downloading', cancelRequested: true }),
  },
  {
    name: 'api.retryDownload',
    action: 'retry',
    call: api.retryDownload,
    answer: jobWith({ id: failedJob.id, status: 'queued', attempt: 3 }),
  },
] as const)('$name', ({ action, call, answer }) => {
  const route = `POST /api/downloads/${queuedJob.id}/${action}` as const

  it(`posts to /api/downloads/<id>/${action} with Content-Type: application/json and no body, and returns the job`, async () => {
    server.on(route, () => json(answer))

    await expect(call(queuedJob.id)).resolves.toEqual(answer)

    const [sent] = server.callsTo(route)
    expect(sent?.headers.get('Content-Type')).toBe('application/json')
    expect(sent?.body).toBeUndefined()
  })

  it('keeps the id to one path segment', async () => {
    server.on(`POST /api/downloads/..%2Fsettings/${action}`, () =>
      json({ error: { code: 'not_found', message: 'No such download.' } }, 404),
    )

    const error = await rejection(call('../settings'))

    expect(error).toMatchObject({ kind: 'api', status: 404, code: 'not_found' })
  })

  it('reports a body that is not a job as an invalid response', async () => {
    server.on(route, () => json({ ...answer, status: 'paused' }))

    const error = await rejection(call(queuedJob.id))

    expect(error).toMatchObject({
      kind: 'invalid_response',
      message: `Unexpected response from ${route}.`,
    })
  })
})

describe('api.retryDownload failures', () => {
  it('reports retrying a finished job as the server says it (409 invalid_request)', async () => {
    const message = 'Only failed or canceled downloads can be retried.'
    server.on(`POST /api/downloads/${doneJob.id}/retry`, () =>
      json({ error: { code: 'invalid_request', message } }, 409),
    )

    const error = await rejection(api.retryDownload(doneJob.id))

    expect(error).toMatchObject({ kind: 'api', status: 409, code: 'invalid_request', message })
  })
})

describe('api.revealDownload', () => {
  const route = `POST /api/downloads/${doneJob.id}/reveal` as const

  it('posts to /api/downloads/<id>/reveal and resolves on 204 No Content', async () => {
    server.on(route, () => new Response(null, { status: 204 }))

    await expect(api.revealDownload(doneJob.id)).resolves.toBeUndefined()

    const [call] = server.callsTo(route)
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.headers.get('Accept')).toBe('application/json')
    expect(call?.body).toBeUndefined()
  })

  it('reports a file that is gone as an api error (404 not_found)', async () => {
    const message = 'The file is not there any more.'
    server.on(route, () => json({ error: { code: 'not_found', message } }, 404))

    const error = await rejection(api.revealDownload(doneJob.id))

    expect(error).toMatchObject({ kind: 'api', status: 404, code: 'not_found', message })
  })

  it.each([
    { name: 'a 200 with a JSON body', reply: () => json(doneJob) },
    { name: 'an empty 200', reply: () => text('', 200) },
  ])('reports $name as an invalid response: the contract is 204', async ({ reply }) => {
    server.on(route, reply)

    const error = await rejection(api.revealDownload(doneJob.id))

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      kind: 'invalid_response',
      status: 200,
      message: `Unexpected response from ${route}.`,
    })
  })

  it('reports the Vite proxy while the server is down (502) as unreachable', async () => {
    server.on(route, () => text('', 502))

    const error = await rejection(api.revealDownload(doneJob.id))

    expect(error).toMatchObject({ kind: 'unreachable', status: 502 })
  })

  it("rejects with the signal's reason, not an ApiError, when aborted", async () => {
    server.on(route, noAnswer)
    const controller = new AbortController()

    const request = api.revealDownload(doneJob.id, controller.signal)
    controller.abort()
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(controller.signal.reason)
  })
})

describe('bulk job actions', () => {
  it.each([
    {
      route: 'POST /api/downloads/cancel',
      call: () => api.cancelDownloads({ target: { scope: 'batch', batchId: testUuid(100) } }),
      body: { target: { scope: 'batch', batchId: testUuid(100) } },
      schema: CancelJobsRequestSchema,
    },
    {
      route: 'POST /api/downloads/retry',
      call: () =>
        api.retryDownloads({
          target: { scope: 'jobs', ids: [testUuid(6), testUuid(7)] },
          statuses: ['failed', 'canceled'],
        }),
      body: {
        target: { scope: 'jobs', ids: [testUuid(6), testUuid(7)] },
        statuses: ['failed', 'canceled'],
      },
      schema: RetryJobsRequestSchema,
    },
    {
      route: 'POST /api/downloads/clear',
      call: () => api.clearDownloads({ target: { scope: 'all' } }),
      body: { target: { scope: 'all' } },
      schema: ClearJobsRequestSchema,
    },
  ] as const)(
    '$route posts its scope as the exact JSON body and returns the count',
    async ({ route, call, body, schema }) => {
      server.on(route, () => json({ count: 2 }))

      await expect(call()).resolves.toEqual({ count: 2 })

      const [sent] = server.callsTo(route)
      expect(sent?.headers.get('Content-Type')).toBe('application/json')
      expect(sent?.body).toBe(JSON.stringify(body))
      expect(schema.parse(jsonBody(sent))).toEqual(body)
    },
  )

  it('leaves statuses out of a retry when the caller does, so the server retries failed jobs', async () => {
    server.on('POST /api/downloads/retry', () => json({ count: 1 }))

    await api.retryDownloads({ target: { scope: 'all' } })

    const sent = jsonBody(server.callsTo('POST /api/downloads/retry')[0])
    expect(sent).toEqual({ target: { scope: 'all' } })
    expect(RetryJobsRequestSchema.parse(sent)).toEqual({
      target: { scope: 'all' },
      statuses: ['failed'],
    })
  })

  it('reports a count that is not a whole number as an invalid response', async () => {
    server.on('POST /api/downloads/clear', () => json({ count: -1 }))

    const error = await rejection(api.clearDownloads({ target: { scope: 'all' } }))

    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 })
  })
})

describe('api.getSettings and api.updateSettings', () => {
  it('reads GET /api/settings without a body', async () => {
    server.on('GET /api/settings', () => json(settings))

    await expect(api.getSettings()).resolves.toEqual(settings)

    const [call] = server.callsTo('GET /api/settings')
    expect(call?.headers.has('Content-Type')).toBe(false)
    expect(call?.body).toBeUndefined()
  })

  it('PUTs only the changed fields and returns the settings as saved', async () => {
    const saved = { ...settings, format: 'aiff', concurrency: 2 } as const
    server.on('PUT /api/settings', () => json(saved))
    const patch = { format: 'aiff', concurrency: 2 } as const

    await expect(api.updateSettings(patch)).resolves.toEqual(saved)

    const [call] = server.callsTo('PUT /api/settings')
    expect(call?.method).toBe('PUT')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.body).toBe(JSON.stringify(patch))
    expect(SettingsUpdateSchema.parse(jsonBody(call))).toEqual(patch)
  })

  it('reports a refused template as an api error', async () => {
    const message = 'The template must contain {title} or {id}'
    server.on('PUT /api/settings', () => json({ error: { code: 'invalid_request', message } }, 400))

    const error = await rejection(api.updateSettings({ filenameTemplate: '{artist}' }))

    expect(error).toMatchObject({ kind: 'api', status: 400, code: 'invalid_request', message })
  })

  it('reports settings that break the contract as an invalid response', async () => {
    server.on('GET /api/settings', () => json({ ...settings, concurrency: 0 }))

    const error = await rejection(api.getSettings())

    expect(error).toMatchObject({
      kind: 'invalid_response',
      message: 'Unexpected response from GET /api/settings.',
    })
  })
})

describe('api.pickFolder', () => {
  it.each([
    { name: 'a picked folder', answer: { path: '/Volumes/USB/Sets' } },
    { name: 'a canceled dialog', answer: { canceled: true } },
  ] as const)('posts {} by default and returns $name', async ({ answer }) => {
    server.on('POST /api/folders/pick', () => json(answer))

    await expect(api.pickFolder()).resolves.toEqual(answer)

    const [call] = server.callsTo('POST /api/folders/pick')
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(call?.body).toBe('{}')
  })

  it('sends the folder to start in', async () => {
    server.on('POST /api/folders/pick', () => json({ canceled: true }))
    const request = { startIn: '/Users/dj/Music/DJ Scraper' }

    await api.pickFolder(request)

    const sent = jsonBody(server.callsTo('POST /api/folders/pick')[0])
    expect(FolderPickRequestSchema.parse(sent)).toEqual(request)
  })

  it('reports a second picker while one is open as an api error (409)', async () => {
    const message = 'The folder picker is already open.'
    server.on('POST /api/folders/pick', () =>
      json({ error: { code: 'invalid_request', message } }, 409),
    )

    const error = await rejection(api.pickFolder())

    expect(error).toMatchObject({ kind: 'api', status: 409, code: 'invalid_request', message })
  })

  it('reports a relative path as an invalid response', async () => {
    server.on('POST /api/folders/pick', () => json({ path: 'Music' }))

    const error = await rejection(api.pickFolder())

    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 })
  })

  it("rejects with the signal's reason when the user closes the app's dialog", async () => {
    server.on('POST /api/folders/pick', noAnswer)
    const controller = new AbortController()
    const reason = new DOMException('The settings dialog closed', 'AbortError')

    const request = api.pickFolder({}, controller.signal)
    controller.abort(reason)
    const error = await rejection(request)

    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toBe(reason)
  })
})
