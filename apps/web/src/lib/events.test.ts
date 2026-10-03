import type { DownloadsSnapshot, ServerEvent } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { healthQueryKey, healthQueryOptions } from '@/features/engine/use-health.ts'
import {
  batch,
  doneJob,
  downloadingJob,
  failedJob,
  jobWith,
  queuedJob,
  snapshotWith,
} from '@/test/downloads.ts'
import { fakeApi, json, text } from '@/test/fake-api.ts'
import { FakeEventSource, fakeEventSource } from '@/test/fake-event-source.ts'
import { healthy } from '@/test/health.ts'
import {
  type DownloadsState,
  downloadsQueryKey,
  downloadsQueryOptions,
  startEvents,
} from './events.ts'

let es: ReturnType<typeof fakeEventSource>
let server: ReturnType<typeof fakeApi>
let queryClient: QueryClient
let stop: (() => void) | undefined
const cleanups: (() => void)[] = []
let visibility: DocumentVisibilityState

beforeEach(() => {
  vi.useFakeTimers()
  es = fakeEventSource()
  server = fakeApi()
  server.on('GET /api/health', () => json(healthy))
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  stop = undefined
})

afterEach(() => {
  stop?.()
  for (const cleanup of cleanups.splice(0)) cleanup()
  queryClient.clear()
  // Every timer of the stream is gone after stop(): nothing keeps running after a test (or HMR).
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'visibilityState')
  expect(server.unhandled).toEqual([])
})

/**
 * Starts the stream on a QueryClient whose ['health'] query is active, as the header's engine chip
 * keeps it. The default client's queries never expire; pass one with the real defaults to test that.
 */
async function start(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  }),
) {
  queryClient = client
  cleanups.push(new QueryObserver(queryClient, healthQueryOptions).subscribe(() => {}))
  stop = startEvents(queryClient)
  await flush()
}

const flush = () => vi.advanceTimersByTimeAsync(0)
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const state = () => queryClient.getQueryData(downloadsQueryKey)
const connection = () => state()?.connection
const healthChecks = () => server.callsTo('GET /api/health').length
const healthStatus = () => queryClient.getQueryState(healthQueryKey)?.status

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

const snapshotEvent = (changes: Partial<DownloadsSnapshot> = {}) =>
  ({ type: 'snapshot', ...snapshotWith(changes) }) satisfies ServerEvent

/** The state the default snapshot gives. */
const synced = {
  connection: 'open',
  serverId: testUuid(900),
  order: [queuedJob.id, downloadingJob.id, doneJob.id, failedJob.id],
  byId: {
    [queuedJob.id]: queuedJob,
    [downloadingJob.id]: downloadingJob,
    [doneJob.id]: doneJob,
    [failedJob.id]: failedJob,
  },
  batches: { [batch.id]: batch },
  queue: { platforms: [] },
} satisfies DownloadsState

/** Opens the newest EventSource and sends the default snapshot. */
function openWithSnapshot() {
  es.current.open()
  es.current.send(snapshotEvent())
}

/** Exactly `ms` after now, and not before, the app opens another EventSource. */
async function expectReconnectAfter(ms: number) {
  const count = es.all.length
  await advance(ms - 1)
  expect(es.all).toHaveLength(count)
  await advance(1)
  expect(es.all).toHaveLength(count + 1)
}

