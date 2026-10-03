import { type Job, JobSchema } from '@dj-scraper/shared'
import { jobsByStatus } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { jobChip } from './job-chip.ts'

const job = (status: keyof typeof jobsByStatus): Job => JobSchema.parse(jobsByStatus[status])

const now = Date.parse('2026-10-02T08:00:10.000Z')

describe('jobChip', () => {
  it('names each status in a word', () => {
    expect(jobChip(job('queued'), now)).toMatchObject({ label: 'Queued', tone: 'muted' })
    expect(jobChip(job('processing'), now)).toMatchObject({ label: 'Converting', tone: 'active' })
    expect(jobChip(job('done'), now)).toMatchObject({ label: 'Done', tone: 'success' })
    expect(jobChip(job('skipped'), now)).toMatchObject({ label: 'In folder', tone: 'muted' })
    expect(jobChip(job('canceled'), now)).toMatchObject({ label: 'Canceled', tone: 'muted' })
  })

  it('shows a download in whole percent', () => {
    expect(jobChip(job('downloading'), now)).toEqual({
      label: '42 %',
      tone: 'active',
      detail: 'Downloading: 42 %',
    })
  })

  it('says starting before the first progress', () => {
    const { progress: _progress, ...starting } = jobsByStatus.downloading
    expect(jobChip(JobSchema.parse(starting), now).label).toBe('Starting')
  })

  it('says waiting while the site makes yt-dlp wait, and not after', () => {
    const waiting = JobSchema.parse({
      ...jobsByStatus.downloading,
      progress: { waitingUntil: '2026-10-02T08:00:30.000Z' },
    })
    expect(jobChip(waiting, now).label).toBe('Waiting')
    expect(jobChip(waiting, Date.parse('2026-10-02T08:00:31.000Z')).label).toBe('Starting')
  })

  it('gives the failure message as the detail', () => {
    expect(jobChip(job('failed'), now)).toEqual({
      label: 'Failed',
      tone: 'error',
      detail: 'The connection dropped. Retry to try again.',
    })
  })

  it('says canceling once a cancel is asked of a running job', () => {
    const canceling = JobSchema.parse({ ...jobsByStatus.downloading, cancelRequested: true })
    expect(jobChip(canceling, now).label).toBe('Canceling')
    const processing = JobSchema.parse({ ...jobsByStatus.processing, cancelRequested: true })
    expect(jobChip(processing, now).label).toBe('Canceling')
  })
})
