import type { Job, QueueState } from '@dj-scraper/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { type DownloadsState, downloadsQueryOptions } from '@/lib/events.ts'
import { type TrackKey, trackKey } from './track-ref.ts'

// Readers of `['downloads']`. The event stream (lib/events.ts) is its only writer, and these hooks
// never fetch: `downloadsQueryOptions` has no query function. Each select keeps its result's
// identity while what it picks is unchanged, so a progress event re-renders only its job's readers.

/** The whole downloads state: `data` is undefined only before the event stream has started. */
export function useDownloads() {
  return useQuery(downloadsQueryOptions)
}

/** One job, or undefined until `jobs.added` brings it (or after it was cleared). */
export function useJob(id: string | undefined): Job | undefined {
  const select = useCallback(
    (state: DownloadsState) =>
      id !== undefined && Object.hasOwn(state.byId, id) ? state.byId[id] : undefined,
    [id],
  )
  return useQuery({ ...downloadsQueryOptions, select }).data
}

const selectQueue = (state: DownloadsState): QueueState | undefined => state.queue

/** What the queue holds back (paused and paced platforms), undefined before the first snapshot. */
export function useQueue(): QueueState | undefined {
  return useQuery({ ...downloadsQueryOptions, select: selectQueue }).data
}

/** The newest job id of each track, by `trackKey`: what `useJobIdsByTrack` returns. */
export type JobIdsByTrack = ReadonlyMap<TrackKey, string>

const NO_JOBS: JobIdsByTrack = new Map()

// The newest job id of each track depends only on `order`: a job's track never changes, and the
// stream makes a new `order` whenever jobs come or go. So the index is built once per `order`, and
// a progress event (a new `byId`, the same `order`) or a queue update keeps the same map.
const indexes = new WeakMap<readonly string[], JobIdsByTrack>()

function newestJobIdByTrack(state: DownloadsState): JobIdsByTrack {
  const cached = indexes.get(state.order)
  if (cached !== undefined) return cached
  const index = new Map<TrackKey, string>()
  for (const id of state.order) {
    const job = state.byId[id]
    if (job !== undefined) index.set(trackKey(job.track), id)
  }
  indexes.set(state.order, index)
  return index
}

/**
 * The newest job id of each track (by `trackKey`), e.g. for a status chip on a collection row,
 * which reads the job itself with `useJob`. A track can have several jobs (another folder or
 * format); the last one created wins. The same map until jobs come or go, so a job's progress
 * re-renders only the readers of that job, never the list that looks its id up.
 */
export function useJobIdsByTrack(): JobIdsByTrack {
  // A Map, so the select's structural sharing keeps it by identity and doesn't walk it.
  return useQuery({ ...downloadsQueryOptions, select: newestJobIdByTrack }).data ?? NO_JOBS
}
