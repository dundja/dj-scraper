import { type Batch, BatchSchema, type Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { describe, expect, it } from 'vitest'
import { batch, jobWith } from '@/test/downloads.ts'
import { groupByBatch, panelRows } from './panel-rows.ts'
import { summarizeJobs } from './summary.ts'

const later: Batch = BatchSchema.parse({
  id: testUuid(101),
  label: 'Warm-up set',
  folder: '/Volumes/USB/Warm-up set',
  format: 'aiff',
  createdAt: '2026-10-02T09:00:00.000Z',
})
const latest: Batch = BatchSchema.parse({
  id: testUuid(102),
  folder: '/Users/dj/Music/DJ Scraper',
  format: 'mp3',
  createdAt: '2026-10-02T10:00:00.000Z',
})

const queued = (n: number, inBatch: Batch) =>
  jobWith({ id: testUuid(n), status: 'queued' }, inBatch)

/** The panel's state for `jobs` in creation order and the batches the stream sent. */
function stateOf(jobs: Job[], batches: Batch[] = [batch, later, latest]) {
  return {
    order: jobs.map((job) => job.id),
    byId: Object.fromEntries(jobs.map((job) => [job.id, job])),
    batches: Object.fromEntries(batches.map((b) => [b.id, b])),
  }
}

describe('groupByBatch', () => {
  it('lists the newest batch first, each with its jobs in creation order', () => {
    const jobs = [queued(1, batch), queued(2, batch), queued(3, later), queued(4, latest)]
    const groups = groupByBatch(stateOf(jobs))

    expect(groups.map((group) => group.batch)).toEqual([latest, later, batch])
    expect(groups.map((group) => group.jobs.map((job) => job.id))).toEqual([
      [testUuid(4)],
      [testUuid(3)],
      [testUuid(1), testUuid(2)],
    ])
  })

  it('summarizes each batch on its own', () => {
    const done = jobWith(
      {
        id: testUuid(5),
        status: 'canceled',
        finishedAt: '2026-10-02T09:01:00.000Z',
      },
      later,
    )
    const jobs = [queued(1, batch), queued(3, later), done]
    const [laterGroup, firstGroup] = groupByBatch(stateOf(jobs))

    expect(laterGroup?.summary).toEqual(summarizeJobs([jobs[1] as Job, done]))
    expect(firstGroup?.summary).toEqual(summarizeJobs([jobs[0] as Job]))
  })

  it('leaves out batches without jobs and ids without a job', () => {
    const jobs = [queued(1, batch)]
    const state = stateOf(jobs)
    const groups = groupByBatch({ ...state, order: [testUuid(99), ...state.order] })

    expect(groups.map((group) => group.batch.id)).toEqual([batch.id])
  })

  it('shows a job whose batch never arrived under a batch made from the job', () => {
    const orphan = queued(6, latest)
    const [group] = groupByBatch(stateOf([orphan], [batch]))

    expect(group?.batch).toEqual({
      id: latest.id,
      folder: orphan.folder,
      format: orphan.format,
      createdAt: orphan.createdAt,
    })
    expect(group?.jobs).toEqual([orphan])
  })

  it('is empty for no jobs', () => {
    expect(groupByBatch(stateOf([]))).toEqual([])
  })
})

describe('panelRows', () => {
  it("puts each batch's header before its jobs, keyed by id", () => {
    const jobs = [queued(1, batch), queued(2, batch), queued(3, later)]
    const groups = groupByBatch(stateOf(jobs))
    const rows = panelRows(groups)

    expect(rows.map((row) => row.key)).toEqual([
      `batch:${later.id}`,
      `job:${testUuid(3)}`,
      `batch:${batch.id}`,
      `job:${testUuid(1)}`,
      `job:${testUuid(2)}`,
    ])
    expect(rows[0]).toEqual({ kind: 'batch', key: `batch:${later.id}`, group: groups[0] })
    expect(rows[1]).toEqual({ kind: 'job', key: `job:${testUuid(3)}`, job: jobs[2] })
  })

  it('has no rows for no batches', () => {
    expect(panelRows([])).toEqual([])
  })
})
