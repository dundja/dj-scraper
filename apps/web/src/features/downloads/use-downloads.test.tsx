import type { Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DownloadsState, downloadsQueryKey } from '@/lib/events.ts'
import {
  batch,
  doneJob,
  downloadingJob,
  failedJob,
  jobWith,
  liveDownloads,
  queuedJob,
  snapshotWith,
} from '@/test/downloads.ts'
import { fakeApi } from '@/test/fake-api.ts'
import { createTestQueryClient } from '@/test/render.tsx'
import { trackKey } from './track-ref.ts'
import { useDownloadedTrackKeys, useDownloads, useJob, useJobIdsByTrack } from './use-downloads.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  // The hooks only read what the event stream wrote: no request, ever.
  expect(server.unhandled).toEqual([])
})

/** Renders `hook` under a fresh QueryClient, counting renders. */
function renderCounted<T>(hook: () => T) {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  let renders = 0
  const rendered = renderHook(
    () => {
      renders++
      return hook()
    },
    { wrapper },
  )
  return { ...rendered, queryClient, renders: () => renders }
}

const progressOf = (job: Job, percent: number) =>
  ({ type: 'job.progress', jobId: job.id, progress: { percent } }) as const

describe('useDownloads', () => {
  it('has no data and makes no request before the event stream starts', () => {
    const { result } = renderCounted(useDownloads)
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
  })

  it("reads the stream's state: connecting, then the snapshot's jobs", async () => {
    const { result, queryClient } = renderCounted(useDownloads)
    await liveDownloads(queryClient)

    expect(result.current.data).toMatchObject({
      connection: 'open',
      order: [queuedJob.id, downloadingJob.id, doneJob.id, failedJob.id],
    })
    expect(result.current.data?.byId[doneJob.id]).toEqual(doneJob)
  })
})

describe('useJob', () => {
  it('is undefined until the job arrives, then follows it', async () => {
    const id = testUuid(50)
    const { result, queryClient } = renderCounted(() => useJob(id))
    const stream = await liveDownloads(queryClient)
    expect(result.current).toBeUndefined()

    const added = jobWith({ id, status: 'queued' })
    await stream.send({ type: 'jobs.added', batch, jobs: [added] })
    expect(result.current).toEqual(added)

    const running = jobWith({ id, status: 'downloading', startedAt: batch.createdAt })
    await stream.send({ type: 'jobs.updated', jobs: [running] })
    await stream.send(progressOf(running, 42))
    expect(result.current).toMatchObject({ status: 'downloading', progress: { percent: 42 } })

    await stream.send({ type: 'jobs.removed', ids: [id], batchIds: [] })
    expect(result.current).toBeUndefined()
  })

  it("doesn't re-render for another job's progress", async () => {
    const { result, queryClient, renders } = renderCounted(() => useJob(doneJob.id))
    const stream = await liveDownloads(queryClient)
    const job = result.current
    expect(job).toEqual(doneJob)
    const before = renders()

    await stream.send(progressOf(downloadingJob, 50))
    await stream.send(progressOf(downloadingJob, 60))
    await stream.send({ type: 'heartbeat' })

    expect(renders()).toBe(before)
    expect(result.current).toBe(job)
  })

  it('is undefined for no id, and for names an object has', async () => {
    const none = renderCounted(() => useJob(undefined))
    await liveDownloads(none.queryClient)
    expect(none.result.current).toBeUndefined()

    const inherited = renderCounted(() => useJob('constructor'))
    await liveDownloads(inherited.queryClient)
    expect(inherited.result.current).toBeUndefined()
  })
})

