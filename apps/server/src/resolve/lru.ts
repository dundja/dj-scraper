import { monotonicClock } from './limiter.ts'

export type TtlCache<V> = {
  /** The value while fresh (and marks it recently used), else undefined. */
  get: (key: string) => V | undefined
  set: (key: string, value: V) => void
  readonly size: number
}

/**
 * A small LRU map whose entries expire `ttlMs` after they were set. Enriched rows are cached so
 * scrolling back over a set doesn't spend SoundCloud's request budget twice.
 */
export function createTtlCache<V>({
  ttlMs,
  max,
  clock = monotonicClock,
}: {
  ttlMs: number
  max: number
  /** Default `monotonicClock`: a wall-clock step must not expire or prolong every entry. */
  clock?: () => number
}): TtlCache<V> {
  // A Map iterates in insertion order, so re-inserting on use keeps the oldest first.
  const entries = new Map<string, { value: V; expiresAt: number }>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      entries.delete(key)
      if (clock() >= entry.expiresAt) return undefined
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, { value, expiresAt: clock() + ttlMs })
      for (const oldest of entries.keys()) {
        if (entries.size <= max) break
        entries.delete(oldest)
      }
    },
    get size() {
      return entries.size
    },
  }
}
