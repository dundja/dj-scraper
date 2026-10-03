import {
  ApiErrorBodySchema,
  type DownloadsSnapshot,
  type ServerEvent,
  ServerEventSchema,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { type BusListener, createBus } from '../jobs/bus.ts'
import { UNUSED_DEPS } from '../stubs.ts'
import { createEventStreams, type EventStreamsOptions } from './events.ts'

const PORT = 4747
const HOST = `127.0.0.1:${PORT}`
const SERVER_ID = testUuid(0xfff)
const EMPTY: DownloadsSnapshot = {
  serverId: SERVER_ID,
  jobs: [],
  batches: [],
  queue: { platforms: [] },
}
const QUEUE_UPDATED: ServerEvent = {
  type: 'queue.updated',
  queue: { platforms: [{ platform: 'youtube', nextStartAt: '2026-10-02T08:00:12.000Z' }] },
}
/** About 3.3 KB of JSON. */
const BIG_SNAPSHOT: DownloadsSnapshot = {
  ...EMPTY,
  batches: Array.from({ length: 10 }, (_, i) => ({
    id: testUuid(i + 1),
    label: 'L'.repeat(200),
    folder: '/Users/dj/Music/DJ Scraper',
    format: 'mp3',
    createdAt: '2026-10-02T08:00:00.000Z',
  })),
}
/** About 1.6 KB of JSON: one bulk event. */
const BULK: ServerEvent = {
  type: 'jobs.removed',
  ids: Array.from({ length: 40 }, (_, i) => testUuid(i + 100)),
  batchIds: [],
}

const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.cancel().catch(() => {})))
})

function setup(options: Partial<EventStreamsOptions> = {}) {
  const bus = createBus({ assertContract: true })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const streams = createEventStreams({
    bus,
    snapshot: () => EMPTY,
    assertContract: true,
    log,
    ...options,
  })
  const app = createApp({
    port: PORT,
    health: { current: vi.fn(), recheck: vi.fn() },
    ...UNUSED_DEPS,
    streams,
  })
  const get = async () =>
    app.request(`http://${HOST}/api/events`, {
      headers: { host: HOST, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' },
    })
  return { app, bus, streams, log, get }
}

/** Reads an SSE body block by block (a block is everything up to a blank line). */
function blocks(res: Response) {
  if (res.body === null) throw new Error('no body')
  const reader = res.body.getReader()
  readers.push(reader)
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    reader,
    /** The next block, or undefined once the stream has ended. */
    async next(): Promise<string | undefined> {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end !== -1) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          return block
        }
        const { done, value } = await reader.read()
        if (done) return undefined
        buffer += decoder.decode(value, { stream: true })
      }
    },
    /** The next block's event (it must be one `data:` line). */
    async event(): Promise<ServerEvent> {
      const block = await this.next()
      if (block === undefined || !block.startsWith('data: ') || block.includes('\n')) {
        throw new Error(`not one data line: ${JSON.stringify(block)}`)
      }
      return ServerEventSchema.parse(JSON.parse(block.slice('data: '.length)))
    },
    /** Every block until the end. */
    async rest(): Promise<string[]> {
      const all: string[] = []
      for (let block = await this.next(); block !== undefined; block = await this.next()) {
        all.push(block)
      }
      return all
    },
  }
}

