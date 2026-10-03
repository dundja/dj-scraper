// Test-only helpers and fixtures. Not exported from index.ts; never import from runtime code.
import type * as z from 'zod'
import type { Batch, Job, JobStatus, TrackRef } from './download.ts'
import type { FfmpegHealth, FfprobeHealth, Health, JsRuntime, YtdlpHealth } from './health.ts'

/** Paths of the issues a failed parse reports; empty when the parse succeeds. */
export function issuePaths(schema: z.ZodType, input: unknown): PropertyKey[][] {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path)
}

/** A shallow copy of `value` without `key`. */
export function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))
}

/** The keys of `T` that may be omitted. */
export type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

/** Values every URL field must reject: script, local-file and non-http schemes, a relative path. */
export const nonHttpUrls = [
  'javascript:alert(document.cookie)',
  'file:///Users/dj/Music/',
  'ftp://ftp.example.com/track.mp3',
  '/watch?v=dQw4w9WgXcQ',
]

// A healthy engine, as the server reported it for Homebrew yt-dlp/ffmpeg/deno/node on 2026-10-02.

export const brewYtdlp = {
  status: 'ok',
  path: '/opt/homebrew/bin/yt-dlp',
  source: 'path',
  version: '2026.08.19',
  releaseDate: '2026-08-19',
  ageDays: 44,
  stale: false,
  meetsMinimum: true,
} satisfies YtdlpHealth

export const brewFfmpeg = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffmpeg',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
  mp3: true,
} satisfies FfmpegHealth

export const brewFfprobe = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffprobe',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
} satisfies FfprobeHealth

export const brewDeno = {
  name: 'deno',
  path: '/opt/homebrew/bin/deno',
  version: '2.9.7',
  supported: true,
} satisfies JsRuntime

export const brewNode = {
  name: 'node',
  path: '/opt/homebrew/Cellar/node/24.12.0/bin/node',
  version: '24.12.0',
  supported: true,
} satisfies JsRuntime

export const healthy = {
  ok: true,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: brewYtdlp,
  ffmpeg: brewFfmpeg,
  ffprobe: brewFfprobe,
  jsRuntimes: [brewDeno, brewNode],
} satisfies Health

/**
 * A valid RFC 9562 version-4 UUID, distinct for every integer `n` in [0, 2^48):
 * `testUuid(1)` is `00000000-0000-4000-8000-000000000001`. z.uuid() checks the version and variant
 * digits, so made-up ids such as `job-1` or `00000000-0000-0000-0000-000000000001` fail where these pass.
 */
export function testUuid(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 2 ** 48) {
    throw new RangeError(`testUuid needs an integer in [0, 2^48), got ${n}`)
  }
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

// Downloads: two refs, one batch and a job in every status. Ids come from testUuid.

/** A YouTube track as the review screen sends it: display fields known, the stream not needed. */
export const youtubeRef = {
  platform: 'youtube',
  id: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
  artist: 'Rick Astley',
  uploader: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  availability: 'available',
} satisfies TrackRef

/** A SoundCloud set row as `--flat-playlist` lists it, never enriched: id and an API URL only. */
export const soundcloudRowRef = {
  platform: 'soundcloud',
  id: '1234567893',
  url: 'https://api-v2.soundcloud.com/tracks/1234567893',
} satisfies TrackRef

export const testBatch = {
  id: testUuid(100),
  label: 'Summer 2026',
  folder: '/Users/dj/Music/DJ Scraper/Summer 2026',
  format: 'mp3',
  createdAt: '2026-10-02T08:00:00.000Z',
} satisfies Batch

const jobBase = {
  batchId: testBatch.id,
  track: youtubeRef,
  format: 'mp3',
  folder: testBatch.folder,
  attempt: 1,
  createdAt: '2026-10-02T08:00:00.000Z',
} satisfies Omit<Job, 'id' | 'status'>

const startedAt = '2026-10-02T08:00:05.000Z'
const finishedAt = '2026-10-02T08:00:41.250Z'
const youtubeOpus = { codec: 'opus', bitrateKbps: 135.817 }
const outputPath =
  '/Users/dj/Music/DJ Scraper/Summer 2026/Rick Astley - Never Gonna Give You Up.mp3'

/** One valid job per status, with the fields that state allows filled in. */
export const jobsByStatus = {
  queued: { ...jobBase, id: testUuid(1), status: 'queued' },
  downloading: {
    ...jobBase,
    id: testUuid(2),
    status: 'downloading',
    startedAt,
    source: youtubeOpus,
    progress: {
      percent: 42.5,
      downloadedBytes: 1_712_128,
      totalBytes: 4_028_536,
      speedBps: 851_200,
      etaSec: 3,
    },
  },
  processing: { ...jobBase, id: testUuid(3), status: 'processing', startedAt, source: youtubeOpus },
  done: {
    ...jobBase,
    id: testUuid(4),
    status: 'done',
    startedAt,
    source: youtubeOpus,
    outputPath,
    output: {
      ext: 'mp3',
      codec: 'mp3',
      bitrateKbps: 320,
      sampleRateHz: 48_000,
      channels: 2,
      encoded: true,
    },
    finishedAt,
  },
  skipped: { ...jobBase, id: testUuid(5), status: 'skipped', startedAt, outputPath, finishedAt },
  failed: {
    ...jobBase,
    id: testUuid(6),
    track: soundcloudRowRef,
    status: 'failed',
    attempt: 2,
    startedAt,
    error: { code: 'network', message: 'The connection dropped. Retry to try again.' },
    finishedAt,
  },
  canceled: { ...jobBase, id: testUuid(7), status: 'canceled', finishedAt },
} satisfies { [S in JobStatus]: Extract<Job, { status: S }> }
