import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { Batch, DownloadsSnapshot, Job, JobProgress, QueueState } from './download.ts'
import { type ServerEvent, ServerEventSchema, SSE_HEARTBEAT_MS, SSE_RETRY_MS } from './events.ts'
import { issuePaths, jobsByStatus, testBatch, testUuid, without } from './test-helpers.ts'

const pausedQueue = {
  platforms: [
    { platform: 'youtube', pausedUntil: '2026-10-02T08:10:00.000Z', pauseCode: 'rate_limited' },
  ],
} satisfies QueueState

const snapshotEvent = {
  type: 'snapshot',
  serverId: testUuid(900),
  jobs: Object.values(jobsByStatus),
  batches: [testBatch],
  queue: pausedQueue,
} satisfies ServerEvent

const addedEvent = {
  type: 'jobs.added',
  batch: testBatch,
  jobs: [jobsByStatus.queued, jobsByStatus.failed],
} satisfies ServerEvent

const updatedEvent = {
  type: 'jobs.updated',
  jobs: [jobsByStatus.done, jobsByStatus.canceled],
} satisfies ServerEvent

const removedEvent = {
  type: 'jobs.removed',
  ids: [jobsByStatus.done.id, jobsByStatus.skipped.id],
  batchIds: [testBatch.id],
} satisfies ServerEvent

const progressEvent = {
  type: 'job.progress',
  jobId: jobsByStatus.downloading.id,
  progress: jobsByStatus.downloading.progress,
} satisfies ServerEvent

const queueEvent = { type: 'queue.updated', queue: pausedQueue } satisfies ServerEvent

const heartbeatEvent = { type: 'heartbeat' } satisfies ServerEvent

/** One valid event of every type. */
const events = [
  ['a snapshot with a job in every status', snapshotEvent],
  ['jobs added by a new batch', addedEvent],
  ['jobs updated by a bulk action', updatedEvent],
  ['cleared jobs and their emptied batch', removedEvent],
  ['progress of a downloading job', progressEvent],
  ['a paused platform', queueEvent],
  ['a heartbeat', heartbeatEvent],
] as const

describe('SSE timing', () => {
  it('asks the browser to reconnect after one second', () => {
    expect(SSE_RETRY_MS).toBe(1000)
  })

  it('beats every 15 seconds so the client can tell a dead stream from a quiet one', () => {
    expect(SSE_HEARTBEAT_MS).toBe(15_000)
  })
})

describe('ServerEventSchema', () => {
  it.each(events)('parses %s unchanged', (_label, event) => {
    expect(ServerEventSchema.parse(event)).toStrictEqual(event)
  })

  it('covers every event type with an example', () => {
    const types = events.map(([, event]) => event.type)
    expect(new Set(types)).toEqual(
      new Set(ServerEventSchema.options.map((option) => option.shape.type.value)),
    )
  })

  it.each([
    ['an unknown type', { type: 'ping' }],
    ['a singular job.updated', { type: 'job.updated', jobs: [jobsByStatus.done] }],
    ['a capitalised type', { ...snapshotEvent, type: 'Snapshot' }],
    ['a missing type', without(snapshotEvent, 'type')],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(ServerEventSchema, input)).toEqual([['type']])
  })

  it('rejects jobs.updated without jobs: nothing changed means no event', () => {
    expect(issuePaths(ServerEventSchema, { type: 'jobs.updated', jobs: [] })).toEqual([['jobs']])
  })

  it.each([
    ['a snapshot without serverId', without(snapshotEvent, 'serverId'), ['serverId']],
    ['a snapshot without its queue', without(snapshotEvent, 'queue'), ['queue']],
    ['jobs.added without its batch', without(addedEvent, 'batch'), ['batch']],
    [
      'jobs.added with a job in an unknown status',
      { ...addedEvent, jobs: [{ ...jobsByStatus.queued, status: 'waiting' }] },
      ['jobs', 0, 'status'],
    ],
    [
      'jobs.updated with a done job missing its output',
      { ...updatedEvent, jobs: [without(jobsByStatus.done, 'output')] },
      ['jobs', 0, 'output'],
    ],
    [
      'jobs.removed with an id that is not a UUID',
      { ...removedEvent, ids: [testUuid(4), 'job-5'] },
      ['ids', 1],
    ],
    ['jobs.removed without batchIds', without(removedEvent, 'batchIds'), ['batchIds']],
    [
      'job.progress for a job id that is not a UUID',
      { ...progressEvent, jobId: 'job-2' },
      ['jobId'],
    ],
    ['job.progress without progress', without(progressEvent, 'progress'), ['progress']],
    [
      'job.progress over 100 percent',
      { ...progressEvent, progress: { percent: 100.5 } },
      ['progress', 'percent'],
    ],
    [
      'queue.updated with a pause code that is not a platform limit',
      {
        type: 'queue.updated',
        queue: { platforms: [{ platform: 'youtube', pauseCode: 'network' }] },
      },
      ['queue', 'platforms', 0, 'pauseCode'],
    ],
  ])('rejects %s', (_label, input, path) => {
    expect(issuePaths(ServerEventSchema, input)).toEqual([path])
  })

  it.each([
    ['jobs.removed that removes no batch', { ...removedEvent, batchIds: [] }],
    ['job.progress before yt-dlp knows any number', { ...progressEvent, progress: {} }],
  ])('accepts %s', (_label, event) => {
    expect(ServerEventSchema.parse(event)).toStrictEqual(event)
  })

  it('strips keys another event type carries instead of rejecting them', () => {
    const input = { ...heartbeatEvent, jobs: [jobsByStatus.done], serverId: testUuid(900) }
    expect(ServerEventSchema.parse(input)).toStrictEqual(heartbeatEvent)
  })

  it.each(events)(
    're-parses %s equal after a JSON round-trip, as an SSE data line',
    (_l, event) => {
      const parsed = ServerEventSchema.parse(event)
      expect(ServerEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toStrictEqual(parsed)
    },
  )

  it('discriminates on type', () => {
    expectTypeOf<ServerEvent['type']>().toEqualTypeOf<
      | 'snapshot'
      | 'jobs.added'
      | 'jobs.updated'
      | 'jobs.removed'
      | 'job.progress'
      | 'queue.updated'
      | 'heartbeat'
    >()
  })

  it('carries the contract types in every payload', () => {
    type EventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>
    expectTypeOf<Omit<EventOf<'snapshot'>, 'type'>>().toEqualTypeOf<DownloadsSnapshot>()
    expectTypeOf<EventOf<'snapshot'>['type']>().toEqualTypeOf<'snapshot'>()
    expectTypeOf<EventOf<'jobs.added'>>().toEqualTypeOf<{
      type: 'jobs.added'
      batch: Batch
      jobs: Job[]
    }>()
    expectTypeOf<EventOf<'jobs.updated'>>().toEqualTypeOf<{ type: 'jobs.updated'; jobs: Job[] }>()
    expectTypeOf<EventOf<'jobs.removed'>>().toEqualTypeOf<{
      type: 'jobs.removed'
      ids: string[]
      batchIds: string[]
    }>()
    expectTypeOf<EventOf<'job.progress'>>().toEqualTypeOf<{
      type: 'job.progress'
      jobId: string
      progress: JobProgress
    }>()
    expectTypeOf<EventOf<'queue.updated'>>().toEqualTypeOf<{
      type: 'queue.updated'
      queue: QueueState
    }>()
    expectTypeOf<EventOf<'heartbeat'>>().toEqualTypeOf<{ type: 'heartbeat' }>()
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof ServerEventSchema>>().toEqualTypeOf<ServerEvent>()
  })
})
