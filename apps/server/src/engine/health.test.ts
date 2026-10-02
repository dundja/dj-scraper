import type { Health } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { cachedHealthCheck, HEALTH_TTL_MS } from './health.ts'

const healthy = {
  ok: true,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: {
    status: 'ok',
    path: '/opt/homebrew/bin/yt-dlp',
    source: 'path',
    version: '2026.08.19',
    releaseDate: '2026-08-19',
    ageDays: 44,
    stale: false,
    meetsMinimum: true,
  },
  ffmpeg: {
    status: 'ok',
    path: '/opt/homebrew/bin/ffmpeg',
    source: 'path',
    version: '8.0',
    major: 8,
    meetsMinimum: true,
    mp3: true,
  },
  ffprobe: {
    status: 'ok',
    path: '/opt/homebrew/bin/ffprobe',
    source: 'path',
    version: '8.0',
    major: 8,
    meetsMinimum: true,
  },
  jsRuntimes: [{ name: 'node', path: '/usr/local/bin/node', version: '24.12.0', supported: true }],
} satisfies Health

const withCheckedAt = (checkedAt: string): Health => ({ ...healthy, checkedAt })

/** A check() whose calls are counted and each settled by hand. */
function controlledCheck() {
  const pending: { resolve: (health: Health) => void; reject: (error: Error) => void }[] = []
  const check = () =>
    new Promise<Health>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  return {
    check,
    calls: () => pending.length,
    resolve: (index: number, health: Health) => pending[index]?.resolve(health),
    reject: (index: number, error: Error) => pending[index]?.reject(error),
  }
}

/** Lets the cache's own settle handlers run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup(ttlMs = 1_000) {
  let now = 0
  const control = controlledCheck()
  const health = cachedHealthCheck(control.check, { ttlMs, clock: () => now })
  return {
    ...control,
    health,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('cachedHealthCheck', () => {
  it('reuses a result for its TTL and checks again once it has expired', async () => {
    const t = setup(1_000)
    const first = t.health.current()
    t.resolve(0, withCheckedAt('2026-10-02T08:00:00.000Z'))
    expect((await first).checkedAt).toBe('2026-10-02T08:00:00.000Z')

    t.advance(999)
    expect((await t.health.current()).checkedAt).toBe('2026-10-02T08:00:00.000Z')
    expect(t.calls()).toBe(1)

    t.advance(1)
    const second = t.health.current()
    expect(t.calls()).toBe(2)
    t.resolve(1, withCheckedAt('2026-10-02T08:00:01.000Z'))
    expect((await second).checkedAt).toBe('2026-10-02T08:00:01.000Z')
  })

  it('measures the TTL from when a check started, not when it finished', async () => {
    const t = setup(1_000)
    const first = t.health.current()
    t.advance(800) // a slow probe
    t.resolve(0, healthy)
    await first
    t.advance(200)
    void t.health.current()
    expect(t.calls()).toBe(2)
  })

  it('shares one in-flight check between concurrent callers', async () => {
    const t = setup()
    const a = t.health.current()
    const b = t.health.current()
    const c = t.health.recheck()
    expect(t.calls()).toBe(1)
    t.resolve(0, healthy)
    expect(await Promise.all([a, b, c])).toEqual([healthy, healthy, healthy])
  })

  it('lets current() join a recheck that is still running', async () => {
    const t = setup()
    const first = t.health.current()
    t.resolve(0, withCheckedAt('2026-10-02T08:00:00.000Z'))
    await first
    await flush()

    const recheck = t.health.recheck()
    const current = t.health.current()
    expect(t.calls()).toBe(2)
    t.resolve(1, withCheckedAt('2026-10-02T08:05:00.000Z'))
    expect((await current).checkedAt).toBe('2026-10-02T08:05:00.000Z')
    expect(await recheck).toEqual(await current)
  })

  it('forces a new check on recheck once the last one has settled, even within the TTL', async () => {
    const t = setup(HEALTH_TTL_MS)
    const first = t.health.current()
    t.resolve(0, withCheckedAt('2026-10-02T08:00:00.000Z'))
    await first
    await flush()

    const recheck = t.health.recheck()
    expect(t.calls()).toBe(2)
    t.resolve(1, withCheckedAt('2026-10-02T08:00:30.000Z'))
    await recheck
    await flush()

    // The recheck's result now serves current().
    expect((await t.health.current()).checkedAt).toBe('2026-10-02T08:00:30.000Z')
    expect(t.calls()).toBe(2)
  })

  it('does not cache a failure: the next call checks again', async () => {
    const t = setup()
    const failing = t.health.current()
    t.reject(0, new Error('probe crashed'))
    await expect(failing).rejects.toThrow('probe crashed')

    const retry = t.health.current()
    expect(t.calls()).toBe(2)
    t.resolve(1, healthy)
    expect(await retry).toEqual(healthy)
  })

  it('gives every caller sharing a failed check the same rejection', async () => {
    const t = setup()
    const a = t.health.current()
    const b = t.health.recheck()
    t.reject(0, new Error('probe crashed'))
    await expect(a).rejects.toThrow('probe crashed')
    await expect(b).rejects.toThrow('probe crashed')
    expect(t.calls()).toBe(1)
  })

  it('keeps a newer check when an older, expired one fails afterwards', async () => {
    const t = setup(1_000)
    const old = t.health.current()
    t.advance(1_000) // the slow first check is now past its TTL
    const fresh = t.health.current()
    expect(t.calls()).toBe(2)

    t.reject(0, new Error('old probe crashed'))
    await expect(old).rejects.toThrow('old probe crashed')
    await flush()

    t.resolve(1, healthy)
    expect(await fresh).toEqual(healthy)
    await flush()
    expect(await t.health.current()).toEqual(healthy)
    expect(t.calls()).toBe(2)
  })

  it('caches with the default TTL and clock', async () => {
    let calls = 0
    const health = cachedHealthCheck(async () => {
      calls++
      return healthy
    })
    await health.current()
    await health.current()
    expect(calls).toBe(1)
  })
})
