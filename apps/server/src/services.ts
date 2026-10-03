import { randomUUID } from 'node:crypto'
import type { Platform } from '@dj-scraper/shared'
import { type EngineEnv, locateEngine } from './engine/binaries.ts'
import { createFinalize } from './engine/finalize.ts'
import { createPublish } from './fs/move.ts'
import { createRunAttempt } from './jobs/attempt.ts'
import { type Bus, createBus } from './jobs/bus.ts'
import { createQueue, type Queue } from './jobs/queue.ts'
import type { EngineBins, RunAttempt } from './jobs/types.ts'
import {
  type Cooldown,
  createGates,
  DOWNLOAD_COOLDOWN,
  type Gates,
  SOUNDCLOUD_DOWNLOAD_RESERVE,
  YOUTUBE_DOWNLOAD_BUDGET,
} from './pacing/gates.ts'
import { createTokenBucket, type TokenBucket } from './pacing/token-bucket.ts'
import {
  createEnricher,
  DEFAULT_PACING,
  type Enricher,
  type Pacing,
  SOUNDCLOUD_LOOKUP_BUDGET,
} from './resolve/enricher.ts'
import { createResolver, type Resolver } from './resolve/resolver.ts'
import type { Logger } from './resolve/ytdlp-call.ts'
import { createEventStreams, type EventStreams } from './routes/events.ts'
import type { SettingsStore } from './settings/store.ts'

/** How lookups and downloads are paced (ADR-014, ADR-017). */
export type ServicePacing = {
  /** The enricher's lookups, per platform. */
  lookups: Pacing
  /** The download gates' buckets: a platform without one is not paced, only paused. */
  downloads: Partial<Record<Platform, TokenBucket>>
  /** Tokens downloads leave in a bucket they share with the lookups. */
  downloadReserve: Partial<Record<Platform, number>>
  /** The download pause after a rate limit. */
  cooldown: Cooldown
}

/**
 * The real pacing, with fresh buckets: one SoundCloud bucket for lookups and downloads (D8), of
 * which downloads leave the last tokens to the lookups of rows in view, and a YouTube bucket for
 * downloads alone.
 */
export function productionPacing(): ServicePacing {
  const soundcloud = createTokenBucket(SOUNDCLOUD_LOOKUP_BUDGET)
  return {
    lookups: {
      ...DEFAULT_PACING,
      soundcloud: { ...DEFAULT_PACING.soundcloud, budget: soundcloud },
    },
    downloads: { youtube: createTokenBucket(YOUTUBE_DOWNLOAD_BUDGET), soundcloud },
    downloadReserve: { soundcloud: SOUNDCLOUD_DOWNLOAD_RESERVE },
    cooldown: DOWNLOAD_COOLDOWN,
  }
}

/** Test knobs. The server and `pnpm smoke` pass none. */
export type ServiceOverrides = {
  /** Default `productionPacing()`. */
  pacing?: ServicePacing
  /** Replaces the bus, e.g. with one that records every event. */
  bus?: Bus
  /** Wraps the real attempt, e.g. to count or hold attempts. */
  wrapAttempt?: (attempt: RunAttempt) => RunAttempt
  /** Jobs at once. Default the settings'. */
  concurrency?: number
  maxRetainedTerminal?: number
  /** The event streams' heartbeat. */
  heartbeatMs?: number
}

export type ServicesOptions = {
  engine: EngineEnv
  /** The data dir's real path: attempts make their job dirs in its `jobs/`. */
  dataDirReal: string
  settings: Pick<SettingsStore, 'get'>
  /** Checks every event and snapshot against the contract (dev, tests and the smoke). */
  assertContract: boolean
  log?: Logger
  overrides?: ServiceOverrides
}

export type AppServices = {
  resolver: Resolver
  enricher: Enricher
  gates: Gates
  bus: Bus
  queue: Queue
  streams: EventStreams
  /** Finds yt-dlp, ffmpeg and ffprobe without running them (enqueue checks, every attempt). */
  locate: () => Promise<EngineBins>
}

/**
 * The services behind the routes, wired as the server runs them: the resolver, the enricher and
 * the download pipeline (gates, queue, attempt, finalize, publish), the bus and the event streams.
 * The server, `pnpm smoke --download` and the downloads test harness all build them here.
 */
export function createServices({
  engine,
  dataDirReal,
  settings,
  assertContract,
  log = console,
  overrides = {},
}: ServicesOptions): AppServices {
  const pacing = overrides.pacing ?? productionPacing()
  const resolver = createResolver({ engine, log })
  const enricher = createEnricher({ engine, log, pacing: pacing.lookups })
  const gates = createGates({
    buckets: pacing.downloads,
    downloadReserve: pacing.downloadReserve,
    cooldown: pacing.cooldown,
  })
  const bus = overrides.bus ?? createBus({ assertContract, log })
  const locate = () => locateEngine(engine)
  const attempt = createRunAttempt({
    dataDir: dataDirReal,
    locate,
    finalize: createFinalize({ log }),
    publish: createPublish(),
    ...(engine.FFMPEG_PATH === undefined ? {} : { ffmpegLocation: engine.FFMPEG_PATH }),
    log,
  })
  const queue = createQueue({
    runAttempt: overrides.wrapAttempt?.(attempt) ?? attempt,
    gates,
    bus,
    serverId: randomUUID(),
    concurrency: overrides.concurrency ?? settings.get().concurrency,
    maxRetainedTerminal: overrides.maxRetainedTerminal,
    log,
  })
  const streams = createEventStreams({
    bus,
    snapshot: () => queue.snapshot(),
    assertContract,
    heartbeatMs: overrides.heartbeatMs,
    log,
  })
  return { resolver, enricher, gates, bus, queue, streams, locate }
}
