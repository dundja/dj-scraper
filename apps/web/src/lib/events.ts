import {
  type Batch,
  type Job,
  type QueueState,
  type ServerEvent,
  ServerEventSchema,
  SSE_HEARTBEAT_MS,
} from '@dj-scraper/shared'
import { type QueryClient, queryOptions, skipToken } from '@tanstack/react-query'
import { healthQueryKey } from '@/features/engine/use-health.ts'

/**
 * - `connecting`: not live yet: before the first snapshot, or reconnecting before anyone would
 *   notice (a drop that heals within 2 s, a stalled stream replaced, a tab shown again).
 * - `open`: the stream is open and the data is live.
 * - `down`: the stream has been gone for over 2 s, or it keeps breaking the contract (no more
 *   retries then). The data may be stale.
 */
export type EventsConnection = 'connecting' | 'open' | 'down'

/** The downloads panel's data: the stream's latest snapshot with every event since applied. */
export type DownloadsState = {
  connection: EventsConnection
  /** Changes when the server restarts; absent until the first snapshot. */
  serverId?: string
  /** Job ids in creation order. */
  order: string[]
  byId: Record<string, Job>
  batches: Record<string, Batch>
  /** Paused and paced platforms; absent until the first snapshot. */
  queue?: QueueState
}

/**
 * `['downloads']`. The event stream is its only writer (startEvents), so it never fetches: don't
 * prefetch, ensure or refetch it, and don't write mutation answers into it.
 */
export const downloadsQueryOptions = queryOptions<
  DownloadsState,
  Error,
  DownloadsState,
  readonly ['downloads']
>({
  queryKey: ['downloads'] as const,
  queryFn: skipToken,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
})
export const downloadsQueryKey = downloadsQueryOptions.queryKey

const EVENTS_URL = '/api/events'
/** Three missed heartbeats: the stream is dead even if the browser hasn't noticed. */
const SILENT_STREAM_MS = 3 * SSE_HEARTBEAT_MS
/** A periodic check, rather than a timer per message, tolerates throttled background timers. */
const WATCHDOG_EVERY_MS = 5000
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10_000
/** A drop that heals this fast (a dev server restart) doesn't flip the engine chip to offline. */
const OUTAGE_GRACE_MS = 2000
/** A hidden tab gives its connection back: browsers allow only 6 per host. */
const HIDDEN_CLOSE_MS = 10_000
const MAX_INVALID_SNAPSHOTS = 3

/**
 * Opens the app's one event stream and keeps `['downloads']` in step with it; returns stop().
 * Call it once per QueryClient, outside React (StrictMode runs effects twice).
 *
 * Every connection starts with a snapshot that replaces the state; the events after it apply in
 * order. A drop also rechecks `['health']` when it outlasts the grace (and again once the stream is
 * back), so the engine chip can say "Server offline".
 */
