import {
  CreateDownloadsResponseSchema,
  type DownloadOptions,
  DownloadsSnapshotSchema,
  type ErrorInfo,
  type Job,
  JobSchema,
  type JobStatus,
  type ServerEvent,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGates, type Gates, type GatesOptions } from '../pacing/gates.ts'
import { createTokenBucket } from '../pacing/token-bucket.ts'
import { checkUrl } from '../resolve/input.ts'
import { createBus } from './bus.ts'
import { createQueue, type EnqueueItem, MAX_OWN_STRIKES, type QueueOptions } from './queue.ts'
import type {
  AttemptOutcome,
  AttemptRequest,
  AttemptUpdate,
  RunAttempt,
  TargetFolder,
} from './types.ts'

const WALL = Date.UTC(2026, 9, 2, 8, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

const MUSIC: TargetFolder = {
  given: '/Users/dj/Music/DJ Scraper',
  real: '/Users/dj/Music/DJ Scraper',
}
const USB: TargetFolder = { given: '/Volumes/USB/Music', real: '/Volumes/USB/Music' }
const MP3: DownloadOptions = {
  format: 'mp3',
  filenameTemplate: '{artist} - {title}',
  embedArtwork: true,
  sourceUrlComment: true,
}

function item(url: string, ref: Partial<EnqueueItem['ref']> = {}): EnqueueItem {
  const checked = checkUrl(url)
  if (!checked.ok) throw new Error(`test URL refused: ${url}`)
  const { input } = checked
  return { ref: { platform: input.platform, id: input.videoId ?? url, url, ...ref }, input }
}
/** A YouTube video; `n` makes its 11-character id. */
const yt = (n: number) => item(`https://www.youtube.com/watch?v=${String(n).padStart(11, 'v')}`)
const sc = (n: number, ref: Partial<EnqueueItem['ref']> = {}) =>
  item(`https://soundcloud.com/some-artist/track-${n}`, { id: String(n), ...ref })
const refused = (n: number, error: ErrorInfo): EnqueueItem => ({ ...yt(n), refusal: error })

const UNAVAILABLE: ErrorInfo = { code: 'unavailable', message: 'This track was removed.' }
const RATE_LIMITED: ErrorInfo = { code: 'rate_limited', message: 'YouTube is limiting requests.' }
const BOT_CHECK: ErrorInfo = { code: 'bot_check', message: 'YouTube wants a bot check.' }
const NETWORK: ErrorInfo = { code: 'network', message: 'The connection dropped.' }
const PRIVATE: ErrorInfo = { code: 'private', message: 'This track is private.' }
const OUTPUT = { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true }

/** One runAttempt call, settled by the test. */
type Call = {
  request: AttemptRequest
  signal: AbortSignal
  update: (update: AttemptUpdate) => void
  finish: (outcome: AttemptOutcome) => void
  crash: (error: unknown) => void
}

type Setup = Omit<Partial<QueueOptions>, 'gates'> & {
  gates?: Gates | Partial<GatesOptions>
  /** Runs inside runAttempt, before it returns. */
  onAttempt?: (call: Call) => void
}

/** Logs of every queue a test made; afterEach fails a test that logged an error it didn't expect. */
const logs: { error: ReturnType<typeof vi.fn>; allowErrors: boolean }[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: WALL })
})
afterEach(() => {
  vi.useRealTimers()
  for (const log of logs.splice(0)) if (!log.allowErrors) expect(log.error).not.toHaveBeenCalled()
})

function setup({ gates, onAttempt, ...options }: Setup = {}) {
  const calls: Call[] = []
  const runAttempt: RunAttempt = (request, signal, onUpdate) => {
    const { promise, resolve, reject } = Promise.withResolvers<AttemptOutcome>()
    const call = { request, signal, update: onUpdate, finish: resolve, crash: reject }
    calls.push(call)
    onAttempt?.(call)
    return promise
  }
  // Every event is checked against the contract: an off-contract Job throws in the test.
  const bus = createBus({ assertContract: true })
  const events: ServerEvent[] = []
  bus.subscribe((event) => events.push(event))
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), allowErrors: false }
  logs.push(log)
  let ids = 0
  const queue = createQueue({
    runAttempt,
    gates:
      gates !== undefined && 'readyAt' in gates ? gates : createGates({ buckets: {}, ...gates }),
    bus,
    serverId: testUuid(0xfff_fff),
    concurrency: 1,
    clock: () => Date.now() - WALL,
    now: () => Date.now(),
    newId: () => testUuid(++ids),
    log,
    ...options,
  })
  const add = (
    items: EnqueueItem[],
    batch: { folder?: TargetFolder; format?: 'mp3' | 'wav' } = {},
  ) =>
    CreateDownloadsResponseSchema.parse(
      queue.add(
        {
          label: 'Summer 2026',
          folder: batch.folder ?? MUSIC,
          options: { ...MP3, format: batch.format ?? 'mp3' },
        },
        items,
      ),
    )
  /** The pending attempt of a job (its latest). */
  const callOf = (jobId: string | undefined): Call => {
    const call = calls.findLast((c) => c.request.jobId === jobId)
    if (call === undefined) throw new Error(`no attempt for ${jobId}`)
    return call
  }
  const job = (id: string | undefined): Job => JobSchema.parse(queue.get(id ?? ''))
  const status = (id: string | undefined): JobStatus | undefined => queue.get(id ?? '')?.status
  /** The events since the last call, then forgets them. */
  const take = (): ServerEvent[] => events.splice(0)
  return { queue, calls, events, log, add, callOf, job, status, take, bus }
}

