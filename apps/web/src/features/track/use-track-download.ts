import type { Track } from '@dj-scraper/shared'
import { useCallback } from 'react'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { useCreateDownloads } from '@/features/downloads/use-create-downloads.ts'

/** The track card's download, shared by its source line and its status below. */
export type TrackDownloadState = ReturnType<typeof useTrackDownload>

/**
 * Queues `track` as a single-track batch when `start` is called: Download (or ⌘D), "Try again",
 * "Download again". Nothing queues by itself (ADR-031).
 */
export function useTrackDownload(track: Track) {
  const { mutate, data, error, status } = useCreateDownloads()

  const start = useCallback(() => {
    mutate({ items: [toTrackRef(track)], label: track.title })
  }, [mutate, track])

  return {
    /** The job the server made (or mapped a duplicate to), once it answered. */
    jobId: data?.jobIds[0],
    start,
    status,
    error,
  }
}
