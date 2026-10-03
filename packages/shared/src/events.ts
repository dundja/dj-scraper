import * as z from 'zod'
import {
  BatchSchema,
  DownloadsSnapshotSchema,
  JobProgressSchema,
  JobSchema,
  QueueStateSchema,
} from './download.ts'

/** Sent as the stream's first line: the browser reconnects this fast after a drop. */
export const SSE_RETRY_MS = 1000

/** A `heartbeat` event at least this often, so the client can tell a dead stream from a quiet one. */
export const SSE_HEARTBEAT_MS = 15_000

/**
 * `GET /api/events`: one JSON object per SSE `data:` line. Every connection starts with a `snapshot`;
 * the events after it apply in order on top of it. Updates for jobs the client doesn't know are
 * ignored (it resyncs from the next snapshot).
 */
export const ServerEventSchema = z.discriminatedUnion('type', [
  DownloadsSnapshotSchema.extend({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('jobs.added'), batch: BatchSchema, jobs: z.array(JobSchema).min(1) }),
  /** Status changes and final metadata; one event for a bulk action. */
  z.object({ type: z.literal('jobs.updated'), jobs: z.array(JobSchema).min(1) }),
  /** Cleared or evicted jobs, and the batches left without jobs. */
  z.object({
    type: z.literal('jobs.removed'),
    ids: z.array(z.uuid()),
    batchIds: z.array(z.uuid()),
  }),
  /** Progress of a downloading job, at most about twice a second. */
  z.object({ type: z.literal('job.progress'), jobId: z.uuid(), progress: JobProgressSchema }),
  z.object({ type: z.literal('queue.updated'), queue: QueueStateSchema }),
  z.object({ type: z.literal('heartbeat') }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