/** Lets microtasks (the pump, settled attempts) run, without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** `id status` per job of every jobs.updated / jobs.added, and the other event types, in order. */
function summary(events: ServerEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'jobs.added':
      case 'jobs.updated':
        return `${event.type} ${event.jobs.map((j) => `${j.id.slice(-2)}:${j.status}`).join(' ')}`
      case 'job.progress':
        return `job.progress ${event.jobId.slice(-2)} ${event.progress.percent ?? '-'}`
      case 'jobs.removed':
        return `jobs.removed ${event.ids.map((id) => id.slice(-2)).join(' ')} | ${event.batchIds.map((id) => id.slice(-2)).join(' ')}`
      case 'queue.updated':
        return `queue.updated ${JSON.stringify(event.queue.platforms)}`
      default:
        return event.type
    }
  })
}

describe('createQueue: add', () => {
  it('creates queued jobs in a batch and emits jobs.added before anything starts', async () => {
    const { queue, add, take, calls } = setup({ concurrency: 2 })
    const response = add([yt(1), yt(2), sc(3)])
    expect(response).toEqual({
      batchId: testUuid(1),
      jobIds: [testUuid(2), testUuid(3), testUuid(4)],
      duplicates: 0,
    })
    // add() itself only adds: the pump runs on a microtask.
    expect(calls).toHaveLength(0)
    const [added, ...rest] = take()
    expect(rest).toEqual([])
    expect(added).toEqual({
      type: 'jobs.added',
      batch: {
        id: testUuid(1),
        label: 'Summer 2026',
        folder: MUSIC.given,
        format: 'mp3',
        createdAt: iso(WALL),
      },
      jobs: [yt(1), yt(2), sc(3)].map((it, i) => ({
        id: testUuid(i + 2),
        batchId: testUuid(1),
        track: it.ref,
        format: 'mp3',
        folder: MUSIC.given,
        attempt: 1,
        createdAt: iso(WALL),
        status: 'queued',
      })),
    })
    await flush()
    expect(summary(take())).toEqual(['jobs.updated 02:downloading 03:downloading'])
    expect(calls.map((c) => c.request)).toEqual([
      {
        jobId: testUuid(2),
        attemptId: testUuid(5),
        ref: yt(1).ref,
        input: yt(1).input,
        folder: MUSIC,
        options: MP3,
      },
      expect.objectContaining({ jobId: testUuid(3), attemptId: testUuid(6) }),
    ])
    expect(queue.get(testUuid(2))).toEqual({
      ...(added?.type === 'jobs.added' ? added.jobs[0] : {}),
      status: 'downloading',
      startedAt: iso(WALL),
    })
  })

  it('creates refused items failed at once, without a slot, a token or an attempt', async () => {
    const { add, take, calls, job } = setup({
      gates: { buckets: { youtube: createTokenBucket({ burst: 1, refillMs: MIN }) } },
    })
    const { jobIds } = add([
      refused(1, UNAVAILABLE),
      { ref: { platform: 'other', id: 'x', url: 'https://example.com/x' }, input: undefined },
      yt(3),
    ])
    expect(summary(take())).toEqual(['jobs.added 02:failed 03:failed 04:queued'])
    expect(job(jobIds[0])).toMatchObject({
      status: 'failed',
      error: UNAVAILABLE,
      finishedAt: iso(WALL),
    })
    expect(job(jobIds[1])).toMatchObject({ status: 'failed', error: { code: 'invalid_url' } })
    await flush()
    // The one YouTube token went to the job that runs.
    expect(calls.map((c) => c.request.jobId)).toEqual([jobIds[2]])
  })

  it('maps a repeated track to one job, by the platform of its URL', () => {
    const { add, take } = setup()
    // The same SoundCloud track, once labeled youtube by the client.
    const response = add([sc(1), yt(2), sc(1, { platform: 'youtube' }), yt(2)])
    expect(response).toEqual({
      batchId: testUuid(1),
      jobIds: [testUuid(2), testUuid(3), testUuid(2), testUuid(3)],
      duplicates: 2,
    })
    expect(summary(take())).toEqual(['jobs.added 02:queued 03:queued'])
  })

  it('maps a track to its queued or running job for the same folder and format', async () => {
    const { add, take, callOf } = setup()
    const first = add([yt(1), yt(2)])
    await flush()
    take()
    // Both still unfinished: no batch, no events.
    expect(add([yt(2), yt(1)])).toEqual({
      jobIds: [first.jobIds[1], first.jobIds[0]],
      duplicates: 2,
    })
    expect(take()).toEqual([])
    // Another format or another folder is another file.
    expect(add([yt(1)], { format: 'wav' }).duplicates).toBe(0)
    expect(add([yt(1)], { folder: USB }).duplicates).toBe(0)
    expect(add([yt(1)], { folder: { given: '/Users/dj/Link', real: MUSIC.real } }).duplicates).toBe(
      1,
    )
    // A finished job is not repeated: the track can be downloaded again.
    callOf(first.jobIds[0]).finish({ kind: 'failed', error: NETWORK })
    await flush()
    expect(add([yt(1)]).duplicates).toBe(0)
  })

  it('creates a new job for a track whose running job is being canceled', async () => {
    const { queue, add, callOf, calls, job } = setup()
    const [old] = add([yt(1)]).jobIds
    await flush()
    queue.cancel(old ?? '')
    // Canceled, then added again: the old job is on its way out, so the track gets a job of its own.
    const again = add([yt(1)])
    expect(again).toEqual({ batchId: testUuid(4), jobIds: [testUuid(5)], duplicates: 0 })
    callOf(old).finish({ kind: 'canceled' })
    await flush()
    expect(job(old).status).toBe('canceled')
    expect(job(testUuid(5)).status).toBe('downloading')
    expect(calls.map((c) => c.request.jobId)).toEqual([old, testUuid(5)])
  })

  it('returns a snapshot of every job and batch in creation order, with the queue state', async () => {
    const { queue, add } = setup()
    add([yt(1)])
    add([sc(2)], { folder: USB })
    await flush()
    const snapshot = DownloadsSnapshotSchema.parse(queue.snapshot())
    expect(snapshot.serverId).toBe(testUuid(0xfff_fff))
    expect(snapshot.jobs.map((j) => [j.id, j.status])).toEqual([
      [testUuid(2), 'downloading'],
      [testUuid(4), 'queued'],
    ])
    expect(snapshot.batches.map((b) => [b.id, b.folder])).toEqual([
      [testUuid(1), MUSIC.given],
      [testUuid(3), USB.given],
    ])
    expect(snapshot.queue).toEqual({ platforms: [] })
  })
})

