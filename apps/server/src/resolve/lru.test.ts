import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from './lru.ts'

describe('createTtlCache', () => {
  it('returns a value until its TTL has passed', () => {
    let now = 0
    const cache = createTtlCache<string>({ ttlMs: 1000, max: 10, clock: () => now })
    cache.set('a', 'A')
    now = 999
    expect(cache.get('a')).toBe('A')
    now = 1000
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry past `max`', () => {
    const cache = createTtlCache<string>({ ttlMs: 1000, max: 2, clock: () => 0 })
    cache.set('a', 'A')
    cache.set('b', 'B')
    expect(cache.get('a')).toBe('A')
    cache.set('c', 'C')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
    expect(cache.get('c')).toBe('C')
    expect(cache.size).toBe(2)
  })

  it('expires on a monotonic clock by default, whatever the wall clock does', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const cache = createTtlCache<string>({ ttlMs: 60_000, max: 10 })
      cache.set('a', 'A')
      vi.setSystemTime(Date.now() + 60 * 60_000)
      expect(cache.get('a')).toBe('A')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the TTL when a key is set again', () => {
    let now = 0
    const cache = createTtlCache<string>({ ttlMs: 1000, max: 10, clock: () => now })
    cache.set('a', 'old')
    now = 900
    cache.set('a', 'new')
    now = 1500
    expect(cache.get('a')).toBe('new')
  })
})