describe('useJobIdsByTrack', () => {
  it('is empty before the stream starts', () => {
    const { result } = renderCounted(useJobIdsByTrack)
    expect(result.current.size).toBe(0)
  })

  it("maps each track to its newest job's id", async () => {
    const { result, queryClient } = renderCounted(useJobIdsByTrack)
    await liveDownloads(queryClient)

    // The snapshot's queued, downloading and done jobs are one YouTube track; done came last.
    expect(result.current.size).toBe(2)
    expect(result.current.get(trackKey(doneJob.track))).toBe(doneJob.id)
    expect(result.current.get(trackKey(failedJob.track))).toBe(failedJob.id)
    expect(result.current.get('youtube:nothing')).toBeUndefined()
  })

  it('switches to a newer job of the same track, e.g. in another format', async () => {
    const { result, queryClient } = renderCounted(useJobIdsByTrack)
    const stream = await liveDownloads(queryClient)
    const aiffBatch = { ...batch, id: testUuid(101), format: 'aiff' } as const
    const again = jobWith({ id: testUuid(60), status: 'queued' }, aiffBatch)

    await stream.send({ type: 'jobs.added', batch: aiffBatch, jobs: [again] })

    expect(result.current.get(trackKey(doneJob.track))).toBe(again.id)
  })

  it("indexes the tracks once per job list, not again for each job's progress", async () => {
    // Jobs that count how often their track is read: the index reads each one once. The first,
    // whose progress changes, isn't counted: the cache compares it with its new state.
    let reads = 0
    const counted = (job: Job): Job => {
      const { track, ...rest } = job
      return Object.defineProperty({ ...rest }, 'track', {
        enumerable: true,
        get: () => {
          reads++
          return track
        },
      }) as Job
    }
    const jobs = Array.from({ length: 100 }, (_, i) => {
      const job = jobWith({
        id: testUuid(300 + i),
        status: 'downloading',
        startedAt: batch.createdAt,
        track: { platform: 'youtube', id: `video${i}`, url: `https://youtu.be/video${i}` },
      })
      return i === 0 ? job : counted(job)
    })
    const state: DownloadsState = {
      connection: 'open',
      order: jobs.map((job) => job.id),
      byId: Object.fromEntries(jobs.map((job) => [job.id, job])),
      batches: {},
    }
    const { result, queryClient, renders } = renderCounted(useJobIdsByTrack)
    // As the stream writes it; TanStack Query tells React on a 0 ms timer.
    const write = (next: DownloadsState) =>
      act(async () => {
        queryClient.setQueryData(downloadsQueryKey, next)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    await write(state)
    expect(result.current.size).toBe(100)
    expect(reads).toBe(99)
    const before = renders()

    // A progress event: a new byId with one new job, the same order. No read, no render.
    const [first] = jobs
    if (first === undefined) throw new Error('No job')
    const progressed = { ...first, progress: { percent: 50 } }
    reads = 0
    await write({ ...state, byId: { ...state.byId, [first.id]: progressed } })
    expect(result.current.get('youtube:video0')).toBe(first.id)
    expect(reads).toBe(0)
    expect(renders()).toBe(before)
  })

  it('keeps the same map while no job comes or goes, and a new one when one does', async () => {
    const snapshot = snapshotWith({ jobs: [doneJob, failedJob, downloadingJob] })
    const { result, queryClient } = renderCounted(useJobIdsByTrack)
    const stream = await liveDownloads(queryClient, snapshot)
    const first = result.current

    await stream.send({
      type: 'queue.updated',
      queue: { platforms: [{ platform: 'youtube', nextStartAt: '2026-10-02T08:01:00.000Z' }] },
    })
    await stream.send(progressOf(downloadingJob, 75))
    expect(result.current).toBe(first)

    const again = jobWith({ id: testUuid(61), status: 'queued', track: failedJob.track })
    await stream.send({ type: 'jobs.added', batch, jobs: [again] })
    expect(result.current).not.toBe(first)
    expect(result.current.get(trackKey(failedJob.track))).toBe(again.id)
  })
})

describe('useDownloadedTrackKeys', () => {
  const scRef = {
    platform: 'soundcloud',
    id: '1501000002',
    url: 'https://soundcloud.com/a/b',
  } as const
  const spotifyRow = {
    platform: 'spotify',
    id: '6aiKIFjPwa3UvDCD5ecoJj',
    url: 'https://open.spotify.com/track/6aiKIFjPwa3UvDCD5ecoJj',
  } as const

  it('is empty before the stream starts', () => {
    const { result } = renderCounted(useDownloadedTrackKeys)
    expect(result.current).toEqual([])
  })

  it('lists the tracks whose newest job is done or already in the folder, sorted', async () => {
    const skipped = jobWith({
      id: testUuid(70),
      status: 'skipped',
      track: spotifyRow,
      outputPath: '/Users/dj/Music/DJ Scraper/Rick Astley - Whenever You Need Somebody.mp3',
      finishedAt: batch.createdAt,
    })
    const { result, queryClient } = renderCounted(useDownloadedTrackKeys)
    // The YouTube track's newest job is done; the SoundCloud row's failed.
    await liveDownloads(queryClient, snapshotWith({ jobs: [...snapshotWith().jobs, skipped] }))

    expect(result.current).toEqual([trackKey(skipped.track), trackKey(doneJob.track)].sort())
    expect(result.current).not.toContain(trackKey(failedJob.track))
  })

  it("keeps the same array through progress events, and changes when a track's newest job does", async () => {
    const running = jobWith({
      id: testUuid(71),
      status: 'downloading',
      track: scRef,
      startedAt: batch.createdAt,
    })
    const { result, queryClient, renders } = renderCounted(useDownloadedTrackKeys)
    const stream = await liveDownloads(
      queryClient,
      snapshotWith({ jobs: [doneJob, failedJob, running] }),
    )
    const first = result.current
    expect(first).toEqual([trackKey(doneJob.track)])
    const before = renders()

    await stream.send(progressOf(running, 40))
    await stream.send(progressOf(running, 80))
    await stream.send({
      type: 'queue.updated',
      queue: { platforms: [{ platform: 'youtube', nextStartAt: '2026-10-02T08:01:00.000Z' }] },
    })
    expect(result.current).toBe(first)
    expect(renders()).toBe(before)

    // The SoundCloud row finishes: it joins.
    const finished = jobWith({
      ...running,
      status: 'done',
      outputPath: '/Users/dj/Music/DJ Scraper/b.mp3',
      output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 128, encoded: false },
      finishedAt: '2026-10-02T08:02:00.000Z',
    })
    await stream.send({ type: 'jobs.updated', jobs: [finished] })
    expect(result.current).toEqual([trackKey(doneJob.track), trackKey(scRef)].sort())

    // The done YouTube track is queued again (another format): its newest job isn't done.
    const aiffBatch = { ...batch, id: testUuid(102), format: 'aiff' } as const
    const again = jobWith({ id: testUuid(72), status: 'queued', track: doneJob.track }, aiffBatch)
    await stream.send({ type: 'jobs.added', batch: aiffBatch, jobs: [again] })
    expect(result.current).toEqual([trackKey(scRef)])
  })
})
