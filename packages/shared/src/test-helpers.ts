// Test-only helpers and fixtures. Not exported from index.ts; never import from runtime code.
import type * as z from 'zod'
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
