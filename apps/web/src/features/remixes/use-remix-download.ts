import type { RemixUpload } from '@dj-scraper/shared'
import { useCallback, useEffect } from 'react'
import { useCreateDownloads } from '@/features/downloads/use-create-downloads.ts'
import { uploadRef } from './remix-request.ts'

/** How long a row shows that adding its download failed. */
export const REMIX_ERROR_MS = 8000

/**
 * A remix row's download: `download` queues one upload as a single-track batch named after its
 * title, never by itself, and hands the job the server made (or mapped a duplicate to) to
 * `onQueued`, which keeps it above the row. A failure to add it shows for a few seconds.
 */
export function useRemixDownload(onQueued: (upload: RemixUpload, jobId: string) => void) {
  const { mutateAsync, reset, isPending, isError, error } = useCreateDownloads()

  // The promise, not mutate's own onSuccess: that one is dropped when the row unmounts before the
  // answer (the full answer can remount it), and the job must still reach the section.
  const download = useCallback(
    (upload: RemixUpload) => {
      mutateAsync({ items: [uploadRef(upload)], label: upload.title }).then(
        ({ jobIds: [jobId] }) => {
          if (jobId !== undefined) onQueued(upload, jobId)
        },
        // The mutation's state holds the error, which the row shows.
        () => {},
      )
    },
    [mutateAsync, onQueued],
  )

  useEffect(() => {
    if (!isError) return
    const timer = setTimeout(reset, REMIX_ERROR_MS)
    return () => clearTimeout(timer)
  }, [isError, reset])

  return { download, pending: isPending, error: isError ? error : null }
}