describe('createQueue: running', () => {
  it('sets a picked job downloading and takes its token before its attempt starts', async () => {
    const real = createGates({ buckets: {} })
    const order: string[] = []
    const gates: Gates = {
      ...real,
      take: (platform, now) => {
        order.push('take')
        real.take(platform, now)
      },
    }
    const { add, queue } = setup({
      gates,
      onAttempt: (call) => {
        const job = queue.get(call.request.jobId)
        order.push(`attempt (${job?.status}, ${job?.startedAt})`)
      },
    })
    add([yt(1)])
    await flush()
    expect(order).toEqual(['take', `attempt (downloading, ${iso(WALL)})`])
  })

  it('turns attempt updates into progress events and status changes', async () => {
    const { add, take, callOf, job, log } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    take()
    const call = callOf(jobIds[0])
    const waitingUntil = iso(WALL + 30_000)
    call.update({ source: { codec: 'opus', bitrateKbps: 135.8 }, progress: { waitingUntil } })
    call.update({ progress: { percent: 10, downloadedBytes: 100, totalBytes: 1000 } })
    // HLS estimates jump around: the percent never goes back within the attempt.
    call.update({ progress: { percent: 4, downloadedBytes: 140 } })
    call.update({ progress: { downloadedBytes: 150 } })
    call.update({ progress: { percent: 150 } })
    call.update({ status: 'processing' })
    call.update({ progress: { percent: 99 } })
    call.update({ status: 'processing', source: { codec: 'opus', bitrateKbps: 135.8 } })
    const events = take()
    expect(summary(events)).toEqual([
      'jobs.updated 02:downloading',
      'job.progress 02 10',
      'job.progress 02 10',
      'job.progress 02 10',
      'jobs.updated 02:processing',
    ])
    expect(events[0]).toMatchObject({
      jobs: [{ source: { codec: 'opus', bitrateKbps: 135.8 }, progress: { waitingUntil } }],
    })
    expect(events[2]).toEqual({
      type: 'job.progress',
      jobId: jobIds[0],
      progress: { percent: 10, downloadedBytes: 140 },
    })
    expect(job(jobIds[0])).not.toHaveProperty('progress')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/off-contract progress/)
  })

  it('clears the progress when an attempt says so', async () => {
    const { add, take, callOf, job } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).update({ progress: { percent: 20 } })
    take()
    callOf(jobIds[0]).update({ progress: null })
    expect(summary(take())).toEqual(['jobs.updated 02:downloading'])
    expect(job(jobIds[0])).not.toHaveProperty('progress')
  })

  it('finishes a done job with its file, output and final track values, then starts the next', async () => {
    const { queue, add, take, callOf, job, calls } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    await flush()
    take()
    vi.setSystemTime(WALL + 5000)
    const outputPath = '/Users/dj/Music/DJ Scraper/Artist - Final.mp3'
    callOf(jobIds[0]).finish({
      kind: 'done',
      outputPath,
      output: OUTPUT,
      track: { title: 'Final', artist: 'Artist', thumbnailUrl: 'https://i.ytimg.com/x.jpg' },
      source: { codec: 'opus', bitrateKbps: 128 },
    })
    await flush()
    expect(summary(take())).toEqual(['jobs.updated 02:done', 'jobs.updated 03:downloading'])
    expect(job(jobIds[0])).toEqual({
      id: jobIds[0],
      batchId: testUuid(1),
      track: {
        ...yt(1).ref,
        title: 'Final',
        artist: 'Artist',
        thumbnailUrl: 'https://i.ytimg.com/x.jpg',
      },
      format: 'mp3',
      folder: MUSIC.given,
      attempt: 1,
      createdAt: iso(WALL),
      startedAt: iso(WALL),
      source: { codec: 'opus', bitrateKbps: 128 },
      status: 'done',
      outputPath,
      output: OUTPUT,
      finishedAt: iso(WALL + 5000),
    })
    expect(queue.outputPathOf(jobIds[0] ?? '')).toBe(outputPath)
    expect(queue.outputPathOf(jobIds[1] ?? '')).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('keeps the request values for final track values off the contract', async () => {
    const { add, callOf, job, log } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).finish({
      kind: 'skipped',
      outputPath: '/Users/dj/Music/DJ Scraper/x.mp3',
      track: { title: '', artist: 'A'.repeat(1001), url: 'file:///etc/passwd' },
    })
    await flush()
    expect(job(jobIds[0])).toMatchObject({
      status: 'skipped',
      track: yt(1).ref,
      outputPath: '/Users/dj/Music/DJ Scraper/x.mp3',
    })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('fails a done job whose output is off the contract instead of publishing a bad Job', async () => {
    const { add, callOf, job } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).finish({
      kind: 'done',
      outputPath: '/x.mp3',
      output: { ...OUTPUT, ext: 'MP3!' },
      track: {},
    })
    await flush()
    expect(job(jobIds[0])).toMatchObject({ status: 'failed', error: { code: 'unknown' } })
  })

  it('fails a job whose attempt fails, and goes on with the next', async () => {
    const { add, take, callOf, job } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    await flush()
    take()
    callOf(jobIds[0]).finish({ kind: 'failed', error: NETWORK })
    await flush()
    expect(summary(take())).toEqual(['jobs.updated 02:failed', 'jobs.updated 03:downloading'])
    expect(job(jobIds[0])).toMatchObject({
      status: 'failed',
      error: NETWORK,
      finishedAt: iso(WALL),
    })
  })

  it('fails a job whose attempt throws, logging the error name only', async () => {
    const { add, callOf, job, log } = setup()
    log.allowErrors = true
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).crash(new TypeError('Cannot read /Users/dj/Music/secret.mp3'))
    await flush()
    expect(job(jobIds[0])).toMatchObject({ status: 'failed', error: { code: 'unknown' } })
    expect(log.error.mock.calls).toEqual([
      [`[queue] ${testUuid(2).slice(0, 8)}: the attempt threw TypeError`],
    ])
  })

  it('fails a job whose attempt says canceled although nobody aborted it', async () => {
    const { add, callOf, job } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).finish({ kind: 'canceled' })
    await flush()
    expect(job(jobIds[0])).toMatchObject({ status: 'failed', error: { code: 'unknown' } })
  })

  it('never logs URLs, titles or paths', async () => {
    const { add, callOf, log } = setup()
    log.allowErrors = true
    const { jobIds } = add([yt(1), refused(2, UNAVAILABLE)])
    await flush()
    callOf(jobIds[0]).finish({
      kind: 'done',
      outputPath: '/Users/dj/Music/DJ Scraper/Secret Title.mp3',
      output: OUTPUT,
      track: { title: 'Secret Title' },
    })
    await flush()
    const lines = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].join(
      '\n',
    )
    expect(lines).not.toMatch(/youtube\.com|Secret|\/Users|Summer/)
    expect(lines).toContain(`[queue] ${testUuid(2).slice(0, 8)} youtube attempt 1 → done in 0.0 s`)
  })
})