describe('startEvents', () => {
  it('opens one same-origin EventSource to /api/events and starts out connecting, with no jobs', async () => {
    await start()

    expect(globalThis.EventSource).toBe(FakeEventSource)
    expect(es.all).toHaveLength(1)
    expect(es.current).toMatchObject({ url: '/api/events', withCredentials: false })
    expect(state()).toEqual({ connection: 'connecting', order: [], byId: {}, batches: {} })
  })

  it('keeps ["downloads"] forever and never fetches it: the stream is its only writer', async () => {
    await start()

    expect(queryClient.getQueryDefaults(downloadsQueryKey)).toMatchObject({
      queryFn: skipToken,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    })
    expect(downloadsQueryOptions).toMatchObject({
      queryKey: ['downloads'],
      queryFn: skipToken,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    })
    openWithSnapshot()
    const observer = new QueryObserver(queryClient, downloadsQueryOptions)
    cleanups.push(observer.subscribe(() => {}))
    // Invalidating everything (e.g. after a mutation) must not try to run the skipped queryFn,
    // which would log an error and fail this test.
    await queryClient.invalidateQueries()
    await flush()

    expect(observer.getCurrentResult()).toMatchObject({ data: synced, fetchStatus: 'idle' })
  })

  it('keeps the jobs after 6 minutes without any observer (past the default 5-minute gcTime)', async () => {
    await start(new QueryClient())
    openWithSnapshot()

    for (let i = 0; i < 24; i++) {
      await advance(15_000)
      es.current.send({ type: 'heartbeat' })
    }
    const started = jobWith({ id: queuedJob.id, status: 'downloading' })
    es.current.send({ type: 'jobs.updated', jobs: [started] })

    expect(es.all).toHaveLength(1)
    expect(state()).toEqual({ ...synced, byId: { ...synced.byId, [queuedJob.id]: started } })
  })
})

