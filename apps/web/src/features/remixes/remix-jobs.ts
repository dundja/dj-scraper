import type { RemixUpload } from '@dj-scraper/shared'
import { useSyncExternalStore } from 'react'
import { type TrackKey, trackKey } from '@/features/downloads/track-ref.ts'

/** The job each downloaded upload got, by `trackKey`, oldest first. */
export type RemixJobs = ReadonlyMap<TrackKey, string>

/**
 * The jobs a remix section's downloads made, as a small store the section creates once. Held above
 * the rows: a row remounts when the genre filter hides it, or when the full answer replaces the
 * quick one and its default upload changes, and its job must still show. The now-playing bar,
 * outside the section, records its Download here too (the preview player holds the store of the
 * section that started the upload), so the row shows that job as its own.
 */
export type RemixJobsStore = {
  get: () => RemixJobs
  subscribe: (listener: () => void) => () => void
  remember: (upload: RemixUpload, jobId: string) => void
}

export function createRemixJobs(): RemixJobsStore {
  let jobs: RemixJobs = new Map()
  const listeners = new Set<() => void>()
  return {
    get: () => jobs,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    remember(upload, jobId) {
      jobs = rememberJob(jobs, upload, jobId)
      for (const listener of listeners) listener()
    },
  }
}

/**
 * The job of the upload among `uploads` downloaded last, read from `store`: a string, so a row
 * re-renders only when its own job changes.
 */
export function useRemixJobId(
  store: RemixJobsStore,
  uploads: readonly RemixUpload[],
): string | undefined {
  const snapshot = () => latestJobId(store.get(), uploads)
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

/** `jobs` with `upload`'s job last (its newest). */
export function rememberJob(jobs: RemixJobs, upload: RemixUpload, jobId: string): RemixJobs {
  const key = trackKey(upload)
  const next = new Map(jobs)
  next.delete(key)
  next.set(key, jobId)
  return next
}

/** The job of the upload among `uploads` downloaded last, if any was. */
export function latestJobId(jobs: RemixJobs, uploads: readonly RemixUpload[]): string | undefined {
  const keys = new Set(uploads.map(trackKey))
  let latest: string | undefined
  for (const [key, jobId] of jobs) if (keys.has(key)) latest = jobId
  return latest
}