describe('createQueue: cancel', () => {
  it('cancels a queued job at once: it never starts', async () => {
    const { queue, add, take, calls, callOf, job } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    await flush()
    take()
    const canceled = JobSchema.parse(queue.cancel(jobIds[1] ?? ''))
    expect(canceled).toEqual({ ...canceled, status: 'canceled', finishedAt: iso(WALL) })
    expect(summary(take())).toEqual(['jobs.updated 03:canceled'])
    // Again: unchanged, no event.
    expect(queue.cancel(jobIds[1] ?? '')).toEqual(canceled)
    expect(take()).toEqual([])
    callOf(jobIds[0]).finish({ kind: 'done', outputPath: '/x.mp3', output: OUTPUT, track: {} })
    await flush()
    expect(calls).toHaveLength(1)
    expect(job(jobIds[1]).status).toBe('canceled')
  })

  it('asks a running job to stop and ends it canceled when its attempt stops', async () => {
    const { queue, add, take, callOf, job, calls } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    await flush()
    take()
    const call = callOf(jobIds[0])
    const reasons: unknown[] = []
    call.signal.addEventListener('abort', () => {
      reasons.push(call.signal.reason)
      // The cancelRequested update is out before the attempt hears of the abort.
      reasons.push(summary(take()))
    })
    const asked = JobSchema.parse(queue.cancel(jobIds[0] ?? ''))
    expect(asked).toMatchObject({ status: 'downloading', cancelRequested: true })
    expect(reasons).toEqual([{ kind: 'cancel' }, ['jobs.updated 02:downloading']])
    // Asking again changes nothing.
    queue.cancel(jobIds[0] ?? '')
    expect(take()).toEqual([])
    // Updates still apply until the attempt has stopped.
    call.update({ progress: { percent: 50 } })
    call.finish({ kind: 'canceled' })
    await flush()
    expect(summary(take())).toEqual([
      'job.progress 02 50',
      'jobs.updated 02:canceled',
      'jobs.updated 03:downloading',
    ])
    expect(job(jobIds[0])).toMatchObject({ status: 'canceled', cancelRequested: true })
    expect(calls).toHaveLength(2)
  })

  it.each([
    [{ kind: 'done', outputPath: '/a.mp3', output: OUTPUT, track: {} }, 'done'],
    [{ kind: 'skipped', outputPath: '/a.mp3', track: {} }, 'skipped'],
    [{ kind: 'failed', error: NETWORK }, 'canceled'],
    [{ kind: 'failed', error: RATE_LIMITED }, 'canceled'],
  ] satisfies [AttemptOutcome, JobStatus][])(
    'lets a canceled job that ended %o stand as %s (a file in place stays reported)',
    async (outcome, expected) => {
      const { queue, add, callOf, job } = setup()
      const { jobIds } = add([yt(1)])
      await flush()
      queue.cancel(jobIds[0] ?? '')
      callOf(jobIds[0]).finish(outcome)
      await flush()
      expect(job(jobIds[0])).toMatchObject({ status: expected, cancelRequested: true })
    },
  )

  it('never starts a job canceled between its pick and its attempt', async () => {
    const { queue, add, bus, calls, job, take } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    // A listener reacting to the pick, before the attempt runs.
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === 'jobs.updated' && event.jobs[0]?.id === jobIds[0]) {
        unsubscribe()
        queue.cancel(jobIds[0] ?? '')
      }
    })
    await flush()
    await flush()
    expect(calls.map((c) => c.request.jobId)).toEqual([jobIds[1]])
    expect(job(jobIds[0])).toMatchObject({ status: 'canceled', cancelRequested: true })
    expect(summary(take())).toEqual([
      'jobs.added 02:queued 03:queued',
      'jobs.updated 02:downloading',
      'jobs.updated 02:downloading',
      'jobs.updated 02:canceled',
      'jobs.updated 03:downloading',
    ])
  })

  it('leaves a finished job unchanged and knows no unknown id', async () => {
    const { queue, add, take } = setup()
    const { jobIds } = add([refused(1, PRIVATE)])
    take()
    expect(queue.cancel(jobIds[0] ?? '')).toMatchObject({ status: 'failed' })
    expect(queue.cancel(testUuid(12345))).toBeUndefined()
    expect(take()).toEqual([])
  })
})

