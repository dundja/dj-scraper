// Download bodies for tests: the shared fixtures (`@dj-scraper/shared/test-helpers`), parsed with the
// shared schemas so they can't drift from the contract.
import {
  type Batch,
  BatchSchema,
  type DownloadsSnapshot,
  DownloadsSnapshotSchema,
  type Job,
  JobSchema,
  type JobStatus,
  type ServerEvent,
  type Settings,
  SettingsSchema,
} from '@dj-scraper/shared'
import { jobsByStatus, testBatch, testUuid, youtubeRef } from '@dj-scraper/shared/test-helpers'
import type { QueryClient } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import { onTestFinished, vi } from 'vitest'
import { startEvents } from '@/lib/events.ts'
import { fakeEventSource } from './fake-event-source.ts'

export const batch: Batch = BatchSchema.parse(testBatch)

/** A job of `batch` with `fields` on top, validated against the contract. */
export function jobWith(
  fields: { id: string; status: JobStatus } & Record<string, unknown>,
  inBatch: Batch = batch,
): Job {
  return JobSchema.parse({
    batchId: inBatch.id,
    track: youtubeRef,
    format: inBatch.format,
    folder: inBatch.folder,
    attempt: 1,
    createdAt: inBatch.createdAt,
    ...fields,
  })
}

export const queuedJob = JobSchema.parse(jobsByStatus.queued)
export const downloadingJob = JobSchema.parse(jobsByStatus.downloading)
export const doneJob = JobSchema.parse(jobsByStatus.done)
/** A SoundCloud set row that failed on its second attempt. */
export const failedJob = JobSchema.parse(jobsByStatus.failed)

/** What `GET /api/events` sends first: the four jobs above in creation order, nothing paused. */
export function snapshotWith(changes: Partial<DownloadsSnapshot> = {}): DownloadsSnapshot {
  return DownloadsSnapshotSchema.parse({
    serverId: testUuid(900),
    jobs: [queuedJob, downloadingJob, doneJob, failedJob],
    batches: [batch],
    queue: { platforms: [] },
    ...changes,
  })
}

/** The server's settings with the defaults and a recent folder. */
export const settings: Settings = SettingsSchema.parse({
  folder: '/Users/dj/Music/DJ Scraper',
  recentFolders: ['/Users/dj/Music/DJ Scraper', '/Volumes/USB'],
  format: 'mp3',
  filenameTemplate: '{artist} - {title}',
  embedArtwork: true,
  sourceUrlComment: true,
  playlistSubfolder: false,
  concurrency: 3,
  autoDownloadSingles: true,
})

/**
 * Feeds `['downloads']` the way the app does: startEvents (main.tsx) over a FakeEventSource, opened
 * and sent `snapshot`. `send` delivers one more event and waits, inside act(), until TanStack Query
 * has told React (it notifies on a 0 ms timer; fake timers are advanced instead). The stream stops
 * when the test finishes. Call it after rendering, with the render's QueryClient.
 */
export async function liveDownloads(
  queryClient: QueryClient,
  snapshot: DownloadsSnapshot = snapshotWith(),
) {
  const es = fakeEventSource()
  const flush = () =>
    vi.isFakeTimers()
      ? vi.advanceTimersByTimeAsync(0)
      : new Promise<void>((resolve) => setTimeout(resolve, 0))
  const send = (event: ServerEvent) =>
    act(async () => {
      es.current.send(event)
      await flush()
    })
  let stop = () => {}
  await act(async () => {
    stop = startEvents(queryClient)
    es.current.open()
    await flush()
  })
  onTestFinished(() => stop())
  await send({ type: 'snapshot', ...snapshot })
  return { es, send }
}
