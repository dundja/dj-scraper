import type { EntryRef, ErrorInfo, Platform, Track, ValidUrl } from '@dj-scraper/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEnv } from '../engine/binaries.ts'
import { type RunOptions, type RunResult, type run, SpawnError } from '../engine/run.ts'
import { entryArgs } from '../engine/ytdlp-args.ts'
import { mapYtdlpError } from '../engine/ytdlp-errors.ts'
import { InfoParseError, normalizeEntry } from '../engine/ytdlp-parse.ts'
import { ApiError } from '../http/errors.ts'
import {
  createEnricher,
  type EnricherDeps,
  type Pacing,
  SOUNDCLOUD_LOOKUP_BUDGET,
} from './enricher.ts'

// The parser and the error mapper have their own fixture tests; here they are stand-ins.
vi.mock('../engine/ytdlp-parse.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/ytdlp-parse.ts')>()),
  normalizeInfo: vi.fn(),
  normalizeEntry: vi.fn(),
}))
vi.mock('../engine/ytdlp-errors.ts', () => ({ mapYtdlpError: vi.fn() }))

/** Any existing executable, for the tests on the real locator: the fake run never starts it. */
const ENGINE = { YTDLP_PATH: process.execPath }
/** What the fake locator finds. */
const YTDLP = '/opt/homebrew/bin/yt-dlp'
const NODE = '/opt/homebrew/bin/node'

type Locate = NonNullable<EnricherDeps['locate']>

const sc = (id: string): EntryRef => ({
  platform: 'soundcloud',
  id,
  url: `https://api.soundcloud.com/tracks/${id}`,
})
const yt = (id: string): EntryRef => ({
  platform: 'youtube',
  id,
  url: `https://www.youtube.com/watch?v=${id.padEnd(11, '0')}`,
})
/** `count` SoundCloud rows with ids `from`, `from + 1`, … */
const scRows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sc(String(from + i)))

/** A promise the test settles by hand. */
function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** What the stand-in parser makes of a lookup: a Track named after the id yt-dlp printed. */
const trackFor = (id: string, input: ValidUrl): Track => ({
  id,
  platform: input.platform,
  url: input.url,
  title: `Track ${id}`,
  availability: 'available',
})

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: '{}',
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 12,
  ...overrides,
})

/** The id at the end of an entry URL (api …/tracks/<id> or watch?v=<id>). */
const idOf = (url: string) => {
  const parsed = new URL(url)
  return (parsed.searchParams.get('v') ?? parsed.pathname.split('/').at(-1) ?? '').replace(
    /0+$/,
    '',
  )
}

const ok = (url: string) => result({ stdout: JSON.stringify({ id: idOf(url) }) })
const rateLimited = () => result({ exitCode: 1, stdout: '', stderr: 'ERROR: HTTP Error 429' })
const removed = () => result({ exitCode: 1, stdout: '', stderr: 'ERROR: track removed' })

type Responder = (url: string, options: RunOptions) => RunResult | Promise<RunResult>

/**
 * Virtual time: each sleep registers a wake-up, and on every later turn the clock jumps to the
 * earliest one. Concurrent sleeps overlap as they would with real timers.
 */
function fakeTime() {
  const time = { now: 1_000_000 }
  const timers: { at: number; wake: () => void }[] = []
  let scheduled = false
  const tick = () => {
    scheduled = false
    timers.sort((a, b) => a.at - b.at)
    const next = timers.shift()
    if (next === undefined) return
    time.now = Math.max(time.now, next.at)
    next.wake()
    schedule()
  }
  const schedule = () => {
    if (scheduled || timers.length === 0) return
    scheduled = true
    setImmediate(tick)
  }
  return {
    time,
    clock: () => time.now,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        timers.push({ at: time.now + ms, wake })
        schedule()
      }),
  }
}