describe('createQueue: retry', () => {
  it('queues a failed job again as its next attempt, at the end of the queue', async () => {
    const { queue, add, take, callOf, calls, job } = setup()
    const { jobIds } = add([yt(1), yt(2)])
    await flush()
    callOf(jobIds[0]).update({ source: { codec: 'opus' } })
    callOf(jobIds[0]).finish({ kind: 'failed', error: NETWORK })
    await flush()
    take()
    const retried = queue.retry(jobIds[0] ?? '')
    expect(retried).toEqual({
      id: jobIds[0],
      batchId: testUuid(1),
      track: yt(1).ref,
      format: 'mp3',
      folder: MUSIC.given,
      attempt: 2,
      createdAt: iso(WALL),
      status: 'queued',
    })
    expect(summary(take())).toEqual(['jobs.updated 02:queued'])
    callOf(jobIds[1]).finish({ kind: 'done', outputPath: '/b.mp3', output: OUTPUT, track: {} })
    await flush()
    expect(calls.map((c) => c.request.jobId)).toEqual([jobIds[0], jobIds[1], jobIds[0]])
    expect(calls[2]?.request.attemptId).not.toBe(calls[0]?.request.attemptId)
    expect(job(jobIds[0])).toMatchObject({ status: 'downloading', attempt: 2 })
  })

  it('retries canceled jobs and refused ones that have a URL, and nothing else', async () => {
    const { queue, add, callOf } = setup()
    const { jobIds } = add([
      yt(1),
      yt(2),
      refused(3, UNAVAILABLE),
      { ref: { platform: 'other', id: 'x', url: 'https://example.com/x' }, input: undefined },
    ])
    await flush()
    queue.cancel(jobIds[1] ?? '')
    expect(queue.retry(jobIds[1] ?? '')).toMatchObject({ status: 'queued', attempt: 2 })
    expect(queue.retry(jobIds[2] ?? '')).toMatchObject({ status: 'queued', attempt: 2 })
    expect(queue.retry(jobIds[3] ?? '')).toBe('not_retryable')
    expect(queue.retry(jobIds[0] ?? '')).toBe('not_retryable')
    callOf(jobIds[0]).finish({ kind: 'done', outputPath: '/a.mp3', output: OUTPUT, track: {} })
    await flush()
    expect(queue.retry(jobIds[0] ?? '')).toBe('not_retryable')
    expect(queue.retry(testUuid(12345))).toBeUndefined()
  })

  it('retries with the URL of the request, not the page URL a finished attempt reported', async () => {
    const { queue, add, callOf, calls, job } = setup()
    const short = item('https://youtu.be/vvvvvvvvvv1')
    const page = 'https://www.youtube.com/watch?v=vvvvvvvvvv1'
    const [id] = add([short]).jobIds
    await flush()
    // Its file couldn't be read back (failed, retryable); the page URL is kept for display.
    callOf(id).finish({ kind: 'skipped', outputPath: '', track: { url: page } })
    await flush()
    expect(job(id)).toMatchObject({ status: 'failed', track: { url: page } })
    queue.retry(id ?? '')
    await flush()
    const request = calls[1]?.request
    expect(request?.ref.url).toBe(short.ref.url)
    // What the attempt checks: the ref's URL still classifies to the queued input.
    expect(checkUrl(request?.ref.url ?? '')).toEqual({ ok: true, input: request?.input })
  })
})