describe('applying events', () => {
  it('replaces the whole state with each snapshot, e.g. from a restarted server', async () => {
    await start()
    openWithSnapshot()
    expect(state()).toEqual(synced)

    const paused = {
      platforms: [
        {
          platform: 'youtube',
          pausedUntil: '2026-10-02T08:10:00.000Z',
          pauseCode: 'rate_limited',
        },
      ],
    } satisfies DownloadsSnapshot['queue']
    es.current.send(
      snapshotEvent({
        serverId: testUuid(901),
        jobs: [failedJob],
        batches: [batch],
        queue: paused,
      }),
    )

    expect(state()).toEqual({
      connection: 'open',
      serverId: testUuid(901),
      order: [failedJob.id],
      byId: { [failedJob.id]: failedJob },
      batches: { [batch.id]: batch },
      queue: paused,
    })
  })

  it('ignores updates until the first snapshot, and again until each new connection sends one', async () => {
    await start()
    const initial = state()
    es.current.open()
    const updates = [
      {
        type: 'jobs.updated',
        jobs: [
          jobWith({ id: queuedJob.id, status: 'canceled', finishedAt: '2026-10-02T08:01:00.000Z' }),
        ],
      },
      { type: 'job.progress', jobId: downloadingJob.id, progress: { percent: 99 } },
      {
        type: 'queue.updated',
        queue: { platforms: [{ platform: 'soundcloud', nextStartAt: '2026-10-02T08:00:05.000Z' }] },
      },
      { type: 'jobs.removed', ids: [doneJob.id], batchIds: [] },
      { type: 'jobs.added', batch, jobs: [queuedJob] },
    ] satisfies ServerEvent[]
    for (const update of updates) es.current.send(update)
    expect(state()).toBe(initial)

    es.current.send(snapshotEvent())
    expect(state()).toEqual(synced)

    // The browser reconnects by itself; the new connection's snapshot comes first.
    es.current.drop()
    es.current.open()
    for (const update of updates) es.current.send(update)
    expect(state()).toEqual({ ...synced, connection: 'connecting' })
    es.current.send(snapshotEvent())
    expect(state()).toEqual(synced)
  })

  it('appends added jobs in order and adds their batch', async () => {
    await start()
    openWithSnapshot()
    const second = { ...batch, id: testUuid(101), label: 'Warehouse' }
    const first = jobWith({ id: testUuid(10), status: 'queued' }, second)
    const failedAtOnce = jobWith(
      {
        id: testUuid(11),
        status: 'failed',
        error: { code: 'preview_only', message: 'Preview only (SoundCloud Go+)' },
        finishedAt: '2026-10-02T08:00:00.000Z',
      },
      second,
    )

    es.current.send({ type: 'jobs.added', batch: second, jobs: [first, failedAtOnce] })

    expect(state()).toEqual({
      ...synced,
      order: [...synced.order, first.id, failedAtOnce.id],
      byId: { ...synced.byId, [first.id]: first, [failedAtOnce.id]: failedAtOnce },
      batches: { [batch.id]: batch, [second.id]: second },
    })
  })

  it('replaces known jobs in place, ignores unknown ones, and keeps every other job as it was', async () => {
    await start()
    openWithSnapshot()
    const before = state()
    const canceled = jobWith({
      id: queuedJob.id,
      status: 'canceled',
      finishedAt: '2026-10-02T08:01:00.000Z',
    })
    const retried = jobWith({ id: failedJob.id, status: 'queued', attempt: 2 })
    const unknown = jobWith({ id: testUuid(77), status: 'queued' })

    es.current.send({ type: 'jobs.updated', jobs: [canceled, unknown, retried] })

    const after = state()
    expect(after).toEqual({
      ...synced,
      byId: { ...synced.byId, [canceled.id]: canceled, [retried.id]: retried },
    })
    // Unchanged rows keep their identity, so a virtualized list re-renders only what changed.
    expect(after?.order).toBe(before?.order)
    expect(after?.byId[doneJob.id]).toBe(before?.byId[doneJob.id])
    expect(after?.batches).toBe(before?.batches)

    es.current.send({ type: 'jobs.updated', jobs: [unknown] })
    expect(state()).toBe(after)
  })

  it('removes cleared jobs and the batches left without jobs', async () => {
    await start()
    openWithSnapshot()

    es.current.send({ type: 'jobs.removed', ids: [doneJob.id, failedJob.id], batchIds: [] })
    expect(state()).toEqual({
      ...synced,
      order: [queuedJob.id, downloadingJob.id],
      byId: { [queuedJob.id]: queuedJob, [downloadingJob.id]: downloadingJob },
    })

    es.current.send({
      type: 'jobs.removed',
      ids: [queuedJob.id, downloadingJob.id],
      batchIds: [batch.id],
    })
    expect(state()).toEqual({ ...synced, order: [], byId: {}, batches: {} })

    const settled = state()
    es.current.send({ type: 'jobs.removed', ids: [testUuid(77)], batchIds: [testUuid(177)] })
    expect(state()).toBe(settled)
  })

  it('patches the progress of a downloading job and ignores it for any other job', async () => {
    await start()
    openWithSnapshot()
    const progress = { percent: 87.5, downloadedBytes: 3_524_969, totalBytes: 4_028_536, etaSec: 1 }

    es.current.send({ type: 'job.progress', jobId: downloadingJob.id, progress })
    expect(state()?.byId[downloadingJob.id]).toEqual({ ...downloadingJob, progress })

    const patched = state()
    es.current.send({ type: 'job.progress', jobId: queuedJob.id, progress })
    es.current.send({ type: 'job.progress', jobId: doneJob.id, progress })
    es.current.send({ type: 'job.progress', jobId: testUuid(77), progress })
    expect(state()).toBe(patched)
  })

  it('keeps the latest queue state; a heartbeat changes nothing', async () => {
    await start()
    openWithSnapshot()
    const queue = {
      platforms: [
        { platform: 'youtube', nextStartAt: '2026-10-02T08:00:12.000Z' },
        {
          platform: 'soundcloud',
          pausedUntil: '2026-10-02T08:01:00.000Z',
          pauseCode: 'rate_limited',
        },
      ],
    } satisfies DownloadsSnapshot['queue']

    es.current.send({ type: 'queue.updated', queue })
    expect(state()).toEqual({ ...synced, queue })

    const before = state()
    es.current.send({ type: 'heartbeat' })
    expect(state()).toBe(before)
  })
})