export function startEvents(queryClient: QueryClient): () => void {
  // Without an observer, a query is garbage-collected after gcTime; the stream outlives them all.
  queryClient.setQueryDefaults(downloadsQueryKey, {
    queryFn: skipToken,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })

  const update = (change: (state: DownloadsState) => DownloadsState) => {
    const state = queryClient.getQueryData(downloadsQueryKey)
    const next = change(state ?? { connection: 'connecting', order: [], byId: {}, batches: {} })
    if (next !== state) queryClient.setQueryData(downloadsQueryKey, next)
  }
  const setConnection = (connection: EventsConnection) =>
    update((state) => (state.connection === connection ? state : { ...state, connection }))
  /** No longer live; an outage already shown stays `down`. */
  const markStale = () =>
    update((state) =>
      state.connection === 'open' ? { ...state, connection: 'connecting' } : state,
    )
  const recheckHealth = () => void queryClient.invalidateQueries({ queryKey: healthQueryKey })

  let source: EventSource | undefined
  /** The current connection delivered a valid snapshot, so its events apply. */
  let synced = false
  let lastHeardAt = 0
  let failures = 0
  let invalidSnapshots = 0
  /** The outage outlasted the grace: recheck health once the stream is back. */
  let outageShown = false
  let closedWhileHidden = false
  let gaveUp = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    const es = new EventSource(EVENTS_URL)
    source = es
    synced = false
    lastHeardAt = Date.now()
    es.onopen = () => {
      if (es !== source) return
      lastHeardAt = Date.now()
      failures = 0
      clearTimeout(graceTimer)
      graceTimer = undefined
      if (outageShown) {
        outageShown = false
        recheckHealth()
      }
    }
    es.onmessage = (message) => {
      if (es !== source) return
      lastHeardAt = Date.now()
      receive(message.data)
    }
    es.onerror = () => {
      if (es !== source) return
      // The browser's own reconnect reuses this EventSource; the next connection starts over.
      synced = false
      markStale()
      if (graceTimer === undefined && !outageShown) graceTimer = setTimeout(outage, OUTAGE_GRACE_MS)
      // CONNECTING: the browser retries by itself (after the server's `retry:`). CLOSED: it gave
      // up on a non-200 (Vite's 502 while the server is down), so we retry.
      if (es.readyState === EventSource.CLOSED) reconnectLater()
    }
  }

  const closeSource = () => {
    source?.close()
    source = undefined
    synced = false
  }

  const reconnectLater = () => {
    closeSource()
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** failures)
    if (delay < RECONNECT_MAX_MS) failures++
    reconnectTimer = setTimeout(connect, delay)
  }

  const outage = () => {
    graceTimer = undefined
    outageShown = true
    setConnection('down')
    recheckHealth()
  }

  const receive = (data: unknown) => {
    const json = parseJson(data)
    const parsed = ServerEventSchema.safeParse(json)
    if (parsed.success) {
      const event = parsed.data
      if (event.type === 'snapshot') {
        synced = true
        invalidSnapshots = 0
      } else if (!synced) {
        return
      }
      update((state) => applyEvent(state, event))
      return
    }
    // An invalid update is dropped: its job keeps its last state until the next update.
    if (synced && typeOf(json) !== 'snapshot') return
    // Nothing applies without a valid snapshot: ask for another one, a few times.
    invalidSnapshots++
    if (invalidSnapshots < MAX_INVALID_SNAPSHOTS) {
      markStale()
      reconnectLater()
      return
    }
    gaveUp = true
    closeSource()
    clearTimeout(graceTimer)
    graceTimer = undefined
    setConnection('down')
  }

  // Proxied streams can die without an error event (Vite's dev proxy); heartbeats prove life.
  const watchdog = setInterval(() => {
    if (source === undefined || source.readyState === EventSource.CLOSED) return
    if (Date.now() - lastHeardAt < SILENT_STREAM_MS) return
    closeSource()
    markStale()
    connect()
  }, WATCHDOG_EVERY_MS)

  // A deliberate close: no health recheck, and no backoff when the tab is shown again.
  const closeWhileHidden = () => {
    hiddenTimer = undefined
    if (gaveUp) return
    closedWhileHidden = true
    closeSource()
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    clearTimeout(graceTimer)
    graceTimer = undefined
    failures = 0
    markStale()
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (hiddenTimer === undefined && !closedWhileHidden) {
        hiddenTimer = setTimeout(closeWhileHidden, HIDDEN_CLOSE_MS)
      }
      return
    }
    clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    if (closedWhileHidden) {
      closedWhileHidden = false
      connect()
    }
  }

  update((state) => state)
  document.addEventListener('visibilitychange', onVisibilityChange)
  connect()
  onVisibilityChange()

  return () => {
    clearInterval(watchdog)
    clearTimeout(reconnectTimer)
    clearTimeout(graceTimer)
    clearTimeout(hiddenTimer)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    closeSource()
  }
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** The `type` an event claims, even when the rest of it is invalid. */
function typeOf(json: unknown): unknown {
  return typeof json === 'object' && json !== null && 'type' in json ? json.type : undefined
}

/** Pure: the state after `event`. Unchanged parts keep their identity, so rows can skip renders. */
function applyEvent(state: DownloadsState, event: ServerEvent): DownloadsState {
  switch (event.type) {
    case 'snapshot':
      return {
        connection: 'open',
        serverId: event.serverId,
        order: event.jobs.map((job) => job.id),
        byId: Object.fromEntries(event.jobs.map((job) => [job.id, job])),
        batches: Object.fromEntries(event.batches.map((batch) => [batch.id, batch])),
        queue: event.queue,
      }
    case 'jobs.added': {
      const byId = { ...state.byId }
      const added: string[] = []
      for (const job of event.jobs) {
        if (!Object.hasOwn(byId, job.id)) added.push(job.id)
        byId[job.id] = job
      }
      return {
        ...state,
        order: added.length > 0 ? [...state.order, ...added] : state.order,
        byId,
        batches: { ...state.batches, [event.batch.id]: event.batch },
      }
    }
    case 'jobs.updated': {
      // A job the client doesn't know was removed (or never seen): don't bring it back.
      const known = event.jobs.filter((job) => Object.hasOwn(state.byId, job.id))
      if (known.length === 0) return state
      const byId = { ...state.byId }
      for (const job of known) byId[job.id] = job
      return { ...state, byId }
    }
    case 'jobs.removed': {
      const ids = new Set(event.ids)
      const byId = withoutKeys(state.byId, ids)
      const batches = withoutKeys(state.batches, new Set(event.batchIds))
      if (byId === state.byId && batches === state.batches) return state
      const order = byId === state.byId ? state.order : state.order.filter((id) => !ids.has(id))
      return { ...state, order, byId, batches }
    }
    case 'job.progress': {
      const job = state.byId[event.jobId]
      if (job?.status !== 'downloading') return state
      return { ...state, byId: { ...state.byId, [job.id]: { ...job, progress: event.progress } } }
    }
    case 'queue.updated':
      return { ...state, queue: event.queue }
    case 'heartbeat':
      return state
  }
}

function withoutKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  if (!Object.keys(record).some((key) => keys.has(key))) return record
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))
}