function setup({
  respond = ok as Responder,
  engine = ENGINE,
  realLocator = false,
  pacing,
  cacheTtlMs,
  cacheMax,
}: {
  respond?: Responder
  engine?: EngineEnv
  /**
   * Use the default locator (findYtdlp), whose file checks finish at any point of the fake time.
   * Only for one request at a time: its rows all wait for the same lookup, so none jumps the queue.
   */
  realLocator?: boolean
  pacing?: Pacing
  cacheTtlMs?: number
  cacheMax?: number
} = {}) {
  const { time, clock, sleep } = fakeTime()
  const starts: { url: string; at: number }[] = []
  const runFn = vi.fn<typeof run>(async (_bin, argv, options = {}) => {
    const url = argv.at(-1) ?? ''
    starts.push({ url, at: time.now })
    return respond(url, options)
  })
  // Already settled when it returns, so a request's rows join the pacing queue within the
  // microtasks of its enrich() call: concurrent requests queue in call order, before the fake
  // clock can move.
  const locate = vi.fn<Locate>(async () => YTDLP)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const enricher = createEnricher({
    engine,
    run: runFn,
    ...(realLocator ? {} : { locate }),
    jsRuntime: NODE,
    clock,
    sleep,
    log,
    ...(pacing ? { pacing } : {}),
    ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
    ...(cacheMax === undefined ? {} : { cacheMax }),
  })
  const enrich = (entries: EntryRef[], signal?: AbortSignal) => enricher.enrich({ entries }, signal)
  return { enricher, enrich, run: runFn, locate, starts, time, log }
}

/** Results reduced to `id → ok | code`, in order. */
const outcome = (response: Awaited<ReturnType<ReturnType<typeof setup>['enrich']>>) =>
  response.results.map((r) => [r.id, r.status === 'ok' ? 'ok' : r.error.code])

async function apiError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  if (!(error instanceof ApiError)) throw error
  return { code: error.code, message: error.message }
}

/** A run that hangs until its signal aborts, then reports the abort as run() does. */
const untilAborted = (options: RunOptions) =>
  new Promise<RunResult>((resolve) => {
    options.signal?.addEventListener('abort', () =>
      resolve(result({ aborted: true, exitCode: null, signal: 'SIGINT' })),
    )
  })

