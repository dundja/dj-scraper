import { isRetryableError, type Job, type JobStatus } from '@dj-scraper/shared'

// Pure numbers for the downloads panel: counts by status and progress over many jobs.

export type StatusCounts = Record<JobStatus, number>

export type JobsSummary = {
  total: number
  counts: StatusCounts
  /** Queued, downloading or processing: what "Cancel all" can still stop. */
  active: number
  /** Done, skipped, failed or canceled: what "Clear finished" removes. */
  finished: number
  /** Failed jobs that "Retry failed" queues again (the server skips failures a retry can't fix). */
  retryableFailed: number
  /** The sum of each job's `jobProgress`, so summaries add up; see `fractionDone`. */
  progress: number
}

/**
 * The share of a job's progress that downloading stands for. Converting and tagging is quick next
 * to the download, and reports no percent, so it gets the rest.
 */
export const DOWNLOAD_SHARE = 0.9

/**
 * How far one job has come, from 0 to 1, for a progress bar over many jobs:
 * - queued: 0;
 * - downloading: its percent scaled to 0–0.9, or 0 before the first progress event and while the
 *   site makes it wait;
 * - processing: 0.9;
 * - done, skipped, failed and canceled: 1. A failed job counts as finished too: the bar measures
 *   what is left to wait for, and the counts say how it went.
 */
export function jobProgress(job: Job): number {
  switch (job.status) {
    case 'queued':
      return 0
    case 'downloading': {
      const percent = job.progress?.percent ?? 0
      return (DOWNLOAD_SHARE * Math.min(100, Math.max(0, percent))) / 100
    }
    case 'processing':
      return DOWNLOAD_SHARE
    case 'done':
    case 'skipped':
    case 'failed':
    case 'canceled':
      return 1
  }
}

const emptyCounts = (): StatusCounts => ({
  queued: 0,
  downloading: 0,
  processing: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  canceled: 0,
})

/** The summary of no jobs. */
export function emptySummary(): JobsSummary {
  return {
    total: 0,
    counts: emptyCounts(),
    active: 0,
    finished: 0,
    retryableFailed: 0,
    progress: 0,
  }
}

/** Counts and progress of `jobs`, in one pass. */
export function summarizeJobs(jobs: Iterable<Job>): JobsSummary {
  const summary = emptySummary()
  for (const job of jobs) {
    summary.total++
    summary.counts[job.status]++
    summary.progress += jobProgress(job)
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'processing') {
      summary.active++
    } else {
      summary.finished++
    }
    if (job.status === 'failed' && isRetryableError(job.error.code)) summary.retryableFailed++
  }
  return summary
}

/** The summary of all the jobs behind `summaries` (e.g. several batches). */
export function combineSummaries(summaries: Iterable<JobsSummary>): JobsSummary {
  const combined = emptySummary()
  for (const summary of summaries) {
    combined.total += summary.total
    combined.active += summary.active
    combined.finished += summary.finished
    combined.retryableFailed += summary.retryableFailed
    combined.progress += summary.progress
    for (const status of Object.keys(combined.counts) as JobStatus[]) {
      combined.counts[status] += summary.counts[status]
    }
  }
  return combined
}

/** How far the jobs have come together, from 0 to 1; 0 for no jobs. */
export function fractionDone(summary: JobsSummary): number {
  if (summary.total === 0) return 0
  return Math.min(1, summary.progress / summary.total)
}

/**
 * Whole percent done, rounded down so 100 % means every job has finished (never 99.6 shown as
 * 100). Exact sums of finished jobs (1 each) make the last step land on 100.
 */
export function percentDone(summary: JobsSummary): number {
  if (summary.finished === summary.total) return summary.total === 0 ? 0 : 100
  return Math.min(99, Math.floor(fractionDone(summary) * 100))
}