describe('events that break the contract', () => {
  it('drops an invalid update and keeps the stream', async () => {
    await start()
    openWithSnapshot()
    const before = state()

    es.current.send({ type: 'job.progress', jobId: downloadingJob.id, progress: { percent: 150 } })
    es.current.send({ type: 'jobs.updated', jobs: [{ ...queuedJob, status: 'exploded' }] })
    es.current.send({ type: 'jobs.removed', ids: ['job-1'], batchIds: [] })
    es.current.send({ type: 'settings.updated' })
    es.current.send('not json')
    expect(state()).toBe(before)

    es.current.send({ type: 'job.progress', jobId: downloadingJob.id, progress: { percent: 50 } })
    expect(state()?.byId[downloadingJob.id]).toEqual({
      ...downloadingJob,
      progress: { percent: 50 },
    })
    expect(es.all).toHaveLength(1)
    expect(es.current.readyState).toBe(FakeEventSource.OPEN)
  })

  it('asks for a new snapshot when one is invalid, and counts only invalid snapshots in a row', async () => {
    await start()
    es.current.open()
    es.current.send({ ...snapshotEvent(), serverId: 'server-1' })
    expect(es.all[0]?.readyState).toBe(FakeEventSource.CLOSED)
    expect(connection()).toBe('connecting')
    await expectReconnectAfter(1000)

    // Garbage before any snapshot is as good as an invalid snapshot.
    es.current.open()
    es.current.send('{"type":"snaps')
    await expectReconnectAfter(1000)

    // A valid one resets the count: two more invalid ones are still retried.
    openWithSnapshot()
    expect(state()).toEqual(synced)
    for (let i = 0; i < 2; i++) {
      es.current.send({ ...snapshotEvent(), jobs: 'none' })
      await expectReconnectAfter(1000)
      es.current.open()
    }
    expect(connection()).toBe('connecting')
  })

  it('gives up after 3 invalid snapshots in a row: down, the last jobs kept, no more retries', async () => {
    await start()
    openWithSnapshot()
    const invalid = { ...snapshotEvent(), queue: { platforms: [{ platform: 'vimeo' }] } }

    es.current.send(invalid)
    await expectReconnectAfter(1000)
    es.current.open()
    es.current.send(invalid)
    await expectReconnectAfter(1000)
    es.current.open()
    es.current.send(invalid)

    expect(es.current.readyState).toBe(FakeEventSource.CLOSED)
    expect(state()).toEqual({ ...synced, connection: 'down' })
    setVisibility('hidden')
    await advance(60_000)
    setVisibility('visible')
    await advance(60_000)
    expect(es.all).toHaveLength(3)
    // The server answers: its engine status stands.
    expect(healthChecks()).toBe(1)
  })
})

describe('when the stream drops', () => {
  it('rechecks the health when not back within 2 s, so the chip says "Server offline", and again once back', async () => {
    await start()
    openWithSnapshot()
    expect(healthChecks()).toBe(1)
    server.on('GET /api/health', () => text('', 502))

    es.current.drop()
    expect(connection()).toBe('connecting')
    await advance(1999)
    expect(healthChecks()).toBe(1)
    await advance(1)
    expect(healthChecks()).toBe(2)
    expect(healthStatus()).toBe('error')
    expect(connection()).toBe('down')
    // CONNECTING: the browser retries by itself, so the app opens no second EventSource.
    expect(es.all).toHaveLength(1)

    server.on('GET /api/health', () => json(healthy))
    es.current.open()
    await flush()
    expect(healthChecks()).toBe(3)
    expect(healthStatus()).toBe('success')
    es.current.send(snapshotEvent())
    expect(connection()).toBe('open')
  })

  it('leaves the health alone when the stream is back within 2 s (a dev server restart)', async () => {
    await start()
    openWithSnapshot()

    es.current.drop()
    await advance(1000)
    es.current.open()
    es.current.send(snapshotEvent())
    await advance(10_000)

    expect(healthChecks()).toBe(1)
    expect(state()).toEqual(synced)
  })

  it('reconnects itself when the browser gives up (Vite 502): 1 s, doubling to 10 s, reset by an open', async () => {
    await start()
    openWithSnapshot()
    es.current.drop()

    es.current.fail()
    for (const delay of [1000, 2000, 4000, 8000, 10_000, 10_000]) {
      await expectReconnectAfter(delay)
      es.current.fail()
    }
    expect(
      es.all.slice(0, -1).every((source) => source.readyState === FakeEventSource.CLOSED),
    ).toBe(true)
    expect(connection()).toBe('down')

    await expectReconnectAfter(10_000)
    openWithSnapshot()
    expect(connection()).toBe('open')
    es.current.drop()
    es.current.fail()
    await expectReconnectAfter(1000)
  })

  it('also retries a first connection that fails, and shows the outage after 2 s', async () => {
    await start()

    es.current.fail()
    await expectReconnectAfter(1000)
    expect(connection()).toBe('connecting')
    await advance(1000)
    expect(connection()).toBe('down')
    expect(healthChecks()).toBe(2)
  })
})