const logged = (log: ReturnType<typeof setup>['log']) =>
  [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')

beforeEach(() => {
  vi.mocked(normalizeEntry).mockImplementation((info, input) => {
    const id = typeof info === 'object' && info !== null && 'id' in info ? String(info.id) : ''
    return trackFor(id, input)
  })
  vi.mocked(mapYtdlpError).mockImplementation(({ stderr }): ErrorInfo => {
    if (stderr.includes('429')) return { code: 'rate_limited', message: 'Too many requests.' }
    if (stderr.includes('removed')) return { code: 'unavailable', message: 'Track removed.' }
    return { code: 'unknown', message: stderr || 'yt-dlp failed' }
  })
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('enricher.enrich', () => {
  it('looks up each row in full and returns its Track, keyed by the request platform + id', async () => {
    const { enrich, run, locate } = setup()
    const response = await enrich([sc('1001')])

    expect(response).toStrictEqual({
      results: [
        {
          status: 'ok',
          platform: 'soundcloud',
          id: '1001',
          track: {
            id: '1001',
            platform: 'soundcloud',
            url: 'https://api.soundcloud.com/tracks/1001',
            title: 'Track 1001',
            availability: 'available',
          },
        },
      ],
    })
    expect(locate).toHaveBeenCalledExactlyOnceWith(ENGINE)
    const [bin, argv, options] = run.mock.calls[0] ?? []
    expect(bin).toBe(YTDLP)
    expect(argv).toEqual(
      entryArgs({ url: 'https://api.soundcloud.com/tracks/1001', jsRuntime: NODE }),
    )
    expect(options).toMatchObject({ timeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes yt-dlp the normalized URL of a row, not the one the request sent', async () => {
    const { enrich, run } = setup()
    await enrich([{ ...sc('1'), url: 'HTTPS://API.SoundCloud.COM./tracks/1' }])
    expect(run.mock.calls[0]?.[1].at(-1)).toBe('https://api.soundcloud.com/tracks/1')
  })

  it('answers each distinct platform + id once, in first-seen order', async () => {
    const { enrich, run } = setup()
    const duplicate = { ...sc('1'), url: 'https://soundcloud.com/someone/a-track' }
    const response = await enrich([sc('2'), sc('1'), duplicate, yt('1'), sc('3'), sc('2')])
    expect(response.results.map((r) => `${r.platform}:${r.id}`)).toEqual([
      'soundcloud:2',
      'soundcloud:1',
      'youtube:1',
      'soundcloud:3',
    ])
    expect(run).toHaveBeenCalledTimes(4)
    expect(run.mock.calls.map(([, argv]) => argv.at(-1))).not.toContain(duplicate.url)
  })

  it.each([
    ['embedded credentials', 'https://dj:pw@soundcloud.com/someone/a-track', 'invalid_url'],
    ['a DRM service', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'unsupported_url'],
    ['a SoundCloud set', 'https://soundcloud.com/someone/sets/a-set', 'invalid_request'],
    ['a YouTube playlist', 'https://www.youtube.com/playlist?list=PLabc', 'invalid_request'],
  ])('fails a row with %s on its own, without starting yt-dlp', async (_label, url, code) => {
    const { enrich, run } = setup()
    const response = await enrich([{ platform: 'soundcloud', id: 'bad', url }, sc('1')])
    expect(outcome(response)).toEqual([
      ['bad', code],
      ['1', 'ok'],
    ])
    expect(run).toHaveBeenCalledOnce()
  })

  it('keeps the batch when rows fail: removed, timed out, unreadable or off-contract', async () => {
    vi.mocked(normalizeEntry).mockImplementation((info, input) => {
      const id = typeof info === 'object' && info !== null && 'id' in info ? String(info.id) : ''
      if (id === '4') throw new InfoParseError('not a single track')
      if (id === '5') return { ...trackFor(id, input), thumbnailUrl: 'file:///etc/passwd' }
      return trackFor(id, input)
    })
    const { enrich, log } = setup({
      respond: (url) => {
        const id = idOf(url)
        if (id === '2') return removed()
        if (id === '3') return result({ timedOut: true, exitCode: null })
        return ok(url)
      },
    })
    const response = await enrich([sc('1'), sc('2'), sc('3'), sc('4'), sc('5')])
    expect(outcome(response)).toEqual([
      ['1', 'ok'],
      ['2', 'unavailable'],
      ['3', 'network'],
      ['4', 'unknown'],
      ['5', 'unknown'],
    ])
    expect(response.results[2]).toMatchObject({
      error: { message: "yt-dlp didn't answer within 60 s." },
    })
    expect(log.warn).toHaveBeenCalledWith('[resolve/entries] "soundcloud:4": not a single track')
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('"soundcloud:5": off-contract track'),
    )
  })

  it('quotes the key in a warning, so a requested id cannot forge a log line', async () => {
    vi.mocked(normalizeEntry).mockImplementation(() => {
      throw new InfoParseError('not a single track')
    })
    const { enrich, log } = setup()
    await enrich([{ ...sc('4'), id: '4\n[resolve/entries] forged' }])
    expect(log.warn).toHaveBeenCalledWith(
      '[resolve/entries] "soundcloud:4\\n[resolve/entries] forged": not a single track',
    )
    expect(logged(log)).not.toContain('\n[resolve/entries] forged')
  })

  describe('engine', () => {
    it('fails the whole request with engine_missing when yt-dlp is not found', async () => {
      const { enrich, run } = setup({
        engine: { YTDLP_PATH: '/nonexistent/yt-dlp' },
        realLocator: true,
      })
      expect(await apiError(enrich([sc('1'), sc('2')]))).toEqual({
        code: 'engine_missing',
        message: 'YTDLP_PATH: /nonexistent/yt-dlp does not exist.',
      })
      expect(run).not.toHaveBeenCalled()
    })

    it('finds yt-dlp with findYtdlp by default, in the engine as it is at request time', async () => {
      const engine = { YTDLP_PATH: process.execPath }
      const { enrich, run } = setup({ engine, realLocator: true })
      await enrich([sc('1')])
      expect(run.mock.calls[0]?.[0]).toBe(process.execPath)

      engine.YTDLP_PATH = '/nonexistent/yt-dlp'
      expect(await apiError(enrich([sc('2')]))).toEqual({
        code: 'engine_missing',
        message: 'YTDLP_PATH: /nonexistent/yt-dlp does not exist.',
      })
      expect(run).toHaveBeenCalledOnce()
    })

    it('fails the whole request with engine_missing when yt-dlp cannot start', async () => {
      const { enrich } = setup({
        respond: () => {
          throw new SpawnError('yt-dlp', Object.assign(new Error('x'), { code: 'ENOENT' }))
        },
      })
      expect(await apiError(enrich([sc('1'), sc('2')]))).toMatchObject({ code: 'engine_missing' })
    })

    it('finds yt-dlp once per request, and not at all when every row is cached or refused', async () => {
      const { enrich, run, locate } = setup()
      await enrich([sc('1'), sc('2')])
      expect(locate).toHaveBeenCalledExactlyOnceWith(ENGINE)

      const response = await enrich([
        sc('1'),
        { platform: 'soundcloud', id: 'x', url: 'https://open.spotify.com/track/1' },
      ])
      expect(outcome(response)).toEqual([
        ['1', 'ok'],
        ['x', 'unsupported_url'],
      ])
      expect(locate).toHaveBeenCalledOnce()

      // Never remembered across requests: a yt-dlp gone since fails the next request, and one
      // installed since serves the request after it without a restart.
      locate.mockRejectedValueOnce(new ApiError('engine_missing', 'yt-dlp is not on PATH.'))
      expect(await apiError(enrich([sc('3')]))).toMatchObject({ code: 'engine_missing' })
      expect(outcome(await enrich([sc('3')]))).toEqual([['3', 'ok']])
      expect(locate).toHaveBeenCalledTimes(3)
      expect(run).toHaveBeenCalledTimes(3)
    })
  })

  describe('cache', () => {
    it('answers a row looked up before from the cache, without starting yt-dlp', async () => {
      const { enrich, run } = setup()
      await enrich([sc('1'), sc('2')])
      const again = await enrich([sc('2'), sc('1')])
      expect(outcome(again)).toEqual([
        ['2', 'ok'],
        ['1', 'ok'],
      ])
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('looks a row up again once its entry has expired', async () => {
      const { enrich, run, time } = setup({ cacheTtlMs: 60_000 })
      await enrich([sc('1')])
      time.now += 60_000
      await enrich([sc('1')])
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('evicts the least recently used row past cacheMax', async () => {
      const { enrich, run } = setup({ cacheMax: 2 })
      await enrich([sc('1'), sc('2')])
      await enrich([sc('1')])
      await enrich([sc('3')])
      expect(run).toHaveBeenCalledTimes(3)
      await enrich([sc('1')])
      expect(run).toHaveBeenCalledTimes(3)
      await enrich([sc('2')])
      expect(run).toHaveBeenCalledTimes(4)
    })

    it('peeks at a cached row without a lookup, by the platform of its URL + its id', async () => {
      const { enricher, enrich, run, locate, time } = setup({ cacheTtlMs: 60_000 })
      expect(enricher.peek('soundcloud', '1')).toBeUndefined()
      await enrich([sc('1'), yt('abc')])
      expect(enricher.peek('soundcloud', '1')).toEqual({
        id: '1',
        platform: 'soundcloud',
        url: 'https://api.soundcloud.com/tracks/1',
        title: 'Track 1',
        availability: 'available',
      })
      expect(enricher.peek('youtube', 'abc')?.title).toBe('Track abc')
      // Another platform's row with the same id is another row.
      expect(enricher.peek('youtube', '1')).toBeUndefined()
      expect(run).toHaveBeenCalledTimes(2)
      expect(locate).toHaveBeenCalledTimes(1)
      time.now += 60_000
      expect(enricher.peek('soundcloud', '1')).toBeUndefined()
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('peeks at nothing for a row whose lookup failed', async () => {
      const { enricher, enrich } = setup({ respond: removed })
      await enrich([sc('1')])
      expect(enricher.peek('soundcloud', '1')).toBeUndefined()
    })

    it('does not cache a failed row', async () => {
      let calls = 0
      const { enrich, run } = setup({ respond: (url) => (calls++ === 0 ? removed() : ok(url)) })
      expect(outcome(await enrich([sc('1')]))).toEqual([['1', 'unavailable']])
      expect(outcome(await enrich([sc('1')]))).toEqual([['1', 'ok']])
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  describe('pacing', () => {
    it('starts SoundCloud lookups at least 1 s apart', async () => {
      const { enrich, starts } = setup()
      await enrich([sc('1'), sc('2'), sc('3'), sc('4')])
      const t0 = starts[0]?.at ?? 0
      expect(starts.map((s) => s.at - t0)).toEqual([0, 1000, 2000, 3000])
    })

    it('starts YouTube lookups 500 ms apart, independently of SoundCloud', async () => {
      const { enrich, starts } = setup()
      await enrich([sc('1'), sc('2'), yt('1'), yt('2')])
      const t0 = Math.min(...starts.map((s) => s.at))
      const at = (url: string) => (starts.find((s) => s.url === url)?.at ?? -1) - t0
      expect([at(sc('1').url), at(sc('2').url)]).toEqual([0, 1000])
      expect([at(yt('1').url), at(yt('2').url)]).toEqual([0, 500])
    })

    it('runs at most 2 lookups per platform at once', async () => {
      let running = 0
      let peak = 0
      const { enrich } = setup({
        pacing: {
          soundcloud: { concurrency: 2, minIntervalMs: 0 },
          youtube: { concurrency: 2, minIntervalMs: 0 },
          other: { concurrency: 2, minIntervalMs: 0 },
        },
        respond: async (url) => {
          running++
          peak = Math.max(peak, running)
          await new Promise((resolve) => setTimeout(resolve, 5))
          running--
          return ok(url)
        },
      })
      await enrich([sc('1'), sc('2'), sc('3'), sc('4'), sc('5')])
      expect(peak).toBe(2)
    })

    it('paces concurrent requests together, not each on its own', async () => {
      const { enrich, starts } = setup()
      await Promise.all([enrich([sc('1'), sc('2')]), enrich([sc('3'), sc('4')])])
      const t0 = starts[0]?.at ?? 0
      expect(starts.map((s) => s.at - t0)).toEqual([0, 1000, 2000, 3000])
    })
  })

  describe('SoundCloud budget', () => {
    /** 31 starts 1 s apart (the 25-row burst plus what refills meanwhile), then one per 5 s. */
    const budgeted = (count: number) =>
      Array.from({ length: count }, (_, i) => (i <= 30 ? i * 1000 : 35_000 + (i - 31) * 5000))

    it('budgets a screenful at the 1 s pace, then one lookup per 5 s', () => {
      expect(SOUNDCLOUD_LOOKUP_BUDGET).toEqual({ burst: 25, refillMs: 5000 })
    })

    it('makes rows over the budget wait for a token, never fail', async () => {
      const { enrich, starts } = setup()
      const responses = await Promise.all([enrich(scRows(1, 25)), enrich(scRows(26, 15))])
      expect(responses.flatMap((r) => r.results).every((r) => r.status === 'ok')).toBe(true)
      const t0 = starts[0]?.at ?? 0
      expect(starts.map((s) => s.at - t0)).toEqual(budgeted(40))
    })

    it('refills over a quiet spell, so the next screenful starts at the 1 s pace again', async () => {
      const { enrich, starts, time } = setup()
      await enrich(scRows(1, 25))
      await enrich(scRows(26, 15))
      time.now += 10 * 60_000
      const resumed = time.now
      await enrich(scRows(41, 25))
      const later = starts.slice(40).map((s) => s.at - resumed)
      expect(later).toEqual(Array.from({ length: 25 }, (_, i) => i * 1000))
    })

    it('lets a row whose request went away leave the queue without spending a token', async () => {
      const { enrich, starts } = setup()
      await enrich(scRows(1, 31))
      const controller = new AbortController()
      const leaving = enrich(scRows(101, 3), controller.signal)
      const staying = enrich(scRows(201, 2))
      controller.abort()
      expect(await apiError(leaving)).toMatchObject({ code: 'canceled' })
      expect(outcome(await staying)).toEqual([
        ['201', 'ok'],
        ['202', 'ok'],
      ])
      const t0 = starts[0]?.at ?? 0
      expect(starts.slice(31).map((s) => [idOf(s.url), s.at - t0])).toEqual([
        ['201', 35_000],
        ['202', 40_000],
      ])
    })

    it('keeps YouTube lookups out of the budget', async () => {
      const { enrich, starts } = setup()
      await enrich(Array.from({ length: 40 }, (_, i) => yt(`v${i}x`)))
      const t0 = starts[0]?.at ?? 0
      expect(starts.map((s) => s.at - t0)).toEqual(Array.from({ length: 40 }, (_, i) => i * 500))
    })
  })

  describe('platform of the URL', () => {
    /** A SoundCloud track whose request row names another platform. */
    const mislabeled = (platform: Platform, id: string): EntryRef => ({ ...sc(id), platform })

    it('paces a row by the platform its URL is on, and echoes the platform the request named', async () => {
      const { enrich, starts } = setup()
      const response = await enrich([sc('1'), mislabeled('youtube', '2'), mislabeled('other', '3')])
      expect(response.results.map((r) => `${r.platform}:${r.id} ${r.status}`)).toEqual([
        'soundcloud:1 ok',
        'youtube:2 ok',
        'other:3 ok',
      ])
      const t0 = starts[0]?.at ?? 0
      expect(starts.map((s) => s.at - t0)).toEqual([0, 1000, 2000])
    })

    it('cools down the platform of the URL when a mislabeled row is rate-limited', async () => {
      const { enrich, run } = setup({
        respond: (url) => (idOf(url) === '2' ? rateLimited() : ok(url)),
      })
      expect(outcome(await enrich([mislabeled('youtube', '2'), yt('7')]))).toEqual([
        ['2', 'rate_limited'],
        ['7', 'ok'],
      ])
      const later = await enrich([sc('3'), yt('8')])
      expect(outcome(later)).toEqual([
        ['3', 'rate_limited'],
        ['8', 'ok'],
      ])
      expect(later.results[0]).toMatchObject({
        error: { message: 'SoundCloud is limiting requests. Try again in 1 minute.' },
      })
      expect(run).toHaveBeenCalledTimes(3)
    })

    it('caches a row under the platform of its URL', async () => {
      const { enrich, run } = setup()
      await enrich([mislabeled('youtube', '1')])
      const again = await enrich([sc('1')])
      expect(again.results).toMatchObject([{ status: 'ok', platform: 'soundcloud', id: '1' }])
      expect(run).toHaveBeenCalledOnce()
    })
  })

  describe('concurrent requests for the same row', () => {
    it('join the lookup the first one started, each keyed by its own request row', async () => {
      const gate = deferred()
      const { enrich, run } = setup({
        respond: async (url) => {
          await gate.promise
          return ok(url)
        },
      })
      const first = enrich([sc('1')])
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const second = enrich([sc('1')])
      const third = enrich([{ ...sc('1'), platform: 'other' }])
      gate.resolve()
      const results = (await Promise.all([first, second, third])).flatMap((r) => r.results)
      expect(results.map((r) => `${r.platform}:${r.id} ${r.status}`)).toEqual([
        'soundcloud:1 ok',
        'soundcloud:1 ok',
        'other:1 ok',
      ])
      expect(run).toHaveBeenCalledOnce()
    })

    it('keep the lookup going while any of them still waits for it', async () => {
      const gate = deferred()
      const signals: AbortSignal[] = []
      const { enrich, run } = setup({
        respond: async (url, options) => {
          if (options.signal) signals.push(options.signal)
          await gate.promise
          return ok(url)
        },
      })
      const controller = new AbortController()
      const first = enrich([sc('1')], controller.signal)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const second = enrich([sc('1')])
      controller.abort('Client connection prematurely closed.')
      expect(await apiError(first)).toMatchObject({ code: 'canceled' })
      expect(signals[0]?.aborted).toBe(false)
      gate.resolve()
      expect(outcome(await second)).toEqual([['1', 'ok']])
      expect(run).toHaveBeenCalledOnce()
    })

    it('stop the lookup once all of them have gone away, and a later one starts afresh', async () => {
      let hang = true
      const signals: AbortSignal[] = []
      const { enrich, run } = setup({
        respond: (url, options) => {
          if (options.signal) signals.push(options.signal)
          return hang ? untilAborted(options) : ok(url)
        },
      })
      const a = new AbortController()
      const b = new AbortController()
      const first = enrich([sc('1')], a.signal)
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const second = enrich([sc('1')], b.signal)
      a.abort()
      expect(signals[0]?.aborted).toBe(false)
      b.abort()
      expect(await apiError(first)).toMatchObject({ code: 'canceled' })
      expect(await apiError(second)).toMatchObject({ code: 'canceled' })
      expect(signals[0]?.aborted).toBe(true)

      hang = false
      expect(outcome(await enrich([sc('1')]))).toEqual([['1', 'ok']])
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('do not hold up new rows behind the ones they share', async () => {
      const { enrich, run, starts } = setup()
      const first = enrich(scRows(1, 10))
      const second = enrich([...scRows(1, 10), sc('101'), sc('102')])
      const [, overlapping] = await Promise.all([first, second])
      expect(overlapping.results.every((r) => r.status === 'ok')).toBe(true)
      expect(run).toHaveBeenCalledTimes(12)
      const t0 = starts[0]?.at ?? 0
      const at = (id: string) => (starts.find((s) => idOf(s.url) === id)?.at ?? -1) - t0
      expect([at('101'), at('102')]).toEqual([10_000, 11_000])
    })
  })

  describe('rate limits', () => {
    it('fails the waiting rows of a rate-limited platform at once, and keeps the others going', async () => {
      const { enrich, run } = setup({
        respond: (url) => (idOf(url) === '1' ? rateLimited() : ok(url)),
      })
      const response = await enrich([sc('1'), sc('2'), sc('3'), yt('7')])
      expect(outcome(response)).toEqual([
        ['1', 'rate_limited'],
        ['2', 'rate_limited'],
        ['3', 'rate_limited'],
        ['7', 'ok'],
      ])
      expect(response.results[1]).toMatchObject({
        error: { message: 'SoundCloud is limiting requests. Try again in 1 minute.' },
      })
      // Only the rate-limited lookup and the YouTube one ran.
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('fails new rows for the platform without spawning until the cooldown ends', async () => {
      let limited = true
      const { enrich, run, time } = setup({
        respond: (url) => (limited ? rateLimited() : ok(url)),
      })
      await enrich([sc('1')])
      limited = false

      time.now += 30_000
      const during = await enrich([sc('2')])
      expect(outcome(during)).toEqual([['2', 'rate_limited']])
      expect(during.results[0]).toMatchObject({
        error: { message: 'SoundCloud is limiting requests. Try again in 30 s.' },
      })
      expect(run).toHaveBeenCalledOnce()

      time.now += 30_000
      expect(outcome(await enrich([sc('2')]))).toEqual([['2', 'ok']])
      expect(run).toHaveBeenCalledTimes(2)
    })

    it.each([
      [1, '1 minute'],
      [999, '1 minute'],
      [1000, '59 s'],
      [59_001, '1 s'],
    ])('says how long is left %i ms into a 1-minute cooldown: %s', async (elapsed, wait) => {
      const { enrich, time } = setup({ respond: rateLimited })
      await enrich([sc('1')])
      time.now += elapsed
      const next = await enrich([sc('2')])
      expect(next.results[0]).toMatchObject({
        error: { message: `SoundCloud is limiting requests. Try again in ${wait}.` },
      })
    })

    it('doubles the cooldown for each consecutive rate limit, up to 10 minutes', async () => {
      const { enrich, time } = setup({ respond: rateLimited })
      const waits: string[] = []
      for (let i = 0; i < 6; i++) {
        await enrich([sc(String(i))])
        const next = await enrich([sc('999')])
        waits.push(next.results[0]?.status === 'error' ? next.results[0].error.message : 'ok')
        time.now += 10 * 60_000
      }
      expect(waits.map((message) => /Try again in (.+)\.$/.exec(message)?.[1])).toEqual([
        '1 minute',
        '2 minutes',
        '4 minutes',
        '8 minutes',
        '10 minutes',
        '10 minutes',
      ])
    })

    it('starts over at 1 minute after a successful lookup', async () => {
      let limited = true
      const { enrich, time } = setup({ respond: (url) => (limited ? rateLimited() : ok(url)) })
      await enrich([sc('1')])
      time.now += 60_000
      await enrich([sc('2')])
      time.now += 120_000
      limited = false
      await enrich([sc('3')])
      limited = true
      await enrich([sc('4')])
      const next = await enrich([sc('5')])
      expect(next.results[0]).toMatchObject({
        error: { code: 'rate_limited', message: expect.stringContaining('1 minute.') },
      })
    })

    it('does not double the cooldown for lookups that were already running', async () => {
      const { enrich } = setup({
        pacing: {
          soundcloud: { concurrency: 2, minIntervalMs: 0 },
          youtube: { concurrency: 2, minIntervalMs: 0 },
          other: { concurrency: 2, minIntervalMs: 0 },
        },
        respond: rateLimited,
      })
      await enrich([sc('1'), sc('2')])
      const next = await enrich([sc('3')])
      expect(next.results[0]).toMatchObject({
        error: { message: expect.stringContaining('1 minute.') },
      })
    })
  })

  describe('abort', () => {
    it('stops running lookups, drops queued ones and rejects with canceled', async () => {
      const controller = new AbortController()
      const signals: AbortSignal[] = []
      const { enrich, run } = setup({
        respond: (_url, options) =>
          new Promise<RunResult>((resolve) => {
            if (options.signal) signals.push(options.signal)
            options.signal?.addEventListener('abort', () =>
              resolve(result({ aborted: true, exitCode: null, signal: 'SIGINT' })),
            )
          }),
      })
      const pending = enrich([sc('1'), sc('2'), sc('3'), sc('4')], controller.signal)
      await vi.waitFor(() => expect(run).toHaveBeenCalled())
      controller.abort('Client connection prematurely closed.')

      expect(await apiError(pending)).toMatchObject({ code: 'canceled' })
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(run.mock.calls.length).toBeLessThanOrEqual(2)
    })

    it('rejects at once when the signal is already aborted', async () => {
      const { enrich, run } = setup()
      const signal = AbortSignal.abort()
      expect(await apiError(enrich([sc('1')], signal))).toMatchObject({ code: 'canceled' })
      expect(run).not.toHaveBeenCalled()
    })
  })

  describe('clock', () => {
    it('keeps a cooldown when the wall clock jumps ahead: it runs on a monotonic clock', async () => {
      // Only Date is faked (timers and performance stay real), before the enricher reads a clock.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const runFn = vi.fn<typeof run>(async () => rateLimited())
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        const enricher = createEnricher({
          engine: ENGINE,
          run: runFn,
          locate: async () => YTDLP,
          jsRuntime: NODE,
          log,
        })
        await enricher.enrich({ entries: [sc('1')] })
        vi.setSystemTime(Date.now() + 60 * 60_000)
        const next = await enricher.enrich({ entries: [sc('2')] })
        expect(next.results[0]).toMatchObject({ status: 'error', error: { code: 'rate_limited' } })
        expect(runFn).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('logging', () => {
    it('writes one line with row counts and error codes, never URLs', async () => {
      const secret = {
        platform: 'soundcloud' as const,
        id: '9',
        url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
      }
      const { enrich, log } = setup({
        respond: (url) => (idOf(url) === '2' ? removed() : ok(url)),
      })
      await enrich([secret, sc('1'), sc('2')])
      expect(log.info).toHaveBeenCalledOnce()
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[resolve\/entries\] 3 rows → 2 ok, 1 failed \(unavailable 1\) in /,
        ),
      )
      expect(logged(log)).not.toContain('s-8Pjrp')
      expect(logged(log)).not.toContain('api.soundcloud.com')
    })
  })
})