describe('createQueue: rate limits', () => {
  it('puts a rate-limited job back at the front, pauses its platform, and resumes half-open', async () => {
    const { add, take, callOf, calls, job, status } = setup({ concurrency: 2 })
    const { jobIds } = add([yt(1), yt(2), yt(3), sc(4)])
    const [y1, y2, y3, s4] = jobIds
    await flush()
    take()
    vi.setSystemTime(WALL + 1000)
    callOf(y1).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    // Back in the queue with why, and YouTube paused for 60 s; the free slot goes to SoundCloud.
    expect(summary(take())).toEqual([
      'jobs.updated 02:queued',
      'jobs.updated 05:downloading',
      `queue.updated [{"platform":"youtube","pausedUntil":"${iso(WALL + 61_000)}","pauseCode":"rate_limited"}]`,
    ])
    expect(job(y1)).toEqual({ ...job(y1), status: 'queued', lastError: RATE_LIMITED })
    expect(job(y1)).not.toHaveProperty('startedAt')
    // y2 started before the pause began: back in the queue, at the very front, without a strike.
    callOf(y2).finish({ kind: 'failed', error: RATE_LIMITED })
    callOf(s4).finish({ kind: 'done', outputPath: '/s.mp3', output: OUTPUT, track: {} })
    await flush()
    expect([status(y1), status(y2), status(y3)]).toEqual(['queued', 'queued', 'queued'])
    expect(calls).toHaveLength(3)
    // After the pause: one YouTube job at a time (the latest requeued first) until one succeeds.
    await advance(MIN)
    expect(calls.map((c) => c.request.jobId).slice(3)).toEqual([y2])
    expect(summary(take()).at(-1)).toBe('queue.updated []')
    callOf(y2).finish({ kind: 'done', outputPath: '/b.mp3', output: OUTPUT, track: {} })
    await flush()
    expect(calls.map((c) => c.request.jobId).slice(4)).toEqual([y1, y3])
  })

  it(`fails a job that itself caused ${MAX_OWN_STRIKES} strikes, with its last error`, async () => {
    const { queue, add, callOf, calls, job } = setup()
    const [y1, s2] = add([yt(1), sc(2)]).jobIds
    await flush()
    callOf(y1).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    expect(job(y1)).toMatchObject({ status: 'queued', lastError: RATE_LIMITED })
    // SoundCloud is not paused: its job runs meanwhile.
    callOf(s2).finish({ kind: 'done', outputPath: '/s.mp3', output: OUTPUT, track: {} })
    await advance(MIN)
    callOf(y1).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    expect(job(y1).status).toBe('queued')
    await advance(2 * MIN)
    expect(calls.filter((c) => c.request.jobId === y1)).toHaveLength(MAX_OWN_STRIKES)
    callOf(y1).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    expect(job(y1)).toMatchObject({ status: 'failed', error: RATE_LIMITED, attempt: 1 })
    // A retry starts the count again.
    queue.retry(y1 ?? '')
    await advance(4 * MIN)
    callOf(y1).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    expect(job(y1)).toMatchObject({ status: 'queued', attempt: 2, lastError: RATE_LIMITED })
  })

  it('fails every queued YouTube job when the bot check persists, and keeps the others', async () => {
    const { add, take, callOf, calls, job, log } = setup({
      gates: { buckets: {}, cooldown: { baseMs: 1000, maxMs: 1000 } },
    })
    const { jobIds } = add([yt(1), yt(2), sc(3), yt(4)])
    const [y1, y2, s3, y4] = jobIds
    await flush()
    callOf(y1).finish({ kind: 'failed', error: BOT_CHECK })
    await flush()
    // Paused: SoundCloud goes first.
    expect(calls.map((c) => c.request.jobId)).toEqual([y1, s3])
    callOf(s3).finish({ kind: 'done', outputPath: '/s.mp3', output: OUTPUT, track: {} })
    await advance(1000)
    take()
    // The longest pause the second time in a row: a persistent block.
    callOf(y1).finish({ kind: 'failed', error: BOT_CHECK })
    await flush()
    expect(summary(take())[0]).toBe('jobs.updated 02:failed 03:failed 05:failed')
    for (const id of [y1, y2, y4])
      expect(job(id)).toMatchObject({ status: 'failed', error: BOT_CHECK })
    expect(log.warn).toHaveBeenCalledWith(
      '[queue] youtube keeps asking for a bot check: failed 2 queued',
    )
  })
})

describe('createQueue: folder errors', () => {
  it.each([
    { code: 'disk_full', message: 'The disk is full.' },
    { code: 'folder_unavailable', message: 'The folder is gone.' },
  ] satisfies ErrorInfo[])('fails the queued jobs for the same folder on $code', async (error) => {
    const { add, take, callOf, calls, job } = setup()
    const a = add([yt(1), yt(2)]).jobIds
    const usb = add([yt(3)], { folder: USB }).jobIds
    // Another path to the same real folder.
    const link = add([yt(4)], { folder: { given: '/Users/dj/Link', real: MUSIC.real } }).jobIds
    await flush()
    take()
    callOf(a[0]).finish({ kind: 'failed', error })
    await flush()
    expect(summary(take())).toEqual([
      'jobs.updated 02:failed 03:failed 07:failed',
      'jobs.updated 05:downloading',
    ])
    expect(job(link[0])).toMatchObject({ status: 'failed', error })
    expect(calls.map((c) => c.request.jobId)).toEqual([a[0], usb[0]])
  })
})

describe('createQueue: bulk actions', () => {
  it('cancels the queued and running jobs in scope with one jobs.updated', async () => {
    const { queue, add, take, calls } = setup()
    const first = add([yt(1), yt(2), yt(3)]).jobIds
    const other = add([yt(4)]).jobIds
    await flush()
    take()
    expect(queue.cancelMany({ scope: 'batch', batchId: testUuid(5) })).toBe(1)
    expect(summary(take())).toEqual(['jobs.updated 06:canceled'])
    expect(queue.cancelMany({ scope: 'all' })).toBe(3)
    expect(summary(take())).toEqual(['jobs.updated 02:downloading 03:canceled 04:canceled'])
    expect(calls[0]?.signal.reason).toEqual({ kind: 'cancel' })
    expect(queue.cancelMany({ scope: 'all' })).toBe(0)
    expect(take()).toEqual([])
    expect(queue.cancelMany({ scope: 'jobs', ids: [first[0] ?? '', other[0] ?? ''] })).toBe(0)
  })

  it('retries the jobs in scope with the statuses asked for, skipping failures a retry cannot fix', async () => {
    const { queue, add, take, callOf } = setup({ concurrency: 4 })
    const { jobIds } = add([yt(1), yt(2), yt(3), yt(4)])
    const [network, privat, canceled, done] = jobIds
    await flush()
    callOf(network).finish({ kind: 'failed', error: NETWORK })
    callOf(privat).finish({ kind: 'failed', error: PRIVATE })
    callOf(done).finish({ kind: 'done', outputPath: '/d.mp3', output: OUTPUT, track: {} })
    queue.cancel(canceled ?? '')
    callOf(canceled).finish({ kind: 'canceled' })
    await flush()
    take()
    expect(queue.retryMany({ scope: 'all' }, ['failed'])).toBe(1)
    expect(summary(take())[0]).toBe('jobs.updated 02:queued')
    queue.cancel(network ?? '')
    take()
    expect(
      queue.retryMany({ scope: 'jobs', ids: [network ?? '', privat ?? ''] }, [
        'failed',
        'canceled',
      ]),
    ).toBe(1)
    expect(queue.retryMany({ scope: 'batch', batchId: testUuid(1) }, ['canceled'])).toBe(1)
    expect(summary(take()).slice(0, 2)).toEqual([
      'jobs.updated 02:queued',
      'jobs.updated 04:queued',
    ])
    expect(queue.retryMany({ scope: 'all' }, ['failed', 'canceled'])).toBe(0)
  })

  it('clears the finished jobs in scope with one jobs.removed, and batches left empty', async () => {
    const { queue, add, take, callOf } = setup()
    const one = add([refused(1, UNAVAILABLE), refused(2, UNAVAILABLE)]).jobIds
    const two = add([yt(3), refused(4, PRIVATE)]).jobIds
    await flush()
    take()
    expect(queue.clear({ scope: 'jobs', ids: [one[0] ?? ''] })).toBe(1)
    expect(summary(take())).toEqual(['jobs.removed 02 | '])
    expect(queue.clear({ scope: 'all' })).toBe(2)
    // The second batch keeps its running job.
    expect(summary(take())).toEqual(['jobs.removed 03 06 | 01'])
    expect(queue.snapshot().batches.map((b) => b.id)).toEqual([testUuid(4)])
    callOf(two[0]).finish({ kind: 'done', outputPath: '/c.mp3', output: OUTPUT, track: {} })
    await flush()
    take()
    expect(queue.clear({ scope: 'batch', batchId: testUuid(4) })).toBe(1)
    expect(summary(take())).toEqual(['jobs.removed 05 | 04'])
    expect(queue.clear({ scope: 'all' })).toBe(0)
    expect(take()).toEqual([])
  })
})

