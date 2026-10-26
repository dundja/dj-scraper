import type { RemixUpload } from '@dj-scraper/shared'
import { useCallback, useState } from 'react'
import { type TrackKey, trackKey } from '@/features/downloads/track-ref.ts'

/** The job each downloaded upload got, by `trackKey`, oldest first. */
export type RemixJobs = ReadonlyMap<TrackKey, string>

/**
 * The jobs the section's downloads made. Held above the rows: a row remounts when the genre filter
 * hides it, or when the full answer replaces the quick one and its default upload changes, and its
 * job must still show.
 */
export function useRemixJobs() {
  const [jobs, setJobs] = useState<RemixJobs>(() => new Map())
  const remember = useCallback((upload: RemixUpload, jobId: string) => {
    setJobs((previous) => rememberJob(previous, upload, jobId))
  }, [])
  return { jobs, remember }
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
