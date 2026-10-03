import { randomUUID } from 'node:crypto'
import {
  type AudioSource,
  AudioSourceSchema,
  type Batch,
  type CreateDownloadsResponse,
  type DownloadOptions,
  type DownloadsSnapshot,
  ErrorCodeSchema,
  type ErrorInfo,
  ErrorInfoSchema,
  isRetryableError,
  isTerminalStatus,
  type Job,
  JobOutputSchema,
  type JobProgress,
  JobProgressSchema,
  type JobScope,
  type JobStatus,
  MAX_CONCURRENCY,
  type Platform,
  type PlatformQueueState,
  PlatformSchema,
  type QueueState,
  type RetryableStatus,
  type TrackRef,
  TrackRefSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import type { Gates } from '../pacing/gates.ts'
import { monotonicClock } from '../resolve/limiter.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { failureName } from '../util/errno.ts'
import type { Bus } from './bus.ts'
import type {
  AbortReason,
  AttemptOutcome,
  AttemptRequest,
  AttemptUpdate,
  FinalTrack,
  RunAttempt,
  TargetFolder,
} from './types.ts'

/** One item of a `POST /api/downloads`, checked by the route (D16). */
export type EnqueueItem = {
  ref: TrackRef
  /** `checkUrl(ref.url)`; undefined when the URL was refused (`refusal` says why). */
  input: ValidUrl | undefined
  /** The job is created failed with this error at once: no slot, no token, no spawn. */
  refusal?: ErrorInfo
}

/**
 * The download queue (Phase 2 design §5): jobs in creation order, per-platform run order, the
 * concurrency limit and the platform gates. Every change goes out on the bus as it happens.
 */
export type Queue = {
  /**
   * Creates one job per distinct track (D16) and emits `jobs.added` before anything starts.
   * `jobIds` maps every item to its job, a duplicate to the job it repeats.
   */
  add(
    batch: { label?: string; folder: TargetFolder; options: DownloadOptions },
    items: EnqueueItem[],
  ): CreateDownloadsResponse
  snapshot(): DownloadsSnapshot
  get(id: string): Job | undefined
  /** A queued job ends canceled now; a running one is asked to stop (`cancelRequested`). */
  cancel(id: string): Job | undefined
  /** A failed or canceled job goes back to the end of the queue as its next attempt. */
  retry(id: string): Job | 'not_retryable' | undefined
  /** Each returns how many jobs it changed, after emitting one event for all of them. */
  cancelMany(scope: JobScope): number
  /** Skips failures that retrying can't fix (`isRetryableError`). */
  retryMany(scope: JobScope, statuses: RetryableStatus[]): number
  /** Removes finished jobs, and the batches left without jobs. */
  clear(scope: JobScope): number
  /** The file of a done or skipped job. */
  outputPathOf(id: string): string | undefined
  /** Takes effect at once: more jobs start, or fewer once running ones end. */
  setConcurrency(n: number): void
  /** Set by `close()`: routes answer mutations with 503, and nothing starts any more. */
  readonly closing: boolean
  /** Stops every running attempt (`{ kind: 'shutdown' }`) and resolves once all have settled. */
  close(): Promise<void>
}

export type QueueOptions = {
  runAttempt: RunAttempt
  gates: Gates
  bus: Bus
  /** Changes when the server restarts, so a client can tell a restart from a reconnect. */
  serverId: string
  concurrency: number
  /** Monotonic ms for pacing and timers. Default `monotonicClock`. */
  clock?: () => number
  /** Wall-clock ms for the timestamps jobs carry. Default `Date.now`. */
  now?: () => number
  /** Finished jobs kept beyond this many are removed, oldest first (D17). */
  maxRetainedTerminal?: number
  /** The newest this many canceled jobs are removed along with failed ones, not first (ADR-025). */
  recentCanceled?: number
  newId?: () => string
  log?: Logger
}

export const DEFAULT_MAX_RETAINED_TERMINAL = 2000
export const DEFAULT_RECENT_CANCELED = 50
/** A canceled job among the `recentCanceled` that ended last. */
type EvictionGroup = JobStatus | 'recently canceled'
/**
 * Which finished jobs go first when there are too many (ADR-025): canceled ones (the user let them
 * go; after canceling a big batch they would otherwise push out the tracks that did download), then
 * done and skipped ones (their files stay; the job is only their record), then failed ones and the
 * newest canceled ones (a retry may still want those: a track just canceled keeps its Retry).
 */
const EVICTION_ORDER: readonly (readonly EvictionGroup[])[] = [
  ['canceled'],
  ['done', 'skipped'],
  ['failed', 'recently canceled'],
]
/** A job that itself caused this many rate-limit strikes fails with its last error (D8). */
export const MAX_OWN_STRIKES = 3

const CANCEL: AbortReason = { kind: 'cancel' }
const SHUTDOWN: AbortReason = { kind: 'shutdown' }
const PLATFORMS = PlatformSchema.options
/** setTimeout fires at once for anything longer. */
const MAX_TIMER_MS = 2 ** 31 - 1

const NOT_A_LINK: ErrorInfo = {
  code: 'invalid_url',
  message: 'This is not a link DJ Scraper can download.',
}
const STOPPED: ErrorInfo = {
  code: 'unknown',
  message: 'The download stopped unexpectedly. Retry to try again.',
}
const UNREADABLE_OUTPUT: ErrorInfo = {
  code: 'unknown',
  message: "The download finished, but its file couldn't be read back.",
}

/** The fields every job status has; the rest belong to one status (see JobSchema). */
type BaseKey = Exclude<keyof Extract<Job, { status: 'processing' }>, 'status'>
/** A status with the fields only it may carry. Moving to another phase drops them all. */
type Phase = { [S in JobStatus]: Omit<Extract<Job, { status: S }>, BaseKey> }[JobStatus]

/** A job's attempt from its pick until it settles. */
type Attempt = {
  controller: AbortController
  /** Resolves once the attempt has settled and the job has moved on. */
  done: Promise<void>
  finish: () => void
  /** The highest percent reported: the bar never goes back within an attempt. */
  percent?: number
  /** An off-contract update was dropped (logged once per attempt). */
  dropped?: boolean
}

type Entry = {
  readonly id: string
  readonly batchId: string
  /** The request's ref, for display: a finished job's final title, artist, url and artwork replace its own. */
  track: TrackRef
  /** The request's URL, which every attempt classifies again (`input` came from it). */
  readonly url: string
  readonly folder: TargetFolder
  readonly options: DownloadOptions
  /** Undefined only for a job refused because its URL didn't classify: it can never run. */
  readonly input: ValidUrl | undefined
  /** `input.platform` (the request's for a refused URL): every pacing decision uses it. */
  readonly platform: Platform
  readonly createdAt: string
  attempt: number
  /** Strikes this job caused since it was created or retried. */
  strikes: number
  /** Run order across platforms: requeues get decreasing negative numbers, so they go first. */
  seq: number
  phase: Phase
  startedAt?: string
  /** `startedAt` on the monotonic clock, for the gates. */
  startedMono?: number
  source?: AudioSource
  cancelRequested?: true
  running?: Attempt
  /** The order jobs last finished in (0 before): eviction keeps the newest canceled ones longer. */
  finished: number
}

export function createQueue({
  runAttempt,
  gates,
  bus,
  serverId,
  concurrency: initialConcurrency,
  clock = monotonicClock,
  now = Date.now,
  maxRetainedTerminal = DEFAULT_MAX_RETAINED_TERMINAL,
  recentCanceled = DEFAULT_RECENT_CANCELED,
  newId = randomUUID,
  log = console,
}: QueueOptions): Queue {
  checkConcurrency(initialConcurrency)
  checkCount('maxRetainedTerminal', maxRetainedTerminal)
  checkCount('recentCanceled', recentCanceled)
  let concurrency = initialConcurrency
  /** Every job, in creation order (the display order). */
  const jobs = new Map<string, Entry>()
  const batches = new Map<string, { batch: Batch; size: number }>()
  /** Queued jobs per platform in run order. Stale entries are skipped when they reach the front. */
  const waiting = new Map<Platform, { id: string; seq: number }[]>(PLATFORMS.map((p) => [p, []]))
  let running = 0
  let terminal = 0
  let lastSeq = 0
  let firstSeq = 0
  let lastFinished = 0
  let closing = false
  let closed: Promise<void> | undefined
  let pumpScheduled = false
  let pumping = false
  let pumpAgain = false
  let timer: { at: number; handle: ReturnType<typeof setTimeout> } | undefined
  let lastQueueJson = JSON.stringify({ platforms: [] } satisfies QueueState)

  const stamp = (): string => new Date(now()).toISOString()

  function setPhase(entry: Entry, phase: Phase): void {
    const finishes = isTerminalStatus(phase.status)
    terminal += Number(finishes) - Number(isTerminalStatus(entry.phase.status))
    if (finishes) entry.finished = ++lastFinished
    entry.phase = phase
  }

  /** The one place a Job is built: only the fields its status allows. */
  function toJob(entry: Entry): Job {
    return {
      id: entry.id,
      batchId: entry.batchId,
      track: entry.track,
      format: entry.options.format,
      folder: entry.folder.given,
      attempt: entry.attempt,
      createdAt: entry.createdAt,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.cancelRequested ? { cancelRequested: true } : {}),
      ...entry.phase,
    }
  }

  const emitUpdated = (entries: readonly Entry[]): void => {
    if (entries.length > 0) bus.emit({ type: 'jobs.updated', jobs: entries.map(toJob) })
  }

  const dequeOf = (platform: Platform) => {
    let deque = waiting.get(platform)
    if (deque === undefined) {
      deque = []
      waiting.set(platform, deque)
    }
    return deque
  }

  function enqueue(entry: Entry, where: 'back' | 'front'): void {
    if (where === 'back') {
      entry.seq = ++lastSeq
      dequeOf(entry.platform).push({ id: entry.id, seq: entry.seq })
    } else {
      entry.seq = --firstSeq
      dequeOf(entry.platform).unshift({ id: entry.id, seq: entry.seq })
    }
  }

  /** The next queued job of `platform`, dropping entries of jobs that left the queue since. */
  function headOf(platform: Platform): Entry | undefined {
    const deque = dequeOf(platform)
    for (;;) {
      const first = deque[0]
      if (first === undefined) return undefined
      const entry = jobs.get(first.id)
      if (entry?.phase.status === 'queued' && entry.seq === first.seq) return entry
      deque.shift()
    }
  }

  function schedulePump(): void {
    if (pumpScheduled || closing) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }

  function pump(): void {
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        fill()
      } while (pumpAgain)
    } finally {
      pumping = false
    }
  }

  /** Starts queued jobs while slots are free and their platforms admit them, oldest first. */
  function fill(): void {
    if (closing) return
    const at = clock()
    const picked: [Entry, Attempt][] = []
    while (running < concurrency) {
      let next: Entry | undefined
      for (const platform of PLATFORMS) {
        const head = headOf(platform)
        if (head === undefined || gates.readyAt(platform, at) > at) continue
        if (next === undefined || head.seq < next.seq) next = head
      }
      if (next === undefined) break
      dequeOf(next.platform).shift()
      picked.push([next, pick(next, at)])
    }
    // Downloading before the attempt starts: a cancel from here on stops the attempt instead of
    // marking the job canceled under it.
    emitUpdated(picked.map(([entry]) => entry))
    for (const [entry, attempt] of picked) launch(entry, attempt)
    // A listener of that event may have closed the queue: arm nothing after close().
    if (closing) return
    const wall = now()
    const state = queueState(at, wall)
    wake(at, wall, state)
    publish(state)
  }

  /** Synchronous: the job is downloading and holds its slot and token before anything awaits. */
  function pick(entry: Entry, at: number): Attempt {
    const { promise, resolve } = Promise.withResolvers<void>()
    const attempt: Attempt = { controller: new AbortController(), done: promise, finish: resolve }
    setPhase(entry, { status: 'downloading' })
    entry.startedAt = stamp()
    entry.startedMono = at
    entry.running = attempt
    running++
    gates.take(entry.platform, at)
    return attempt
  }

  function launch(entry: Entry, attempt: Attempt): void {
    const { signal } = attempt.controller
    let outcome: Promise<AttemptOutcome>
    if (signal.aborted) {
      // Canceled (or shut down) between its pick and here: it never starts.
      outcome = Promise.resolve({ kind: 'canceled' })
    } else if (entry.input === undefined) {
      outcome = Promise.resolve({ kind: 'failed', error: NOT_A_LINK })
    } else {
      const request: AttemptRequest = {
        jobId: entry.id,
        attemptId: newId(),
        // A retry after a finished attempt reported its page URL still hands over the request's.
        ref: { ...entry.track, url: entry.url },
        input: entry.input,
        folder: entry.folder,
        options: entry.options,
      }
      try {
        outcome = Promise.resolve(
          runAttempt(request, signal, (update) => onUpdate(entry, attempt, update)),
        )
      } catch (error) {
        outcome = Promise.reject(error)
      }
    }
    outcome
      .then(
        (result) => settle(entry, attempt, result),
        (error: unknown) => {
          log.error(`[queue] ${short(entry.id)}: the attempt threw ${failureName(error)}`)
          settle(entry, attempt, { kind: 'failed', error: STOPPED })
        },
      )
      .catch((error: unknown) => {
        log.error(`[queue] ${short(entry.id)}: settling failed: ${failureName(error)}`)
      })
      .finally(attempt.finish)
  }

  function onUpdate(entry: Entry, attempt: Attempt, update: AttemptUpdate): void {
    // A late update from an attempt that has settled never follows the job's final state.
    if (entry.running !== attempt) return
    const { phase } = entry
    if (phase.status !== 'downloading' && phase.status !== 'processing') return
    let changed = false
    if (update.source !== undefined) {
      const source = AudioSourceSchema.safeParse(update.source)
      if (!source.success) dropped(entry, attempt, 'source')
      else if (JSON.stringify(source.data) !== JSON.stringify(entry.source)) {
        entry.source = source.data
        changed = true
      }
    }
    const status = update.status ?? phase.status
    let progress = phase.status === 'downloading' ? phase.progress : undefined
    let progressed = false
    if (status !== phase.status) changed = true
    if (update.progress === null) {
      if (progress !== undefined) changed = true
      progress = undefined
    } else if (update.progress !== undefined && status === 'downloading') {
      const parsed = JobProgressSchema.safeParse(update.progress)
      if (!parsed.success) dropped(entry, attempt, 'progress')
      else {
        progress = steady(parsed.data, attempt)
        progressed = true
      }
    }
    if (status === 'downloading') {
      setPhase(entry, { status, ...(progress === undefined ? {} : { progress }) })
    } else if (phase.status !== 'processing') {
      setPhase(entry, { status })
    }
    if (changed) emitUpdated([entry])
    else if (progressed && progress !== undefined) {
      bus.emit({ type: 'job.progress', jobId: entry.id, progress })
    }
  }

  function dropped(entry: Entry, attempt: Attempt, what: string): void {
    if (attempt.dropped) return
    attempt.dropped = true
    log.warn(`[queue] ${short(entry.id)}: dropped an off-contract ${what} update`)
  }

  function settle(entry: Entry, attempt: Attempt, outcome: AttemptOutcome): void {
    if (entry.running !== attempt) return
    entry.running = undefined
    running--
    const at = clock()
    const startedMono = entry.startedMono ?? at
    const verdict = gates.settled(entry.platform, gateOutcome(outcome), startedMono, at)
    const finishedAt = stamp()
    const changed: Entry[] = [entry]
    let detail = ''
    switch (outcome.kind) {
      case 'done': {
        finalTrack(entry, outcome.track, attempt)
        finalSource(entry, outcome.source, attempt)
        const output = JobOutputSchema.safeParse(outcome.output)
        if (output.success && outcome.outputPath !== '') {
          setPhase(entry, {
            status: 'done',
            outputPath: outcome.outputPath,
            output: output.data,
            finishedAt,
          })
        } else {
          dropped(entry, attempt, 'output')
          setPhase(entry, { status: 'failed', error: UNREADABLE_OUTPUT, finishedAt })
        }
        break
      }
      case 'skipped':
        finalTrack(entry, outcome.track, attempt)
        finalSource(entry, outcome.source, attempt)
        if (outcome.outputPath !== '') {
          setPhase(entry, { status: 'skipped', outputPath: outcome.outputPath, finishedAt })
        } else {
          dropped(entry, attempt, 'output')
          setPhase(entry, { status: 'failed', error: UNREADABLE_OUTPUT, finishedAt })
        }
        break
      case 'canceled':
        // Only our own abort ends an attempt this way; anything else is a bug in the attempt.
        setPhase(
          entry,
          entry.cancelRequested || attempt.controller.signal.aborted
            ? { status: 'canceled', finishedAt }
            : { status: 'failed', error: STOPPED, finishedAt },
        )
        break
      case 'failed': {
        const error = checkedError(outcome.error)
        if (entry.cancelRequested) {
          setPhase(entry, { status: 'canceled', finishedAt })
          break
        }
        if (verdict === 'strike' || verdict === 'inside') {
          if (verdict === 'strike') entry.strikes++
          if (entry.strikes < MAX_OWN_STRIKES) {
            setPhase(entry, { status: 'queued', lastError: error })
            entry.startedAt = undefined
            entry.startedMono = undefined
            enqueue(entry, 'front')
            detail = ` (${error.code}, ${verdict}, ${entry.strikes} own strike${entry.strikes === 1 ? '' : 's'})`
            break
          }
        }
        setPhase(entry, { status: 'failed', error, finishedAt })
        if (verdict === 'blocked') {
          const failed = failQueued((other) => other.platform === entry.platform, error, finishedAt)
          changed.push(...failed)
          log.warn(
            `[queue] ${entry.platform} keeps asking for a bot check: failed ${failed.length} queued`,
          )
        } else if (error.code === 'disk_full' || error.code === 'folder_unavailable') {
          const failed = failQueued(
            (other) => other.folder.real === entry.folder.real,
            error,
            finishedAt,
          )
          changed.push(...failed)
          if (failed.length > 0) log.warn(`[queue] ${error.code}: failed ${failed.length} queued`)
        }
        break
      }
    }
    emitUpdated(changed)
    const seconds = ((at - startedMono) / 1000).toFixed(1)
    if (entry.phase.status === 'failed') detail = ` (${entry.phase.error.code})`
    log.info(
      `[queue] ${short(entry.id)} ${entry.platform} attempt ${entry.attempt} → ${entry.phase.status}${detail} in ${seconds} s`,
    )
    evict()
    schedulePump()
  }

  function finalTrack(entry: Entry, track: FinalTrack, attempt: Attempt): void {
    const merged: TrackRef = { ...entry.track }
    for (const key of ['title', 'artist', 'url', 'thumbnailUrl'] as const) {
      const value = track[key]
      if (value === undefined) continue
      if (TrackRefSchema.shape[key].safeParse(value).success) merged[key] = value
      else dropped(entry, attempt, 'track')
    }
    entry.track = merged
  }

  function finalSource(entry: Entry, source: AudioSource | undefined, attempt: Attempt): void {
    if (source === undefined) return
    const parsed = AudioSourceSchema.safeParse(source)
    if (parsed.success) entry.source = parsed.data
    else dropped(entry, attempt, 'source')
  }

  /** Fails the queued jobs that `match` (a folder that is gone, a platform that blocks us). */
  function failQueued(
    match: (entry: Entry) => boolean,
    error: ErrorInfo,
    finishedAt: string,
  ): Entry[] {
    const failed: Entry[] = []
    for (const entry of jobs.values()) {
      if (entry.phase.status !== 'queued' || !match(entry)) continue
      setPhase(entry, { status: 'failed', error, finishedAt })
      failed.push(entry)
    }
    return failed
  }

  /**
   * Removes finished jobs beyond the cap, in one `jobs.removed` (D17), in EVICTION_ORDER and oldest
   * first within each group, and none of a batch that still has jobs to run. A big batch may hold
   * more than the cap until it finishes. A job being canceled has nothing left to run: canceling a
   * big batch must not push other batches' jobs out while its running jobs stop.
   */
  function evict(): void {
    if (terminal <= maxRetainedTerminal) return
    const unfinished = new Set<string>()
    const canceled: number[] = []
    for (const entry of jobs.values()) {
      if (entry.phase.status === 'canceled') canceled.push(entry.finished)
      else if (!isTerminalStatus(entry.phase.status) && entry.cancelRequested !== true) {
        unfinished.add(entry.batchId)
      }
    }
    // The canceled jobs that finished after this one are the `recentCanceled` newest.
    const recentAfter = canceled.sort((a, b) => b - a)[recentCanceled] ?? 0
    const groupOf = (entry: Entry): EvictionGroup =>
      entry.phase.status === 'canceled' && entry.finished > recentAfter
        ? 'recently canceled'
        : entry.phase.status
    const ids: string[] = []
    const batchIds: string[] = []
    for (const group of EVICTION_ORDER) {
      for (const entry of jobs.values()) {
        if (terminal <= maxRetainedTerminal) break
        if (!group.includes(groupOf(entry))) continue
        if (unfinished.has(entry.batchId)) continue
        remove(entry, batchIds)
        ids.push(entry.id)
      }
    }
    if (ids.length === 0) return
    bus.emit({ type: 'jobs.removed', ids, batchIds })
    log.info(`[queue] Evicted ${ids.length} finished job${ids.length === 1 ? '' : 's'}`)
  }

  /** Removes a finished job, and its batch with its last job (into `batchIds`). */
  function remove(entry: Entry, batchIds: string[]): void {
    jobs.delete(entry.id)
    terminal--
    const batch = batches.get(entry.batchId)
    if (batch !== undefined && --batch.size === 0) {
      batches.delete(entry.batchId)
      batchIds.push(entry.batchId)
    }
  }

  function inScope(scope: JobScope): Entry[] {
    const all = [...jobs.values()]
    switch (scope.scope) {
      case 'all':
        return all
      case 'batch':
        return all.filter((entry) => entry.batchId === scope.batchId)
      case 'jobs': {
        const ids = new Set(scope.ids)
        return all.filter((entry) => ids.has(entry.id))
      }
    }
  }

  /** A queued job is canceled now; a running one is asked to stop, aborted after the emit. */
  function requestCancel(entry: Entry, finishedAt: string): boolean {
    if (entry.phase.status === 'queued') {
      setPhase(entry, { status: 'canceled', finishedAt })
      return true
    }
    if (entry.running !== undefined && !entry.cancelRequested) {
      entry.cancelRequested = true
      return true
    }
    return false
  }

  function afterCancel(changed: readonly Entry[]): void {
    emitUpdated(changed)
    for (const entry of changed) entry.running?.controller.abort(CANCEL)
    evict()
    schedulePump()
  }

  const canRetry = (entry: Entry): boolean =>
    entry.input !== undefined &&
    (entry.phase.status === 'failed' || entry.phase.status === 'canceled')

  function restart(entry: Entry): void {
    entry.attempt++
    entry.strikes = 0
    entry.startedAt = undefined
    entry.startedMono = undefined
    entry.source = undefined
    entry.cancelRequested = undefined
    setPhase(entry, { status: 'queued' })
    enqueue(entry, 'back')
  }

  /** The gates' state, without pacing waits of platforms that have nothing queued. */
  function queueState(at: number, wall: number): QueueState {
    const platforms: PlatformQueueState[] = []
    for (const entry of gates.state(at, wall).platforms) {
      if (entry.nextStartAt === undefined || headOf(entry.platform) !== undefined) {
        platforms.push(entry)
      } else if (entry.pausedUntil !== undefined) {
        platforms.push({
          platform: entry.platform,
          pausedUntil: entry.pausedUntil,
          ...(entry.pauseCode === undefined ? {} : { pauseCode: entry.pauseCode }),
        })
      }
    }
    return { platforms }
  }

  function publish(state: QueueState): void {
    const json = JSON.stringify(state)
    if (json === lastQueueJson) return
    lastQueueJson = json
    bus.emit({ type: 'queue.updated', queue: state })
  }

  /** Arms the one timer: the next paced start of a waiting job, or the end of a pause. */
  function wake(at: number, wall: number, state: QueueState): void {
    let next = Number.POSITIVE_INFINITY
    // With every slot taken, the next settle pumps anyway.
    for (const platform of running < concurrency ? PLATFORMS : []) {
      if (headOf(platform) === undefined) continue
      const ready = gates.readyAt(platform, at)
      if (ready > at) next = Math.min(next, ready)
    }
    // Also when nothing waits, so the state stops saying "paused" when the pause is over.
    for (const entry of state.platforms) {
      if (entry.pausedUntil !== undefined) {
        next = Math.min(next, at + Date.parse(entry.pausedUntil) - wall)
      }
    }
    if (!Number.isFinite(next)) {
      disarm()
      return
    }
    if (timer?.at === next) return
    disarm()
    const handle = setTimeout(
      () => {
        timer = undefined
        schedulePump()
      },
      Math.min(Math.max(0, next - at), MAX_TIMER_MS),
    )
    timer = { at: next, handle }
  }

  function disarm(): void {
    if (timer === undefined) return
    clearTimeout(timer.handle)
    timer = undefined
  }

  const unsubscribeGates = gates.onChange(schedulePump)

  return {
    add(batch, items) {
      const createdAt = stamp()
      const { format } = batch.options
      const activeKey = (platform: Platform, id: string, folder: string) =>
        JSON.stringify([platform, id, folder])
      const active = new Map<string, string>()
      for (const entry of jobs.values()) {
        // A job being canceled is on its way out: adding its track again makes a new job.
        if (isTerminalStatus(entry.phase.status) || entry.cancelRequested) continue
        if (entry.options.format !== format) continue
        active.set(activeKey(entry.platform, entry.track.id, entry.folder.real), entry.id)
      }
      const seen = new Map<string, string>()
      const created: Entry[] = []
      const jobIds: string[] = []
      let duplicates = 0
      let refused = 0
      let batchId: string | undefined
      for (const { ref, input, refusal } of items) {
        const platform = input?.platform ?? ref.platform
        const key = JSON.stringify([platform, ref.id])
        const same = seen.get(key) ?? active.get(activeKey(platform, ref.id, batch.folder.real))
        if (same !== undefined) {
          jobIds.push(same)
          duplicates++
          continue
        }
        batchId ??= newId()
        const entry: Entry = {
          id: newId(),
          batchId,
          track: ref,
          url: ref.url,
          folder: batch.folder,
          options: batch.options,
          input,
          platform,
          createdAt,
          attempt: 1,
          strikes: 0,
          seq: 0,
          phase: { status: 'queued' },
          finished: 0,
        }
        const error = refusal ?? (input === undefined ? NOT_A_LINK : undefined)
        if (error !== undefined) {
          setPhase(entry, { status: 'failed', error: checkedError(error), finishedAt: createdAt })
          refused++
        } else {
          enqueue(entry, 'back')
        }
        jobs.set(entry.id, entry)
        seen.set(key, entry.id)
        jobIds.push(entry.id)
        created.push(entry)
      }
      if (batchId === undefined) return { jobIds, duplicates }
      const record: Batch = {
        id: batchId,
        ...(batch.label === undefined ? {} : { label: batch.label }),
        folder: batch.folder.given,
        format,
        createdAt,
      }
      batches.set(batchId, { batch: record, size: created.length })
      bus.emit({ type: 'jobs.added', batch: record, jobs: created.map(toJob) })
      log.info(
        `[queue] Batch ${short(batchId)}: ${created.length} new (${refused} refused), ${duplicates} duplicate${duplicates === 1 ? '' : 's'}`,
      )
      evict()
      schedulePump()
      return { batchId, jobIds, duplicates }
    },

    snapshot() {
      return {
        serverId,
        jobs: Array.from(jobs.values(), toJob),
        batches: Array.from(batches.values(), ({ batch }) => batch),
        queue: queueState(clock(), now()),
      }
    },

    get(id) {
      const entry = jobs.get(id)
      return entry === undefined ? undefined : toJob(entry)
    },

    cancel(id) {
      const entry = jobs.get(id)
      if (entry === undefined) return undefined
      if (requestCancel(entry, stamp())) afterCancel([entry])
      return toJob(entry)
    },

    retry(id) {
      const entry = jobs.get(id)
      if (entry === undefined) return undefined
      if (!canRetry(entry)) return 'not_retryable'
      restart(entry)
      emitUpdated([entry])
      schedulePump()
      return toJob(entry)
    },

    cancelMany(scope) {
      const finishedAt = stamp()
      const changed = inScope(scope).filter((entry) => requestCancel(entry, finishedAt))
      if (changed.length > 0) afterCancel(changed)
      return changed.length
    },

    retryMany(scope, statuses) {
      const wanted: readonly JobStatus[] = statuses
      const changed = inScope(scope).filter(
        (entry) =>
          canRetry(entry) &&
          wanted.includes(entry.phase.status) &&
          (entry.phase.status !== 'failed' || isRetryableError(entry.phase.error.code)),
      )
      for (const entry of changed) restart(entry)
      if (changed.length > 0) {
        emitUpdated(changed)
        schedulePump()
      }
      return changed.length
    },

    clear(scope) {
      const ids: string[] = []
      const batchIds: string[] = []
      for (const entry of inScope(scope)) {
        if (!isTerminalStatus(entry.phase.status)) continue
        remove(entry, batchIds)
        ids.push(entry.id)
      }
      if (ids.length > 0) bus.emit({ type: 'jobs.removed', ids, batchIds })
      return ids.length
    },

    outputPathOf(id) {
      const phase = jobs.get(id)?.phase
      return phase?.status === 'done' || phase?.status === 'skipped' ? phase.outputPath : undefined
    },

    setConcurrency(n) {
      checkConcurrency(n)
      concurrency = n
      schedulePump()
    },

    get closing() {
      return closing
    },

    close() {
      closed ??= (async () => {
        closing = true
        disarm()
        const attempts = Array.from(jobs.values(), (entry) => entry.running).filter(
          (attempt) => attempt !== undefined,
        )
        for (const attempt of attempts) attempt.controller.abort(SHUTDOWN)
        await Promise.all(attempts.map((attempt) => attempt.done))
        disarm()
        unsubscribeGates()
      })()
      return closed
    },
  }
}

