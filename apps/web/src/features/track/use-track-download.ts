import type { Track } from '@dj-scraper/shared'
import { useCallback, useEffect, useRef } from 'react'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { useCreateDownloads } from '@/features/downloads/use-create-downloads.ts'

/** The track card's download, shared by its source line and its status below. */
export type TrackDownloadState = ReturnType<typeof useTrackDownload>

/**
 * Queues `track` as a single-track batch. With `autoStart` it does so once on mount (StrictMode
 * runs effects twice; a ref keeps that to one request), unless the track is unavailable. `start`
 * queues it (again): the Download button, "Try again", "Download again".
 */
export function useTrackDownload(track: Track, autoStart: boolean) {
  const { mutate, data, error, status } = useCreateDownloads()
  const started = useRef(false)
  const downloadable = track.availability !== 'unavailable'

  const start = useCallback(() => {
    started.current = true
    mutate({ items: [toTrackRef(track)], label: track.title })
  }, [mutate, track])

  useEffect(() => {
    if (autoStart && downloadable && !started.current) start()
  }, [autoStart, downloadable, start])

  return {
    /** The job the server made (or mapped a duplicate to), once it answered. */
    jobId: data?.jobIds[0],
    start,
    status,
    error,
    autoStart,
  }
}