describe('createQueue: eviction', () => {
  it('removes the oldest finished jobs beyond the cap, and batches with their last job', async () => {
    const { queue, add, take, callOf } = setup({ maxRetainedTerminal: 2 })
    add([refused(1, UNAVAILABLE), refused(2, UNAVAILABLE)])
    const running = add([yt(3)]).jobIds
    take()
    add([refused(4, PRIVATE)])
    expect(summary(take())).toEqual(['jobs.added 07:failed', 'jobs.removed 02 | '])
    await flush()
    take()
    callOf(running[0]).finish({ kind: 'failed', error: NETWORK })
    await flush()
    // The running job of the second batch was never a candidate; failed now, it is the newest.
    expect(summary(take())).toEqual(['jobs.updated 05:failed', 'jobs.removed 03 | 01'])
    expect(queue.snapshot().jobs.map((j) => j.id)).toEqual([testUuid(5), testUuid(7)])
  })

  it('keeps every job of a batch that still has jobs to run, so its failures stay retryable', async () => {
    const { queue, add, take, callOf } = setup({ maxRetainedTerminal: 2 })
    const [a, b, c, d] = add([yt(1), yt(2), yt(3), yt(4)]).jobIds
    const done: AttemptOutcome = { kind: 'done', outputPath: '/x.mp3', output: OUTPUT, track: {} }
    const outcomes: [string | undefined, AttemptOutcome][] = [
      [a, { kind: 'failed', error: NETWORK }],
      [b, done],
      [c, { kind: 'failed', error: NETWORK }],
    ]
    for (const [id, outcome] of outcomes) {
      await flush()
      callOf(id).finish(outcome)
    }
    await flush()
    // Three finished, over the cap, while d still runs: nothing goes.
    expect(summary(take()).filter((line) => line.startsWith('jobs.removed'))).toEqual([])
    expect(queue.snapshot().jobs).toHaveLength(4)
    expect(queue.retryMany({ scope: 'batch', batchId: testUuid(1) }, ['failed'])).toBe(2)
    callOf(d).finish(done)
    await flush()
    callOf(a).finish(done)
    await flush()
    take()
    callOf(c).finish({ kind: 'failed', error: NETWORK })
    await flush()
    // The batch is finished: the oldest done jobs go, the failed one stays.
    expect(summary(take())).toEqual(['jobs.updated 04:failed', 'jobs.removed 02 03 | '])
    expect(queue.snapshot().jobs.map((j) => [j.id, j.status])).toEqual([
      [c, 'failed'],
      [d, 'done'],
    ])
  })

  it('removes done, skipped and canceled jobs before failed ones, oldest first', async () => {
    const { queue, add, take, callOf } = setup({ maxRetainedTerminal: 2 })
    add([refused(1, UNAVAILABLE)])
    const [done] = add([yt(2)]).jobIds
    await flush()
    callOf(done).finish({ kind: 'done', outputPath: '/d.mp3', output: OUTPUT, track: {} })
    await flush()
    take()
    // Over the cap: the done job goes although the failed one is older.
    add([refused(3, PRIVATE)])
    expect(summary(take())).toEqual(['jobs.added 07:failed', 'jobs.removed 04 | 03'])
    const [canceled] = add([yt(4)]).jobIds
    await flush()
    queue.cancel(canceled ?? '')
    callOf(canceled).finish({ kind: 'canceled' })
    await flush()
    expect(summary(take()).at(-1)).toBe('jobs.removed 09 | 08')
    // Only failed jobs left to choose from: the oldest goes.
    add([refused(5, PRIVATE)])
    expect(summary(take())).toEqual(['jobs.added 0c:failed', 'jobs.removed 02 | 01'])
    expect(queue.snapshot().jobs.map((j) => j.id)).toEqual([testUuid(7), testUuid(12)])
  })
})

describe('createQueue: event order', () => {
  it('emits jobs.added before any update of its jobs, even an update made inside the attempt call', async () => {
    const { add, take } = setup({
      onAttempt: (call) => call.update({ progress: { percent: 1 } }),
    })
    add([yt(1)])
    await flush()
    expect(summary(take())).toEqual([
      'jobs.added 02:queued',
      'jobs.updated 02:downloading',
      'job.progress 02 1',
    ])
  })

  it('never emits progress after a job has settled', async () => {
    const { add, take, callOf } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    const call = callOf(jobIds[0])
    call.finish({ kind: 'failed', error: NETWORK })
    await flush()
    take()
    call.update({ progress: { percent: 99 } })
    call.update({ status: 'processing' })
    expect(take()).toEqual([])
  })
})