describe('the watchdog', () => {
  it('replaces a stream that has been silent for 45 s, without rechecking the health', async () => {
    await start()
    openWithSnapshot()

    // Any message proves the stream alive.
    await advance(40_000)
    es.current.send({ type: 'heartbeat' })
    await advance(44_999)
    expect(es.all).toHaveLength(1)
    await advance(1)

    expect(es.all).toHaveLength(2)
    expect(es.all[0]?.readyState).toBe(FakeEventSource.CLOSED)
    expect(connection()).toBe('connecting')
    openWithSnapshot()
    expect(state()).toEqual(synced)
    expect(healthChecks()).toBe(1)
  })

  it('replaces a connection attempt that hangs for 45 s', async () => {
    await start()

    await advance(44_999)
    expect(es.all).toHaveLength(1)
    await advance(1)

    expect(es.all).toHaveLength(2)
    expect(es.all[0]?.readyState).toBe(FakeEventSource.CLOSED)
  })
})

describe('a hidden tab', () => {
  it('closes its stream after 10 s hidden, without rechecking the health, and reopens when shown', async () => {
    await start()
    openWithSnapshot()

    setVisibility('hidden')
    await advance(9999)
    expect(es.current.readyState).toBe(FakeEventSource.OPEN)
    await advance(1)
    expect(es.current.readyState).toBe(FakeEventSource.CLOSED)
    expect(state()).toEqual({ ...synced, connection: 'connecting' })
    await advance(5 * 60_000)
    expect(es.all).toHaveLength(1)
    expect(healthChecks()).toBe(1)

    setVisibility('visible')
    expect(es.all).toHaveLength(2)
    openWithSnapshot()
    expect(state()).toEqual(synced)
    expect(healthChecks()).toBe(1)
  })

  it('keeps the stream when shown again within 10 s', async () => {
    await start()
    openWithSnapshot()

    setVisibility('hidden')
    await advance(9000)
    setVisibility('visible')
    await advance(9000)
    setVisibility('hidden')
    await advance(9000)
    setVisibility('visible')

    expect(es.all).toHaveLength(1)
    expect(es.current.readyState).toBe(FakeEventSource.OPEN)
  })

  it('closes too when the app starts in a background tab', async () => {
    visibility = 'hidden'
    await start()

    await advance(10_000)
    expect(es.current.readyState).toBe(FakeEventSource.CLOSED)
    setVisibility('visible')
    expect(es.all).toHaveLength(2)
  })

  it('stops retrying while hidden and reconnects at once, without backoff, when shown', async () => {
    await start()
    openWithSnapshot()
    es.current.drop()
    es.current.fail()
    setVisibility('hidden')
    await expectReconnectAfter(1000)
    es.current.fail()
    await expectReconnectAfter(2000)
    es.current.fail()
    await expectReconnectAfter(4000)
    es.current.fail()
    // The next try would come at 15 s, but the tab gives up its stream at 10 s.
    await advance(5 * 60_000)
    expect(es.all).toHaveLength(4)

    setVisibility('visible')
    expect(es.all).toHaveLength(5)
    es.current.fail()
    await expectReconnectAfter(1000)
  })
})

describe('stop()', () => {
  it('closes the open stream and clears the watchdog and the hidden-tab timer', async () => {
    await start()
    openWithSnapshot()
    setVisibility('hidden')
    const before = state()

    stop?.()

    expect(es.current.readyState).toBe(FakeEventSource.CLOSED)
    for (const cleanup of cleanups.splice(0)) cleanup()
    expect(vi.getTimerCount()).toBe(0)
    setVisibility('visible')
    await advance(60_000)
    expect(es.all).toHaveLength(1)
    expect(state()).toBe(before)
  })

  it('closes a pending attempt and clears the reconnect and outage timers', async () => {
    await start()
    openWithSnapshot()
    es.current.drop()
    es.current.fail()
    await expectReconnectAfter(1000)

    stop?.()

    expect(es.current.readyState).toBe(FakeEventSource.CLOSED)
    for (const cleanup of cleanups.splice(0)) cleanup()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(es.all).toHaveLength(2)
    expect(healthChecks()).toBe(1)
  })
})
