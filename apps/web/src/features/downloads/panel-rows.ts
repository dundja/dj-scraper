import type { Batch, Job } from '@dj-scraper/shared'
import type { DownloadsState } from '@/lib/events.ts'
import { type JobsSummary, summarizeJobs } from './summary.ts'

/** One batch of the downloads panel: its jobs in creation order and their summary. */
export type BatchGroup = { batch: Batch; jobs: Job[]; summary: JobsSummary }

/**
 * The jobs grouped by batch, newest batch first. A batch's jobs all arrive in one `jobs.added`,
 * so `order` (job creation order) also orders the batches: by their first job.
 * - A batch without jobs left (the stream removes those too) is left out.
 * - A job whose batch the stream never sent still shows, under a batch made from the job.
 */
export function groupByBatch(
  state: Pick<DownloadsState, 'order' | 'byId' | 'batches'>,
): BatchGroup[] {
  const groups = new Map<string, { batch: Batch; jobs: Job[] }>()
  for (const id of state.order) {
    const job = state.byId[id]
    if (job === undefined) continue
    let group = groups.get(job.batchId)
    if (group === undefined) {
      const batch = Object.hasOwn(state.batches, job.batchId)
        ? state.batches[job.batchId]
        : undefined
      group = { batch: batch ?? batchOf(job), jobs: [] }
      groups.set(job.batchId, group)
    }
    group.jobs.push(job)
  }
  const newestFirst: BatchGroup[] = []
  for (const { batch, jobs } of groups.values()) {
    newestFirst.push({ batch, jobs, summary: summarizeJobs(jobs) })
  }
  return newestFirst.reverse()
}

function batchOf(job: Job): Batch {
  return { id: job.batchId, folder: job.folder, format: job.format, createdAt: job.createdAt }
}

/** A row of the panel's one virtualized list: a batch's header, or one of its jobs. */
export type PanelRow =
  | { kind: 'batch'; key: string; group: BatchGroup }
  | { kind: 'job'; key: string; job: Job }

/** Each batch's header row followed by its job rows, keyed by id so rows survive reordering. */
export function panelRows(groups: readonly BatchGroup[]): PanelRow[] {
  const rows: PanelRow[] = []
  for (const group of groups) {
    rows.push({ kind: 'batch', key: `batch:${group.batch.id}`, group })
    for (const job of group.jobs) rows.push({ kind: 'job', key: `job:${job.id}`, job })
  }
  return rows
}

/** The height of a batch's header row in the virtualized list, in px. */
export const BATCH_ROW_HEIGHT = 56
