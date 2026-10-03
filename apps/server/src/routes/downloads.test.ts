import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ApiErrorBodySchema,
  BulkJobsResponseSchema,
  CreateDownloadsResponseSchema,
  type DownloadOptions,
  DownloadsSnapshotSchema,
  type Job,
  JobSchema,
  type ServerEvent,
  type Track,
  type TrackRef,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { createBus } from '../jobs/bus.ts'
import { createQueue, type Queue } from '../jobs/queue.ts'
import {
  type AttemptOutcome,
  type AttemptRequest,
  type EngineBins,
  type RunAttempt,
  StepError,
} from '../jobs/types.ts'
import { createGates } from '../pacing/gates.ts'
import { createSettingsStore, type SettingsStore } from '../settings/store.ts'
import { UNUSED_DEPS } from '../stubs.ts'
import { DOWNLOAD_BODY_LIMIT_BYTES } from './downloads.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`
const BINS: EngineBins = { ytdlp: '/bin/yt-dlp', ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' }
const MP3: DownloadOptions = {
  format: 'mp3',
  filenameTemplate: '{artist} - {title}',
  embedArtwork: true,
  sourceUrlComment: true,
}
const YT: TrackRef = {
  platform: 'youtube',
  id: 'jNQXAC9IVRw',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
}
const SC: TrackRef = {
  platform: 'soundcloud',
  id: '123998367',
  url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw',
}

let root = ''
let dataDir = ''
let music = ''
let defaultFolder = ''
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-downloads-route-')))
  dataDir = path.join(root, 'data')
  music = path.join(root, 'music')
  defaultFolder = path.join(root, 'home', 'Music', 'DJ Scraper')
  await mkdir(path.join(dataDir, 'jobs'), { recursive: true })
  await mkdir(music)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One runAttempt call, settled by the test. */
type Call = { request: AttemptRequest; finish: (outcome: AttemptOutcome) => void }

async function setup({
  concurrency = 6,
  cached = {},
}: {
  concurrency?: number
  cached?: Record<string, Track>
} = {}) {
  const calls: Call[] = []
  const runAttempt: RunAttempt = (request, signal) => {
    const { promise, resolve } = Promise.withResolvers<AttemptOutcome>()
    calls.push({ request, finish: resolve })
    // Like the real attempt: an abort (cancel or shutdown) ends it canceled.
    signal.addEventListener('abort', () => resolve({ kind: 'canceled' }), { once: true })
    return promise
  }
  const bus = createBus({ assertContract: true })
  const events: ServerEvent[] = []
  bus.subscribe((event) => events.push(event))
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let ids = 0
  const queue: Queue = createQueue({
    runAttempt,
    gates: createGates({ buckets: {} }),
    bus,
    serverId: testUuid(0xfff),
    concurrency,
    newId: () => testUuid(++ids),
    log: quiet,
  })
  const settings: SettingsStore = await createSettingsStore({ dataDir, defaultFolder, log: quiet })
  const locateEngine = vi.fn(async () => BINS)
  const reveal = vi.fn(async (_file: string) => {})
  const peek = vi.fn((platform: string, id: string) => cached[`${platform}:${id}`])
  const app = createApp({
    port: PORT,
    health: { current: vi.fn(), recheck: vi.fn() },
    ...UNUSED_DEPS,
    enricher: { ...UNUSED_DEPS.enricher, peek },
    queue,
    settings,
    locateEngine,
    dataDirReal: dataDir,
    defaultFolder,
    reveal,
    log: quiet,
  })
  const send = (route: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('host', HOST)
    if (init.method === 'POST') headers.set('content-type', 'application/json')
    return Promise.resolve(app.request(`http://${HOST}/api${route}`, { ...init, headers }))
  }
  const post = (route: string, body?: unknown) =>
    send(route, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  const download = (items: TrackRef[], extra: object = {}) =>
    post('/downloads', { items, folder: music, options: MP3, ...extra })
  return {
    app,
    queue,
    settings,
    calls,
    events,
    locateEngine,
    reveal,
    peek,
    send,
    post,
    download,
    bus,
  }
}

async function errorOf(res: Response) {
  return { status: res.status, ...ApiErrorBodySchema.parse(await res.json()).error }
}
const jobOf = async (res: Response): Promise<Job> => JobSchema.parse(await res.json())

describe('POST /api/downloads', () => {
  it('queues one job per item into the resolved folder, announces them, and remembers the folder', async () => {
    const { download, calls, events, queue, settings } = await setup()
    const res = await download([YT, SC], { label: 'Mixed' })
    expect(res.status).toBe(200)
    const body = CreateDownloadsResponseSchema.parse(await res.json())
    expect(body).toEqual({
      batchId: testUuid(1),
      jobIds: [testUuid(2), testUuid(3)],
      duplicates: 0,
    })

    const added = events.find((event) => event.type === 'jobs.added')
    expect(added).toMatchObject({
      batch: { id: testUuid(1), label: 'Mixed', folder: music, format: 'mp3' },
      jobs: [
        { id: testUuid(2), status: 'queued', track: YT, folder: music, attempt: 1 },
        { id: testUuid(3), status: 'queued', track: SC, folder: music },
      ],
    })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // The attempt gets the classified URL and platform, and the folder's real path.
    expect(calls[0]?.request).toMatchObject({
      input: { url: YT.url, platform: 'youtube', kind: 'youtube_video' },
      folder: { given: music, real: music },
      options: MP3,
    })
    expect(calls[1]?.request.input.platform).toBe('soundcloud')
    expect(DownloadsSnapshotSchema.parse(queue.snapshot()).jobs).toHaveLength(2)
    expect(settings.get().recentFolders).toEqual([music])
  })

  it('maps a repeated item to its job, within the request and against a queued job', async () => {
    const { download } = await setup({ concurrency: 1 })
    const first = CreateDownloadsResponseSchema.parse(await (await download([YT, YT])).json())
    expect(first).toEqual({
      batchId: testUuid(1),
      jobIds: [testUuid(2), testUuid(2)],
      duplicates: 1,
    })
    const again = CreateDownloadsResponseSchema.parse(await (await download([YT])).json())
    expect(again).toEqual({ jobIds: [testUuid(2)], duplicates: 1 })
  })

  it('creates failed jobs at once, without an attempt, for refused, list and unavailable items', async () => {
    const { download, calls, queue } = await setup()
    const items: TrackRef[] = [
      { platform: 'other', id: 'c', url: 'https://user:secret@example.com/track' },
      {
        platform: 'other',
        id: 'drm',
        url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      },
      {
        platform: 'soundcloud',
        id: '2284613',
        url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
      },
      {
        ...SC,
        id: '1',
        url: `${SC.url}-1`,
        availability: 'unavailable',
        unavailableReason: 'preview_only',
      },
      { ...SC, id: '2', url: `${SC.url}-2`, availability: 'unavailable' },
      { ...SC, id: '3', url: `${SC.url}-3`, unavailableReason: 'geo_blocked' },
    ]
    expect((await download(items)).status).toBe(200)
    const jobs = queue.snapshot().jobs
    expect(jobs.map((job) => (job.status === 'failed' ? job.error : job.status))).toEqual([
      { code: 'invalid_url', message: "Links with a username or password aren't supported." },
      {
        code: 'unsupported_url',
        message: expect.stringMatching(/^DJ Scraper doesn't download from Spotify/),
      },
      { code: 'invalid_request', message: 'This link is a list: open it to pick tracks.' },
      {
        code: 'preview_only',
        message: 'Only a 30-second preview is available: the full track needs SoundCloud Go+.',
      },
      { code: 'unavailable', message: 'Unavailable: removed or never existed.' },
      { code: 'geo_blocked', message: 'Not available in your country.' },
    ])
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it("fills the display fields an item lacks from the enricher's cache, by the URL's platform", async () => {
    const cachedTrack: Track = {
      id: SC.id,
      platform: 'soundcloud',
      url: SC.url,
      title: 'Cached title',
      artist: 'Cached artist',
      uploader: 'jaimemf',
      durationSec: 10,
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-000-original.jpg',
      availability: 'available',
    }
    const { download, queue, peek } = await setup({
      cached: { [`soundcloud:${SC.id}`]: cachedTrack },
    })
    // A ref claiming another platform is still looked up by the platform its URL classifies to.
    await download([{ ...SC, platform: 'other', title: 'My own title' }])
    expect(peek).toHaveBeenCalledWith('soundcloud', SC.id)
    expect(queue.snapshot().jobs[0]?.track).toEqual({
      ...SC,
      platform: 'other',
      title: 'My own title',
      artist: 'Cached artist',
      uploader: 'jaimemf',
      durationSec: 10,
      thumbnailUrl: 'https://i1.sndcdn.com/artworks-000-original.jpg',
    })
  })

  it('skips a cached value the contract would refuse (a title over 1,000 characters)', async () => {
    const long: Track = {
      id: SC.id,
      platform: 'soundcloud',
      url: SC.url,
      title: 'x'.repeat(1001),
      availability: 'available',
    }
    const { download, queue } = await setup({ cached: { [`soundcloud:${SC.id}`]: long } })
    await download([SC])
    expect(queue.snapshot().jobs[0]?.track).toEqual(SC)
  })

  it('answers 503 engine_missing without creating a job when the engine is gone', async () => {
    const { download, locateEngine, queue, settings } = await setup()
    locateEngine.mockRejectedValueOnce(new StepError('engine_missing', 'yt-dlp is not on PATH.'))
    expect(await errorOf(await download([YT]))).toEqual({
      status: 503,
      code: 'engine_missing',
      message: 'yt-dlp is not on PATH.',
    })
    expect(queue.snapshot().jobs).toEqual([])
    expect(settings.get().recentFolders).toEqual([])
  })

  it('answers 422 folder_unavailable for a missing folder, and never creates it', async () => {
    const { post, queue } = await setup()
    const missing = path.join(root, 'nowhere', 'Music')
    const res = await post('/downloads', { items: [YT], folder: missing, options: MP3 })
    expect(await errorOf(res)).toMatchObject({ status: 422, code: 'folder_unavailable' })
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(queue.snapshot().jobs).toEqual([])
  })

  it('creates the default folder (~/Music/DJ Scraper) when it is missing', async () => {
    const { post, queue } = await setup()
    const res = await post('/downloads', { items: [YT], folder: defaultFolder, options: MP3 })
    expect(res.status).toBe(200)
    expect((await stat(defaultFolder)).isDirectory()).toBe(true)
    expect(queue.snapshot().jobs[0]?.folder).toBe(defaultFolder)
  })

  it('refuses a folder inside the data dir', async () => {
    const { post } = await setup()
    const res = await post('/downloads', { items: [YT], folder: dataDir, options: MP3 })
    expect(await errorOf(res)).toMatchObject({ status: 422, code: 'folder_unavailable' })
  })

  it('creates the subfolder as one safe name inside the folder', async () => {
    const { download, queue } = await setup()
    await download([YT], { options: { ...MP3, subfolder: 'Set: Part 1/2' } })
    expect(await readdir(music)).toEqual(['Set - Part 1-2'])
    expect(queue.snapshot().jobs[0]?.folder).toBe(path.join(music, 'Set - Part 1-2'))
  })

  it('answers 400 for a request off the contract', async () => {
    const { post } = await setup()
    expect(
      await errorOf(await post('/downloads', { items: [], folder: music, options: MP3 })),
    ).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    const relative = await post('/downloads', { items: [YT], folder: 'Music', options: MP3 })
    expect((await errorOf(relative)).status).toBe(400)
  })

  it('takes a body up to 8 MiB, and answers 413 above', async () => {
    const { post } = await setup()
    const huge = JSON.stringify({
      items: [YT],
      folder: music,
      options: MP3,
      pad: 'x'.repeat(DOWNLOAD_BODY_LIMIT_BYTES),
    })
    expect(await errorOf(await post('/downloads', huge))).toEqual({
      status: 413,
      code: 'invalid_request',
      message: 'The request body is larger than 8 MiB',
    })
    const items = Array.from({ length: 5000 }, (_, i) => ({
      ...YT,
      id: `v${i}`,
      title: 't'.repeat(200),
    }))
    expect((await post('/downloads', { items, folder: music, options: MP3 })).status).toBe(200)
  })
})

describe('GET /api/downloads', () => {
  it('answers the snapshot', async () => {
    const { download, send } = await setup()
    await download([YT])
    const res = await send('/downloads')
    expect(res.status).toBe(200)
    const snapshot = DownloadsSnapshotSchema.parse(await res.json())
    expect(snapshot).toMatchObject({
      serverId: testUuid(0xfff),
      jobs: [{ id: testUuid(2) }],
      batches: [{ id: testUuid(1) }],
    })
  })
})

describe('POST /api/downloads/:id/…', () => {
  it('cancels a queued job at once and asks a running one to stop', async () => {
    const { download, post, calls } = await setup({ concurrency: 1 })
    await download([YT, SC])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const queued = await jobOf(await post(`/downloads/${testUuid(3)}/cancel`))
    expect(queued).toMatchObject({ id: testUuid(3), status: 'canceled' })
    const running = await jobOf(await post(`/downloads/${testUuid(2)}/cancel`))
    expect(running).toMatchObject({ id: testUuid(2), status: 'downloading', cancelRequested: true })
  })

  it('retries a canceled job, and answers 409 for one that can’t be retried', async () => {
    const { download, post, calls } = await setup({ concurrency: 1 })
    await download([YT, SC])
    await post(`/downloads/${testUuid(3)}/cancel`)
    const retried = await jobOf(await post(`/downloads/${testUuid(3)}/retry`))
    expect(retried).toMatchObject({ status: 'queued', attempt: 2 })
    expect(await errorOf(await post(`/downloads/${testUuid(3)}/retry`))).toEqual({
      status: 409,
      code: 'invalid_request',
      message: 'Only failed or canceled downloads can be retried.',
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
  })

  it('answers 409 with why, for a failed job whose link never classified', async () => {
    const { download, post } = await setup()
    await download([{ platform: 'other', id: 'c', url: 'https://user:secret@example.com/t' }])
    expect(await errorOf(await post(`/downloads/${testUuid(2)}/retry`))).toEqual({
      status: 409,
      code: 'invalid_request',
      message: "This link can't be downloaded, so retrying won't help.",
    })
  })

  it('reveals the file of a done job, from the job record', async () => {
    const { download, post, calls, reveal } = await setup()
    await download([YT])
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const file = path.join(music, 'jawed - Me at the zoo.mp3')
    calls[0]?.finish({
      kind: 'done',
      outputPath: file,
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true },
      track: {},
    })
    await vi.waitFor(async () =>
      expect((await post(`/downloads/${testUuid(2)}/reveal`)).status).toBe(204),
    )
    expect(reveal).toHaveBeenCalledWith(file)
  })

  it('answers 404 for a job without a file, and passes on what reveal says', async () => {
    const { download, post, calls, reveal } = await setup()
    await download([YT])
    expect(await errorOf(await post(`/downloads/${testUuid(2)}/reveal`))).toEqual({
      status: 404,
      code: 'not_found',
      message: 'This download has no file.',
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0]?.finish({ kind: 'skipped', outputPath: path.join(music, 'x.mp3'), track: {} })
    reveal.mockRejectedValue(
      new StepError('not_found', 'The file was moved, deleted, or its drive is unplugged'),
    )
    await vi.waitFor(async () =>
      expect(await errorOf(await post(`/downloads/${testUuid(2)}/reveal`))).toEqual({
        status: 404,
        code: 'not_found',
        message: 'The file was moved, deleted, or its drive is unplugged',
      }),
    )
  })

  it.each(['cancel', 'retry', 'reveal'])(
    'answers 404 for /%s of an unknown or malformed id',
    async (action) => {
      const { post } = await setup()
      for (const id of [testUuid(99), 'not-a-uuid', testUuid(2).toUpperCase().replace('4', 'x')]) {
        expect(await errorOf(await post(`/downloads/${id}/${action}`))).toEqual({
          status: 404,
          code: 'not_found',
          message: 'No such download.',
        })
      }
    },
  )
})

describe('bulk actions', () => {
  it('cancels, retries and clears the jobs in scope, answering how many changed', async () => {
    const { download, post, queue, events } = await setup({ concurrency: 1 })
    await download([YT, SC, { ...SC, id: '9', url: `${SC.url}-9` }])
    const count = async (route: string, body: unknown) =>
      BulkJobsResponseSchema.parse(await (await post(route, body)).json()).count
    expect(
      await count('/downloads/cancel', {
        target: { scope: 'jobs', ids: [testUuid(3), testUuid(4)] },
      }),
    ).toBe(2)
    expect(
      await count('/downloads/retry', { target: { scope: 'all' }, statuses: ['canceled'] }),
    ).toBe(2)
    // The default statuses are ['failed']: nothing failed.
    expect(
      await count('/downloads/retry', { target: { scope: 'batch', batchId: testUuid(1) } }),
    ).toBe(0)
    expect(await count('/downloads/cancel', { target: { scope: 'all' } })).toBe(3)
    // Clear takes finished jobs only: the running one until its attempt has stopped.
    expect(await count('/downloads/clear', { target: { scope: 'jobs', ids: [testUuid(3)] } })).toBe(
      1,
    )
    expect(events.at(-1)).toEqual({ type: 'jobs.removed', ids: [testUuid(3)], batchIds: [] })
    await vi.waitFor(() => expect(queue.get(testUuid(2))?.status).toBe('canceled'))
    expect(await count('/downloads/clear', { target: { scope: 'all' } })).toBe(2)
    expect(events.at(-1)).toEqual({
      type: 'jobs.removed',
      ids: [testUuid(2), testUuid(4)],
      batchIds: [testUuid(1)],
    })
    expect(queue.snapshot()).toMatchObject({ jobs: [], batches: [] })
  })

  it('answers 400 for a scope off the contract', async () => {
    const { post } = await setup()
    const res = await post('/downloads/cancel', { target: { scope: 'all', ids: [testUuid(1)] } })
    expect((await errorOf(res)).status).toBe(400)
  })
})

describe('during shutdown', () => {
  it('answers every mutation with 503, and still serves the snapshot', async () => {
    const { download, post, send, queue } = await setup()
    await download([YT])
    await queue.close()
    const shuttingDown = { status: 503, code: 'unknown', message: 'DJ Scraper is shutting down' }
    expect(await errorOf(await download([SC]))).toEqual(shuttingDown)
    expect(await errorOf(await post(`/downloads/${testUuid(2)}/cancel`))).toEqual(shuttingDown)
    expect(await errorOf(await post(`/downloads/${testUuid(2)}/retry`))).toEqual(shuttingDown)
    for (const action of ['cancel', 'retry', 'clear']) {
      expect(
        await errorOf(await post(`/downloads/${action}`, { target: { scope: 'all' } })),
      ).toEqual(shuttingDown)
    }
    expect((await send('/downloads')).status).toBe(200)
  })
})
