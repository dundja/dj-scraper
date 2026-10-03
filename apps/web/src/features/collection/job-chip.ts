import type { Job } from '@dj-scraper/shared'

/** A row's download status at a glance; the downloads panel has the details. */
export type JobChip = {
  label: string
  tone: 'muted' | 'active' | 'success' | 'error'
  /** A longer text for the tooltip (`title`), e.g. the failure's message. */
  detail: string
}

/**
 * The chip for the newest job of a row's track: "Queued", "42 %", "Done", "Failed"… `now` decides
 * whether a YouTube wait is still on.
 */
export function jobChip(job: Job, now: number = Date.now()): JobChip {
  if (job.cancelRequested && (job.status === 'downloading' || job.status === 'processing')) {
    return { label: 'Canceling', tone: 'muted', detail: 'Canceling the download…' }
  }
  switch (job.status) {
    case 'queued':
      return { label: 'Queued', tone: 'muted', detail: 'Queued for download' }
    case 'downloading': {
      const waitingUntil = job.progress?.waitingUntil
      if (waitingUntil !== undefined && Date.parse(waitingUntil) > now) {
        return { label: 'Waiting', tone: 'active', detail: 'Waiting: the site asks to wait first' }
      }
      const percent = job.progress?.percent
      if (percent === undefined) {
        return { label: 'Starting', tone: 'active', detail: 'Starting the download…' }
      }
      const shown = `${Math.floor(percent)} %`
      return { label: shown, tone: 'active', detail: `Downloading: ${shown}` }
    }
    case 'processing':
      return { label: 'Converting', tone: 'active', detail: 'Converting and tagging…' }
    case 'done':
      return { label: 'Done', tone: 'success', detail: 'Downloaded' }
    case 'skipped':
      return { label: 'In folder', tone: 'muted', detail: 'Already in the folder: kept as it was' }
    case 'failed':
      return { label: 'Failed', tone: 'error', detail: job.error.message }
    case 'canceled':
      return { label: 'Canceled', tone: 'muted', detail: 'Download canceled' }
  }
}
