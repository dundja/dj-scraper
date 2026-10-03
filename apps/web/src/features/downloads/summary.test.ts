import type { Job } from '@dj-scraper/shared'
import { jobsByStatus, testUuid } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { doneJob, downloadingJob, failedJob, jobWith, queuedJob } from '@/test/downloads.ts'
import {
  combineSummaries,
  DOWNLOAD_SHARE,
  emptySummary,
  fractionDone,
  jobProgress,
  percentDone,
  summarizeJobs,
} from './summary.ts'

const finishedAt = '2026-10-02T08:01:00.000Z'
const processingJob = jobWith({ id: testUuid(10), status: 'processing' })
const skippedJob = jobWith({
  id: testUuid(11),
  status: 'skipped',
  outputPath: jobsByStatus.skipped.outputPath,
  finishedAt,
})
const canceledJob = jobWith({ id: testUuid(12), status: 'canceled', finishedAt })
/** A failure retrying can't fix. */
const privateJob = jobWith({
  id: testUuid(13),
  status: 'failed',
  error: { code: 'private', message: 'This video is private.' },
  finishedAt,
})

const downloadingAt = (n: number, progress: Record<string, unknown> | undefined): Job =>
  jobWith({ id: testUuid(n), status: 'downloading', ...(progress && { progress }) })

describe('jobProgress', () => {
  it('is 0 for a queued job and 1 for every finished one, failures included', () => {
    expect(jobProgress(queuedJob)).toBe(0)
    for (const job of [doneJob, skippedJob, failedJob, canceledJob, privateJob]) {
      expect(jobProgress(job), job.status).toBe(1)
    }
  })

  it('scales a download to its share of the job, leaving the rest to processing', () => {
    expect(jobProgress(downloadingJob)).toBeCloseTo(DOWNLOAD_SHARE * 0.425)
    expect(jobProgress(downloadingAt(20, { percent: 100 }))).toBe(DOWNLOAD_SHARE)
    expect(jobProgress(processingJob)).toBe(DOWNLOAD_SHARE)
  })

  it('is 0 for a download without a percent: starting, or waiting for the site', () => {
    expect(jobProgress(downloadingAt(21, undefined))).toBe(0)
    expect(jobProgress(downloadingAt(22, { waitingUntil: '2026-10-02T08:05:00.000Z' }))).toBe(0)
    expect(jobProgress(downloadingAt(23, { downloadedBytes: 1000 }))).toBe(0)
  })
})

describe('summarizeJobs', () => {
  it('counts every status, what is still at work and what has finished', () => {
    const summary = summarizeJobs([
      queuedJob,
      downloadingJob,
      processingJob,
      doneJob,
      skippedJob,
      failedJob,
      canceledJob,
      privateJob,
    ])
    expect(summary).toMatchObject({
      total: 8,
      counts: {
        queued: 1,
        downloading: 1,
        processing: 1,
        done: 1,
        skipped: 1,
        failed: 2,
        canceled: 1,
      },
      active: 3,
      finished: 5,
    })
  })

  it('counts only the failures a retry can fix as retryable', () => {
    // failedJob dropped its connection (network); privateJob is private, which a retry won't change.
    expect(summarizeJobs([failedJob, privateJob, canceledJob]).retryableFailed).toBe(1)
    expect(summarizeJobs([privateJob]).retryableFailed).toBe(0)
  })

  it('adds up each job progress', () => {
    const summary = summarizeJobs([queuedJob, downloadingJob, processingJob, doneJob])
    expect(summary.progress).toBeCloseTo(0 + DOWNLOAD_SHARE * 0.425 + DOWNLOAD_SHARE + 1)
  })

  it('is the empty summary for no jobs, and takes any iterable', () => {
    expect(summarizeJobs([])).toEqual(emptySummary())
    const jobs = new Map([[doneJob.id, doneJob]])
    expect(summarizeJobs(jobs.values()).total).toBe(1)
  })
})

describe('combineSummaries', () => {
  it('equals the summary of all the jobs together', () => {
    const first = [queuedJob, downloadingJob, failedJob]
    const second = [doneJob, privateJob, processingJob, canceledJob]
    const { progress, ...combined } = combineSummaries([
      summarizeJobs(first),
      summarizeJobs(second),
    ])
    const { progress: expectedProgress, ...expected } = summarizeJobs([...first, ...second])
    expect(combined).toEqual(expected)
    // Floating-point sums in another order may differ in the last digit.
    expect(progress).toBeCloseTo(expectedProgress)
  })

  it('is the empty summary for none', () => {
    expect(combineSummaries([])).toEqual(emptySummary())
  })

  it('leaves the summaries it adds up alone', () => {
    const summary = summarizeJobs([doneJob])
    combineSummaries([summary, summary])
    expect(summary).toEqual(summarizeJobs([doneJob]))
  })
})

describe('fractionDone and percentDone', () => {
  it('are 0 for no jobs', () => {
    expect(fractionDone(emptySummary())).toBe(0)
    expect(percentDone(emptySummary())).toBe(0)
  })

  it('average the jobs, rounding the percent down', () => {
    // (0 + 0.3825 + 0.9 + 1) / 4 = 0.570625
    const summary = summarizeJobs([queuedJob, downloadingJob, processingJob, doneJob])
    expect(fractionDone(summary)).toBeCloseTo(0.570625)
    expect(percentDone(summary)).toBe(57)
  })

  it('say 100 % only once every job has finished', () => {
    const finished = Array.from({ length: 999 }, (_, i) =>
      jobWith({ id: testUuid(1000 + i), status: 'canceled', finishedAt }),
    )
    const almost = summarizeJobs([...finished, downloadingAt(30, { percent: 99.9 })])
    expect(fractionDone(almost)).toBeGreaterThan(0.999)
    expect(percentDone(almost)).toBe(99)

    expect(percentDone(summarizeJobs(finished))).toBe(100)
    expect(fractionDone(summarizeJobs(finished))).toBe(1)
  })
})
