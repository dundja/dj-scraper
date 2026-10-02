import type { Health } from '@dj-scraper/shared'
import { YTDLP_STALE_AFTER_DAYS } from './versions.ts'

/** Probing spawns 4 processes (up to ~12 s for a onefile yt-dlp), so results are reused. */
export const HEALTH_TTL_MS = 10 * 60_000

export type HealthCheck = {
  /** The cached result while fresh, else a new check. Concurrent callers share one check. */
  current: () => Promise<Health>
  /** A new check now (e.g. after the user installed yt-dlp), unless one is already running. */
  recheck: () => Promise<Health>
}

export function cachedHealthCheck(
  check: () => Promise<Health>,
  { ttlMs = HEALTH_TTL_MS, clock = Date.now }: { ttlMs?: number; clock?: () => number } = {},
): HealthCheck {
  let entry: { promise: Promise<Health>; startedAt: number; settled: boolean } | undefined

  const start = (): Promise<Health> => {
    const current = { promise: check(), startedAt: clock(), settled: false }
    entry = current
    current.promise.then(
      () => {
        current.settled = true
      },
      () => {
        // Don't cache a failure: the next call checks again.
        if (entry === current) entry = undefined
      },
    )
    return current.promise
  }

  return {
    current: () => (entry && clock() - entry.startedAt < ttlMs ? entry.promise : start()),
    recheck: () => (entry && !entry.settled ? entry.promise : start()),
  }
}

/** One line per problem, for the server log at boot. Empty when everything is fine. */
export function healthWarnings(health: Health): string[] {
  const warnings: string[] = []
  const { ytdlp, ffmpeg, ffprobe, jsRuntimes } = health
  if (ytdlp.status !== 'ok') warnings.push(ytdlp.message)
  else {
    if (!ytdlp.meetsMinimum)
      warnings.push(`yt-dlp ${ytdlp.version} is too old: run \`brew upgrade yt-dlp\`.`)
    else if (ytdlp.stale) {
      warnings.push(
        `yt-dlp ${ytdlp.version} is ${ytdlp.ageDays} days old (over ${YTDLP_STALE_AFTER_DAYS}). If YouTube fails, update it or use a nightly build.`,
      )
    }
  }
  for (const [name, tool] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', ffprobe],
  ] as const) {
    if (tool.status !== 'ok') warnings.push(tool.message)
    else if (tool.major === undefined)
      warnings.push(`${name} ${tool.version}: can't tell its version; DJ Scraper needs 8 or newer.`)
    else if (!tool.meetsMinimum)
      warnings.push(`${name} ${tool.version} is older than 8: run \`brew upgrade ffmpeg\`.`)
  }
  if (ffmpeg.status === 'ok' && !ffmpeg.mp3)
    warnings.push('ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.')
  if (!jsRuntimes.some((runtime) => runtime.supported)) {
    warnings.push(
      'No supported JS runtime for YouTube: install deno (`brew install deno`) or use Node 22+.',
    )
  }
  return warnings
}
