// Health bodies for tests, parsed with the shared HealthSchema so they can't drift from the contract.
import {
  type FfmpegHealth,
  type FfprobeHealth,
  type Health,
  HealthSchema,
  type JsRuntime,
  type YtdlpHealth,
} from '@dj-scraper/shared'

// GET /api/health from the dev server on 2026-10-02 (Homebrew yt-dlp 2026.08.19, ffmpeg and
// ffprobe 8.0, deno 2.9.7, node 24.12.0). The node path is swapped for Homebrew's so no home
// directory ends up in the repo.

const ytdlp = {
  status: 'ok',
  path: '/opt/homebrew/bin/yt-dlp',
  source: 'path',
  version: '2026.08.19',
  releaseDate: '2026-08-19',
  ageDays: 44,
  stale: false,
  meetsMinimum: true,
} satisfies YtdlpHealth

const ffmpeg = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffmpeg',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
  mp3: true,
} satisfies FfmpegHealth

const ffprobe = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffprobe',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
} satisfies FfprobeHealth

const deno = {
  name: 'deno',
  path: '/opt/homebrew/bin/deno',
  version: '2.9.7',
  supported: true,
} satisfies JsRuntime

const node = {
  name: 'node',
  path: '/opt/homebrew/Cellar/node/24.12.0/bin/node',
  version: '24.12.0',
  supported: true,
} satisfies JsRuntime

const recorded = {
  ok: true,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp,
  ffmpeg,
  ffprobe,
  jsRuntimes: [deno, node],
} satisfies Health

/** The recorded engine with `changes` on top, validated against the contract. */
export function healthWith(changes: Partial<Health>): Health {
  return HealthSchema.parse({ ...recorded, ...changes })
}

/** Everything found and current: no problems. */
export const healthy = healthWith({})

/** yt-dlp works but is over 60 days old: a warning, and downloads still work. */
export const staleYtdlp = healthWith({
  ytdlp: {
    ...ytdlp,
    version: '2026.06.09',
    releaseDate: '2026-06-09',
    ageDays: 115,
    stale: true,
  },
})

/** ffprobe isn't installed, so the engine isn't ok. The message is the server's own wording. */
export const missingFfprobe = healthWith({
  ok: false,
  ffprobe: {
    status: 'missing',
    message: 'ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
  },
})