function checkCount(name: string, n: number): void {
  if (!(Number.isSafeInteger(n) && n >= 0)) {
    throw new RangeError(`${name} must be a non-negative integer, got ${n}`)
  }
}

function checkConcurrency(n: number): void {
  if (!(Number.isSafeInteger(n) && n >= 1 && n <= MAX_CONCURRENCY)) {
    throw new RangeError(`concurrency must be an integer in [1, ${MAX_CONCURRENCY}], got ${n}`)
  }
}

/** What the gates hear about an attempt's end. */
function gateOutcome(outcome: AttemptOutcome): Parameters<Gates['settled']>[1] {
  switch (outcome.kind) {
    case 'done':
    case 'skipped':
      return 'success'
    case 'failed':
      return outcome.error.code
    case 'canceled':
      return 'other'
  }
}

/**
 * The progress with a percent that never goes back within the attempt (HLS estimates jump around,
 * §9): the highest so far stands until a higher one comes.
 */
function steady(progress: JobProgress, attempt: { percent?: number }): JobProgress {
  const percent = Math.max(progress.percent ?? 0, attempt.percent ?? 0)
  if (progress.percent === undefined && attempt.percent === undefined) return progress
  attempt.percent = percent
  return { ...progress, percent }
}

/** An attempt's error as the contract allows it: a valid code, and a message. */
function checkedError(error: ErrorInfo): ErrorInfo {
  if (ErrorInfoSchema.safeParse(error).success) return error
  const code = ErrorCodeSchema.safeParse(error.code)
  return { code: code.success ? code.data : 'unknown', message: STOPPED.message }
}

/** Job ids in logs: the first 8 characters. */
const short = (id: string): string => id.slice(0, 8)