describe('GET /api/events', () => {
  it('starts with a raw retry line, then the snapshot, with the SSE and security headers', async () => {
    const { get } = setup()
    const res = await get()
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const stream = blocks(res)
    expect(await stream.next()).toBe('retry: 1000')
    expect(await stream.event()).toEqual({ type: 'snapshot', ...EMPTY })
  })

  it('sends every bus event after the snapshot, in order, as the bus serialized it', async () => {
    const { get, bus } = setup()
    const stream = blocks(await get())
    bus.emit(QUEUE_UPDATED)
    bus.emit({ type: 'heartbeat' })
    bus.emit({ type: 'jobs.removed', ids: [], batchIds: [] })
    expect(await stream.next()).toBe('retry: 1000')
    expect((await stream.event()).type).toBe('snapshot')
    expect(await stream.event()).toEqual(QUEUE_UPDATED)
    expect(await stream.event()).toEqual({ type: 'heartbeat' })
    expect(await stream.event()).toEqual({ type: 'jobs.removed', ids: [], batchIds: [] })
  })

  it('writes the JSON the bus made, without serializing again', async () => {
    const listeners: BusListener[] = []
    const { get } = setup({
      bus: {
        subscribe(listener) {
          listeners.push(listener)
          return () => {}
        },
      },
    })
    const stream = blocks(await get())
    for (const listener of listeners) listener({ type: 'heartbeat' }, '{"type":"heartbeat","n":1}')
    await stream.next()
    await stream.next()
    expect(await stream.next()).toBe('data: {"type":"heartbeat","n":1}')
  })

  it('takes the snapshot in the same tick as it subscribes, so no event falls between them', async () => {
    let sameTick = false
    const order: string[] = []
    const { get } = setup({
      snapshot: () => {
        order.push('snapshot')
        sameTick = true
        queueMicrotask(() => {
          sameTick = false
        })
        return EMPTY
      },
      bus: {
        subscribe() {
          order.push(sameTick ? 'subscribe (same tick)' : 'subscribe (later)')
          return () => {}
        },
      },
    })
    await get()
    expect(order).toEqual(['snapshot', 'subscribe (same tick)'])
  })

  it('sends a heartbeat every heartbeatMs', async () => {
    const { get } = setup({ heartbeatMs: 20 })
    const stream = blocks(await get())
    await stream.next()
    await stream.next()
    expect(await stream.event()).toEqual({ type: 'heartbeat' })
    expect(await stream.event()).toEqual({ type: 'heartbeat' })
  })

  it('unsubscribes and forgets the stream when the client goes away', async () => {
    const { get, bus, streams } = setup({ heartbeatMs: 10 })
    const stream = blocks(await get())
    await stream.next()
    expect(bus.subscribers).toBe(1)
    expect(streams.size).toBe(1)
    await stream.reader.cancel()
    await vi.waitFor(() => {
      expect(bus.subscribers).toBe(0)
      expect(streams.size).toBe(0)
    })
  })

  it('refuses a stream beyond maxStreams with 503, and takes one again once another closed', async () => {
    const { get, log } = setup({ maxStreams: 2 })
    const first = blocks(await get())
    blocks(await get())
    const refused = await get()
    expect(refused.status).toBe(503)
    expect(ApiErrorBodySchema.parse(await refused.json()).error).toEqual({
      code: 'unknown',
      message: 'Too many DJ Scraper tabs are open. Close some, then reload this one.',
    })
    expect(log.warn).toHaveBeenCalledWith('[events] Refused an event stream: 2 are open')
    await first.reader.cancel()
    await vi.waitFor(async () => {
      const again = await get()
      blocks(again)
      expect(again.status).toBe(200)
    })
  })

  it('cuts off a client that stopped reading once its pending writes pass maxPendingBytes', async () => {
    const { get, bus, streams, log } = setup({ maxPendingBytes: 1024 })
    const res = await get()
    const big: ServerEvent = { type: 'jobs.removed', ids: [], batchIds: [] }
    for (let i = 0; i < 40; i++) bus.emit(big)
    await vi.waitFor(() => {
      expect(bus.subscribers).toBe(0)
      expect(streams.size).toBe(0)
    })
    expect(log.warn).toHaveBeenCalledWith(
      '[events] A client stopped reading its event stream: closed it',
    )
    // What was written before the cut arrives, then the stream ends: the client reconnects.
    const rest = await blocks(res).rest()
    expect(rest[0]).toBe('retry: 1000')
    expect(rest.length).toBeLessThan(42)
  })

  it('sends a snapshot bigger than maxPendingBytes, and the events right after it', async () => {
    const { get, bus, streams, log } = setup({
      maxPendingBytes: 1024,
      snapshot: () => BIG_SNAPSHOT,
    })
    const res = await get()
    // Before the client has read a byte.
    bus.emit(QUEUE_UPDATED)
    const stream = blocks(res)
    expect(await stream.next()).toBe('retry: 1000')
    expect(await stream.event()).toEqual({ type: 'snapshot', ...BIG_SNAPSHOT })
    expect(await stream.event()).toEqual(QUEUE_UPDATED)
    expect(streams.size).toBe(1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('sends one event bigger than maxPendingBytes, and the events right after it', async () => {
    const { get, bus, streams, log } = setup({ maxPendingBytes: 1024 })
    const stream = blocks(await get())
    await stream.next()
    await stream.event()
    bus.emit(BULK)
    bus.emit(QUEUE_UPDATED)
    expect(await stream.event()).toEqual(BULK)
    expect(await stream.event()).toEqual(QUEUE_UPDATED)
    expect(streams.size).toBe(1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('still cuts off a client that never reads a big snapshot once the events behind it pile up', async () => {
    const { get, bus, streams } = setup({ maxPendingBytes: 1024, snapshot: () => BIG_SNAPSHOT })
    await get()
    for (let i = 0; i < 40; i++) bus.emit(QUEUE_UPDATED)
    await vi.waitFor(() => {
      expect(bus.subscribers).toBe(0)
      expect(streams.size).toBe(0)
    })
  })

  it('stops exempting a big snapshot once it was sent: a reader that stalls after it is cut at maxPendingBytes', async () => {
    const { get, bus, streams } = setup({ maxPendingBytes: 1024, snapshot: () => BIG_SNAPSHOT })
    const stream = blocks(await get())
    expect(await stream.next()).toBe('retry: 1000')
    expect((await stream.event()).type).toBe('snapshot')
    // Let the snapshot's write settle, so the backlog is empty before the client stalls.
    await new Promise((resolve) => setTimeout(resolve, 20))
    // About 2 KB of small events: over the cap, though under the cap plus the 3.3 KB snapshot.
    for (let i = 0; i < 20; i++) bus.emit(QUEUE_UPDATED)
    await vi.waitFor(() => {
      expect(bus.subscribers).toBe(0)
      expect(streams.size).toBe(0)
    })
  })

  it('answers HEAD with the stream headers, opening no stream', async () => {
    const { app, get, bus, streams } = setup({ maxStreams: 1 })
    for (let i = 0; i < 3; i++) {
      // As `curl -I` sends it: no Fetch Metadata.
      const res = await app.request(`http://${HOST}/api/events`, {
        method: 'HEAD',
        headers: { host: HOST },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      expect(res.body).toBeNull()
    }
    expect(streams.size).toBe(0)
    expect(bus.subscribers).toBe(0)
    // The one slot is still free.
    const res = await get()
    blocks(res)
    expect(res.status).toBe(200)
  })

  it('checks the snapshot against the contract with assertContract', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { get, bus } = setup({
      snapshot: () => ({ ...EMPTY, serverId: 'not-a-uuid' }),
    })
    expect((await get()).status).toBe(500)
    expect(bus.subscribers).toBe(0)
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('closeAll', () => {
  it('ends every stream cleanly after its last writes, and refuses new ones', async () => {
    const { get, bus, streams } = setup()
    const a = blocks(await get())
    const b = blocks(await get())
    bus.emit(QUEUE_UPDATED)
    // The clients read on, as browsers do.
    const rests = [a.rest(), b.rest()]
    await streams.closeAll()
    expect(streams.size).toBe(0)
    expect(bus.subscribers).toBe(0)
    for (const rest of await Promise.all(rests)) {
      expect(rest).toHaveLength(3)
      expect(rest[2]).toBe(`data: ${JSON.stringify(QUEUE_UPDATED)}`)
    }
    const refused = await get()
    expect(refused.status).toBe(503)
    expect(ApiErrorBodySchema.parse(await refused.json()).error).toEqual({
      code: 'unknown',
      message: 'DJ Scraper is shutting down',
    })
  })

  it('cuts off a stream that can’t flush within closeWaitMs', async () => {
    const { get, bus, streams } = setup({ closeWaitMs: 30 })
    // Never read: its writes stay pending.
    await get()
    for (let i = 0; i < 20; i++) bus.emit(QUEUE_UPDATED)
    const startedAt = performance.now()
    await streams.closeAll()
    expect(performance.now() - startedAt).toBeLessThan(1000)
    expect(streams.size).toBe(0)
    expect(bus.subscribers).toBe(0)
  })

  it('resolves at once with no stream open', async () => {
    const { streams } = setup()
    await streams.closeAll()
    expect(streams.size).toBe(0)
  })
})
