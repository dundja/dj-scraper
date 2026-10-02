import type { FfmpegHealth, FfprobeHealth, Health, YtdlpHealth } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { cachedHealthCheck, HEALTH_TTL_MS, healthWarnings } from './health.ts'

const ytdlpOk = {
  status: 'ok',
  path: '/opt/homebrew/bin/yt-dlp',
  source: 'path',
  version: '2026.08.19',
  releaseDate: '2026-08-19',
  ageDays: 44,
  stale: false,
  meetsMinimum: true,
} satisfies YtdlpHealth

const ffmpegOk = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffmpeg',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
  mp3: true,
} satisfies FfmpegHealth

const ffprobeOk = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffprobe',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
} satisfies FfprobeHealth

const healthy = {
  ok: true,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: ytdlpOk,
  ffmpeg: ffmpegOk,
  ffprobe: ffprobeOk,
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

describe('healthWarnings', () => {
  const warnings = (patch: Partial<Health>) => healthWarnings({ ...healthy, ...patch })

  it('is empty for a healthy engine', () => {
    expect(healthWarnings(healthy)).toEqual([])
  })

  it.each([
    [
      'missing',
      {
        status: 'missing',
        message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
      },
    ],
    [
      'broken',
      {
        status: 'error',
        path: '/x/yt-dlp',
        source: 'env',
        message: 'YTDLP_PATH: /x/yt-dlp does not exist.',
      },
    ],
  ] as const)('passes on the message of a %s yt-dlp', (_label, ytdlp) => {
    expect(warnings({ ytdlp })).toEqual([ytdlp.message])
  })

  it('tells how to upgrade a yt-dlp below the minimum, without also calling it stale', () => {
    const ytdlp = {
      ...ytdlpOk,
      version: '2025.10.22',
      releaseDate: '2025-10-22',
      ageDays: 345,
      stale: true,
      meetsMinimum: false,
    }
    expect(warnings({ ytdlp })).toEqual([
      'yt-dlp 2025.10.22 is too old: run `brew upgrade yt-dlp`.',
    ])
  })

  it('warns about a stale yt-dlp with its age', () => {
    const ytdlp = { ...ytdlpOk, version: '2026.06.09', ageDays: 115, stale: true }
    expect(warnings({ ytdlp })).toEqual([
      'yt-dlp 2026.06.09 is 115 days old (over 60). If YouTube fails, update it or use a nightly build.',
    ])
  })

  it.each([
    ['ffmpeg', { ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' } }],
    ['ffprobe', { ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' } }],
  ] as const)('passes on the message of a missing %s', (name, patch) => {
    expect(warnings(patch)).toEqual([`${name} is not on PATH.`])
  })

  it('passes on the message of a broken ffprobe', () => {
    const ffprobe = {
      status: 'error',
      path: '/x/ffprobe',
      source: 'env',
      message: 'FFMPEG_PATH: /x/ffprobe does not exist.',
    } as const
    expect(warnings({ ffprobe })).toEqual(['FFMPEG_PATH: /x/ffprobe does not exist.'])
  })

  it('tells how to upgrade ffmpeg and ffprobe older than 8', () => {
    const ffmpeg = { ...ffmpegOk, version: '7.1.1', major: 7, meetsMinimum: false }
    const ffprobe = { ...ffprobeOk, version: '7.1.1', major: 7, meetsMinimum: false }
    expect(warnings({ ffmpeg, ffprobe })).toEqual([
      'ffmpeg 7.1.1 is older than 8: run `brew upgrade ffmpeg`.',
      'ffprobe 7.1.1 is older than 8: run `brew upgrade ffmpeg`.',
    ])
  })

  it('warns that MP3 downloads will fail without libmp3lame', () => {
    expect(warnings({ ffmpeg: { ...ffmpegOk, mp3: false } })).toEqual([
      'ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.',
    ])
  })

  it('does not add an MP3 warning for a missing ffmpeg', () => {
    const ffmpeg = { status: 'missing', message: 'ffmpeg is not on PATH.' } as const
    expect(warnings({ ffmpeg })).toEqual(['ffmpeg is not on PATH.'])
  })

  it.each([
    ['no runtime at all', []],
    [
      'only an old deno and an old node',
      [
        { name: 'deno', path: '/opt/homebrew/bin/deno', version: '2.2.12', supported: false },
        { name: 'node', path: '/usr/local/bin/node', version: '20.19.0', supported: false },
      ],
    ],
  ] as const)('warns when there is %s for YouTube', (_label, jsRuntimes) => {
    expect(warnings({ jsRuntimes: [...jsRuntimes] })).toEqual([
      'No supported JS runtime for YouTube: install deno (`brew install deno`) or use Node 22+.',
    ])
  })

  it('accepts an old deno when our node is supported', () => {
    const jsRuntimes = [
      { name: 'deno', path: '/opt/homebrew/bin/deno', version: '2.2.12', supported: false },
      ...healthy.jsRuntimes,
    ] as const
    expect(warnings({ jsRuntimes: [...jsRuntimes] })).toEqual([])
  })

  it('lists one line per problem, in tool order', () => {
    const result = warnings({
      ok: false,
      ytdlp: { status: 'missing', message: 'no yt-dlp' },
      ffmpeg: { ...ffmpegOk, mp3: false },
      ffprobe: { status: 'missing', message: 'no ffprobe' },
      jsRuntimes: [],
    })
    expect(result).toEqual([
      'no yt-dlp',
      'no ffprobe',
      'ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.',
      'No supported JS runtime for YouTube: install deno (`brew install deno`) or use Node 22+.',
    ])
  })
})
