import type { Health } from '@dj-scraper/shared'

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
