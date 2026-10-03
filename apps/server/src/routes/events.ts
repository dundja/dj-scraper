import {
  type DownloadsSnapshot,
  type ServerEvent,
  ServerEventSchema,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
} from '@dj-scraper/shared'
import { type Context, Hono } from 'hono'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import { ApiError } from '../http/errors.ts'
import type { Bus } from '../jobs/bus.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { SHUTTING_DOWN } from './downloads.ts'

/**
 * `GET /api/events` (design D11, facts sse.md): one SSE stream per browser tab.
 * - The first write is a raw `retry: 1000` (through writeSSE it would come with an empty `data:`,
 *   which browsers deliver as a message). Then the `snapshot`, taken in the same tick as the bus
 *   subscription, so no event falls between the two; then every event in order.
 * - Every write goes through one chain per stream, as the bus serialized it once for all streams.
 * - A typed `heartbeat` every 15 s: comments never reach page JS, and the client's watchdog needs it.
 * - A client that stops reading is cut off once its pending writes, the largest one aside, pass
 *   16 MiB; it resyncs from the snapshot when it reconnects. So one chunk of any size (a big
 *   snapshot, a bulk update) reaches a client that reads. At most 32 streams (each holds a browser
 *   connection anyway). HEAD gets the headers only, never a stream.
 * - Shutdown ends every stream cleanly first, so the browser (and Vite's proxy) sees the end and
 *   reconnects to the next server.
 */

export const MAX_EVENT_STREAMS = 32
export const MAX_PENDING_BYTES = 16 * 1024 * 1024
/** How long `closeAll` lets a stream flush its last writes before cutting it off. */
export const CLOSE_WAIT_MS = 1000

export type EventStreams = {
  /** The response to `GET /api/events`: a stream, or a 503 ApiError (shutting down, too many). */
  respond(c: Context): Response
  /** Open streams. */
  readonly size: number
  /** Ends every open stream cleanly and refuses new ones; resolves once their handlers are done. */
  closeAll(): Promise<void>
}

export type EventStreamsOptions = {
  bus: Pick<Bus, 'subscribe'>
  snapshot: () => DownloadsSnapshot
  maxStreams?: number
  heartbeatMs?: number
  maxPendingBytes?: number
  closeWaitMs?: number
  /** Checks each snapshot against `ServerEventSchema` (dev and tests); the bus checks the rest. */
  assertContract?: boolean
  log?: Logger
}

/** One open stream, for `closeAll`. */
type Live = {
  /** Ends it cleanly (bounded by closeWaitMs); then the handler cleans up. */
  end(): Promise<void>
  /** Resolves once its handler has unsubscribed and stopped its heartbeat. */
  readonly done: Promise<void>
}

const RETRY_CHUNK = `retry: ${SSE_RETRY_MS}\n\n`
const HEARTBEAT_JSON = JSON.stringify({ type: 'heartbeat' } satisfies ServerEvent)
/** JSON.stringify never emits a raw line break, so one `data:` line carries the whole event. */
const dataChunk = (json: string) => `data: ${json}\n\n`

export function createEventStreams({
  bus,
  snapshot,
  maxStreams = MAX_EVENT_STREAMS,
  heartbeatMs = SSE_HEARTBEAT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
  closeWaitMs = CLOSE_WAIT_MS,
  assertContract = false,
  log = console,
}: EventStreamsOptions): EventStreams {
  const live = new Set<Live>()
  let closing = false

  function snapshotJson(): string {
    const event: ServerEvent = { type: 'snapshot', ...snapshot() }
    if (assertContract) ServerEventSchema.parse(event)
    return JSON.stringify(event)
  }

  /** The stream's handler: runs synchronously up to its first await, inside streamSSE. */
  async function serve(stream: SSEStreamingApi, snapshotEvent: string): Promise<void> {
    const ended = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    let finished = false
    const finish = (): void => {
      finished = true
      ended.resolve()
    }
    // First: a listener registered after the client went away never fires (sse.md §1).
    stream.onAbort(finish)

    let tail: Promise<unknown> = Promise.resolve()
    let pending = 0
    /** Sizes of the queued chunks that may still be the largest one, largest first. */
    const largest: number[] = []
    const write = (chunk: string): void => {
      if (finished) return
      const bytes = Buffer.byteLength(chunk)
      pending += bytes
      while ((largest.at(-1) ?? bytes) < bytes) largest.pop()
      largest.push(bytes)
      // The backlog without its largest chunk: one chunk of any size (a big snapshot, a bulk
      // update) goes out to a client that keeps reading, with whatever follows it.
      if (pending - (largest[0] ?? 0) > maxPendingBytes) {
        log.warn('[events] A client stopped reading its event stream: closed it')
        finish()
        // Drops the queued writes and ends the response; the client reconnects and resyncs.
        stream.abort()
        return
      }
      // stream.write never rejects (it swallows a gone client's errors).
      tail = tail
        .then(() => stream.write(chunk))
        .then(() => {
          pending -= bytes
          if (largest[0] === bytes) largest.shift()
        })
    }

    const entry: Live = {
      async end() {
        if (finished) return settled.promise
        finished = true
        const timer = Promise.withResolvers<'late'>()
        const handle = setTimeout(() => timer.resolve('late'), closeWaitMs)
        const closed = tail.then(() => stream.close()).then(() => 'closed' as const)
        const outcome = await Promise.race([closed, timer.promise])
        clearTimeout(handle)
        if (outcome === 'late') stream.abort()
        ended.resolve()
        return settled.promise
      },
      done: settled.promise,
    }
    live.add(entry)

    write(RETRY_CHUNK)
    write(dataChunk(snapshotEvent))
    const unsubscribe = bus.subscribe((_event, json) => write(dataChunk(json)))
    const heartbeat = setInterval(() => write(dataChunk(HEARTBEAT_JSON)), heartbeatMs)
    try {
      await ended.promise
    } finally {
      clearInterval(heartbeat)
      unsubscribe()
      live.delete(entry)
      settled.resolve()
    }
  }

  return {
    respond(c) {
      if (closing) throw new ApiError('unknown', SHUTTING_DOWN, { status: 503 })
      if (live.size >= maxStreams) {
        log.warn(`[events] Refused an event stream: ${live.size} are open`)
        throw new ApiError(
          'unknown',
          'Too many DJ Scraper tabs are open. Close some, then reload this one.',
          { status: 503 },
        )
      }
      // Hono answers HEAD by running this handler and dropping the body unread: a stream opened
      // for it would never hear the client go, and would keep its slot and subscription.
      if (c.req.method === 'HEAD') {
        return c.body(null, 200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        })
      }
      // Taken here, and subscribed inside streamSSE's callback, which runs in this same tick.
      const first = snapshotJson()
      return streamSSE(c, (stream) => serve(stream, first))
    },
    get size() {
      return live.size
    },
    async closeAll() {
      closing = true
      await Promise.all(Array.from(live, (entry) => entry.end()))
    },
  }
}

export type EventsDeps = { streams: Pick<EventStreams, 'respond'> }

export const eventRoutes = ({ streams }: EventsDeps) =>
  new Hono().get('/events', (c) => streams.respond(c))