describe('createQueue: pacing', () => {
  it('starts jobs across platforms in the order they were added', async () => {
    const { add, calls, callOf } = setup()
    const { jobIds } = add([sc(1), yt(2), sc(3)])
    for (const id of jobIds) {
      await flush()
      callOf(id).finish({ kind: 'done', outputPath: `/${id}.mp3`, output: OUTPUT, track: {} })
    }
    await flush()
    expect(calls.map((c) => c.request.jobId)).toEqual(jobIds)
  })

  it('waits for the platform bucket with one timer, and reports the next start', async () => {
    const { add, take, calls } = setup({
      concurrency: 3,
      gates: { buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 12_000 }) } },
    })
    const { jobIds } = add([yt(1), yt(2), sc(3)])
    await flush()
    expect(calls.map((c) => c.request.jobId)).toEqual([jobIds[0], jobIds[2]])
    expect(summary(take()).slice(1)).toEqual([
      'jobs.updated 02:downloading 04:downloading',
      `queue.updated [{"platform":"youtube","nextStartAt":"${iso(WALL + 12_000)}"}]`,
    ])
    expect(vi.getTimerCount()).toBe(1)
    await advance(11_999)
    expect(calls).toHaveLength(2)
    await advance(1)
    expect(calls.map((c) => c.request.jobId)).toEqual([jobIds[0], jobIds[2], jobIds[1]])
    expect(summary(take())).toEqual(['jobs.updated 03:downloading', 'queue.updated []'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not report a pacing wait for a platform with nothing queued', async () => {
    const { add, take, queue } = setup({
      concurrency: 3,
      gates: { buckets: { youtube: createTokenBucket({ burst: 1, refillMs: 12_000 }) } },
    })
    add([yt(1)])
    await flush()
    expect(summary(take()).at(-1)).toBe('jobs.updated 02:downloading')
    expect(queue.snapshot().queue).toEqual({ platforms: [] })
  })

  it('says when a pause is over, even with nothing left in the queue', async () => {
    const { queue, add, take, callOf } = setup()
    const { jobIds } = add([yt(1)])
    await flush()
    callOf(jobIds[0]).finish({ kind: 'failed', error: RATE_LIMITED })
    await flush()
    queue.cancel(jobIds[0] ?? '')
    await flush()
    take()
    await advance(MIN)
    expect(summary(take())).toEqual(['queue.updated []'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies a new concurrency at once', async () => {
    const { queue, add, calls, callOf } = setup()
    const { jobIds } = add([yt(1), yt(2), yt(3), yt(4), yt(5)])
    await flush()
    queue.setConcurrency(3)
    await flush()
    expect(calls).toHaveLength(3)
    queue.setConcurrency(1)
    for (const id of jobIds.slice(0, 2)) {
      callOf(id).finish({ kind: 'done', outputPath: `/${id}.mp3`, output: OUTPUT, track: {} })
    }
    await flush()
    expect(calls).toHaveLength(3)
    callOf(jobIds[2]).finish({ kind: 'done', outputPath: '/3.mp3', output: OUTPUT, track: {} })
    await flush()
    expect(calls).toHaveLength(4)
    expect(() => queue.setConcurrency(0)).toThrow(RangeError)
    expect(() => queue.setConcurrency(7)).toThrow(RangeError)
    expect(() => queue.setConcurrency(1.5)).toThrow(RangeError)
  })

  it.each([0, 7, 2.5])('refuses the concurrency %s', (concurrency) => {
    expect(() => setup({ concurrency })).toThrow(RangeError)
  })
})

describe('createQueue: close', () => {
  it('stops every running attempt and resolves once they have all settled', async () => {
    const { queue, add, calls, callOf, job } = setup({
      concurrency: 2,
      gates: { buckets: { youtube: createTokenBucket({ burst: 2, refillMs: 12_000 }) } },
    })
    const { jobIds } = add([yt(1), yt(2), yt(3)])
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    callOf(jobIds[0]).finish({ kind: 'done', outputPath: '/1.mp3', output: OUTPUT, track: {} })
    await flush()
    // The third job waits for a token: a timer is armed.
    expect(vi.getTimerCount()).toBe(1)
    let closed = false
    const closing = queue.close().then(() => {
      closed = true
    })
    expect(queue.closing).toBe(true)
    expect(queue.close()).toBe(queue.close())
    expect(calls[1]?.signal.reason).toEqual({ kind: 'shutdown' })
    await flush()
    expect(closed).toBe(false)
    callOf(jobIds[1]).finish({ kind: 'canceled' })
    await closing
    expect(job(jobIds[1]).status).toBe('canceled')
    expect(vi.getTimerCount()).toBe(0)
    // Nothing starts any more.
    await advance(MIN)
    expect(calls).toHaveLength(2)
    expect(job(jobIds[2]).status).toBe('queued')
  })

  it('never starts a job picked while a listener closes the queue', async () => {
    const { queue, add, bus, calls, job } = setup({
      gates: { buckets: { youtube: createTokenBucket({ burst: 1, refillMs: MIN }) } },
    })
    const { jobIds } = add([yt(1), yt(2)])
    let closed: Promise<void> | undefined
    bus.subscribe((event) => {
      if (event.type === 'jobs.updated') closed ??= queue.close()
    })
    await flush()
    await closed
    expect(calls).toHaveLength(0)
    expect(job(jobIds[0]).status).toBe('canceled')
    // The second job waits for a token, but no timer outlives close().
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves at once with nothing running', async () => {
    const { queue, add } = setup()
    add([refused(1, UNAVAILABLE)])
    await queue.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
