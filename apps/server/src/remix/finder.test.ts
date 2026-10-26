import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type RemixRequest,
  type RemixSuggestions,
  RemixSuggestionsSchema,
} from '@dj-scraper/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult, run } from '../engine/run.ts'
import { SpawnError } from '../engine/run.ts'
import { searchArgs } from '../engine/ytdlp-args.ts'
import { ApiError } from '../http/errors.ts'
import { createTokenBucket, type TokenBucket } from '../pacing/token-bucket.ts'
import { createRemixFinder, REMIX_CACHE_TTL_MS, SEARCH_TIMEOUT_MS } from './finder.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures')
const fixtureText = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')

/** The recorded searches for "Moby Porcelain remix" (ytsearch30, scsearch30). */
const STDOUT = {
  ytsearch30: fixtureText('youtube/search-remixes-porcelain.json'),
  scsearch30: fixtureText('soundcloud/search-remixes-porcelain.json'),
}
const NODE = '/opt/homebrew/bin/node'
const BIN = '/opt/homebrew/bin/yt-dlp'
const PORCELAIN: RemixRequest = { title: 'Porcelain', artist: 'Moby' }

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 12,
  ...overrides,
})

/** One yt-dlp run the fake started: which search, its options, and how to end it. */
type Started = {
  site: 'ytsearch30' | 'scsearch30'
  argv: readonly string[]
  options: RunOptions
  finish: (overrides?: Partial<RunResult>) => void
}

/**
 * A fake `run`: each call waits until the test finishes it (`auto` answers every search at once
 * with its recording). An aborted signal ends the run as `run` does: `aborted: true`.
 */
function fakeRun({ auto = false }: { auto?: boolean } = {}) {
  const started: Started[] = []
  const fn = vi.fn<typeof run>((_bin, argv, options = {}) => {
    const last = argv.at(-1) ?? ''
    const site = last.slice(0, last.indexOf(':')) as Started['site']
    return new Promise<RunResult>((resolve) => {
      const finish = (overrides: Partial<RunResult> = {}) =>
        resolve(result({ stdout: STDOUT[site] ?? '', ...overrides }))
      options.signal?.addEventListener('abort', () => finish({ stdout: '', aborted: true }), {
        once: true,
      })
      started.push({ site, argv, options, finish })
      if (auto) finish()
    })
  })
  /** The run of one search, once it has started. */
  const runOf = async (site: Started['site'], index = 0) => {
    await vi.waitFor(() => {
      expect(started.filter((entry) => entry.site === site).length).toBeGreaterThan(index)
    })
    return started.filter((entry) => entry.site === site)[index] as Started
  }
  return { fn, started, runOf }
}

/** A clock the test moves: the SoundCloud gap and the cache's age follow it. */
function manualClock() {
  let now = 1_000_000
  return { clock: () => now, advance: (ms: number) => (now += ms) }
}

function setup({
  run: runFn = fakeRun({ auto: true }).fn,
  locate = async () => BIN,
  soundcloudBudget,
  clock = manualClock().clock,
}: {
  run?: typeof run
  locate?: () => Promise<string>
  soundcloudBudget?: TokenBucket
  clock?: () => number
} = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const locateFn = vi.fn(locate)
  const finder = createRemixFinder({
    engine: { YTDLP_PATH: BIN },
    run: runFn,
    locate: locateFn,
    jsRuntime: NODE,
    clock,
    log,
    ...(soundcloudBudget === undefined ? {} : { soundcloudBudget }),
  })
  return { finder, log, locate: locateFn }
}

/** The ApiError a promise rejects with. */
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

const arty = (answer: RemixSuggestions) => answer.suggestions[0]

afterEach(() => {
  vi.useRealTimers()
})

describe('createRemixFinder: one request', () => {
  it('searches both platforms with the argv searchArgs builds, and answers the suggestions', async () => {
    const { fn, started } = fakeRun({ auto: true })
    const { finder, log } = setup({ run: fn })
    const answer = await finder.find(PORCELAIN)

    expect(RemixSuggestionsSchema.parse(answer)).toEqual(answer)
    expect(answer.song).toEqual({ title: 'Porcelain', artist: 'Moby' })
    expect(answer.searches).toEqual({
      youtube: { status: 'ok', found: 22 },
      soundcloud: { status: 'ok', found: 27 },
    })
    expect(arty(answer)).toMatchObject({ remixer: 'Arty', plays: 908188 })
    expect(answer.suggestions).toHaveLength(20)

    expect(started.map((entry) => entry.argv)).toEqual([
      searchArgs({ query: 'Moby Porcelain remix', count: 30, jsRuntime: NODE, site: 'youtube' }),
      searchArgs({ query: 'Moby Porcelain remix', count: 30, jsRuntime: NODE, site: 'soundcloud' }),
    ])
    for (const entry of started) {
      expect(fn).toHaveBeenCalledWith(BIN, entry.argv, expect.anything())
      expect(entry.options).toMatchObject({ timeoutMs: SEARCH_TIMEOUT_MS })
      expect(entry.options.signal).toBeInstanceOf(AbortSignal)
    }
    // One line, with counts and no names.
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info.mock.calls[0]?.[0]).toMatch(
      /^\[remixes\] youtube 22, soundcloud 27 → 20 in \d+\.\d s$/,
    )
  })

  it('leaves the pasted track out of the answer', async () => {
    const { finder } = setup()
    const answer = await finder.find({
      title: 'Porcelain (Arty Remix)',
      artist: 'Moby',
      exclude: { platform: 'youtube', id: 'MU5FD_0iWHk' },
    })
    expect(answer.song).toEqual({ title: 'Porcelain', artist: 'Moby' })
    expect(answer.searches.youtube).toEqual({ status: 'ok', found: 21 })
    expect(arty(answer)?.uploads.map((upload) => upload.id)).toEqual([
      'i_D7Uvf_LEY',
      '279991262',
      '305222436',
    ])
  })

  it('searches the uploader standing in for the artist, and answers the song without one when none', async () => {
    const { fn, started } = fakeRun()
    const { finder } = setup({ run: fn })
    const pending = finder.find({ title: 'Porcelain', platforms: ['youtube'] })
    const [entry] = await vi.waitFor(() => {
      expect(started).toHaveLength(1)
      return started
    })
    expect(entry?.argv.at(-1)).toBe('ytsearch30:Porcelain remix')
    entry?.finish({ stdout: JSON.stringify({ entries: [] }) })
    expect((await pending).song).toEqual({ title: 'Porcelain' })
  })

  it('searches only the platforms asked for: the other is skipped', async () => {
    const { fn, started } = fakeRun({ auto: true })
    const { finder } = setup({ run: fn })
    const answer = await finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    expect(answer.searches).toEqual({
      youtube: { status: 'ok', found: 22 },
      soundcloud: { status: 'skipped' },
    })
    expect(answer.suggestions.flatMap((s) => s.uploads.map((u) => u.platform))).not.toContain(
      'soundcloud',
    )
    expect(started.map((entry) => entry.site)).toEqual(['ytsearch30'])
  })

  it("reports a failed search in its platform's status and keeps the other's suggestions", async () => {
    const { fn, runOf } = fakeRun()
    const { finder, log } = setup({ run: fn })
    const pending = finder.find(PORCELAIN)
    ;(await runOf('ytsearch30')).finish()
    ;(await runOf('scsearch30')).finish({
      stdout: '',
      exitCode: 1,
      stderr: fixtureText('errors/soundcloud-429.log'),
    })
    const answer = await pending
    expect(answer.searches.youtube).toEqual({ status: 'ok', found: 22 })
    expect(answer.searches.soundcloud).toMatchObject({
      status: 'error',
      error: { code: 'rate_limited' },
    })
    expect(arty(answer)?.uploads.map((upload) => upload.platform)).toEqual(['youtube', 'youtube'])
    expect(log.info.mock.calls[0]?.[0]).toMatch(/youtube 22, soundcloud rate_limited/)
  })

  it('reports stdout that is not JSON as unknown', async () => {
    const { fn, runOf } = fakeRun()
    const { finder } = setup({ run: fn })
    const pending = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    ;(await runOf('ytsearch30')).finish({ stdout: 'Moby Porcelain remix: not JSON' })
    expect((await pending).searches.youtube).toMatchObject({
      status: 'error',
      error: { code: 'unknown' },
    })
  })

  it('reports a search that ran out of time as a network error', async () => {
    const { fn, runOf } = fakeRun()
    const { finder } = setup({ run: fn })
    const pending = finder.find({ ...PORCELAIN, platforms: ['soundcloud'] })
    ;(await runOf('scsearch30')).finish({ stdout: '', timedOut: true, exitCode: null })
    expect((await pending).searches.soundcloud).toMatchObject({
      status: 'error',
      error: { code: 'network', message: "yt-dlp didn't answer within 60 s." },
    })
  })
})

describe('createRemixFinder: refusals', () => {
  it.each(['(Official Video)', '!!!', '[Arty Remix]'])(
    'refuses the title %j, which has no words to search, with invalid_request',
    async (title) => {
      const { fn } = fakeRun({ auto: true })
      const { finder, locate } = setup({ run: fn })
      expect(await apiError(finder.find({ title, artist: 'Moby' }))).toMatchObject({
        code: 'invalid_request',
      })
      expect(locate).not.toHaveBeenCalled()
      expect(fn).not.toHaveBeenCalled()
    },
  )

  it('answers engine_missing when yt-dlp is not there, running nothing', async () => {
    const { fn } = fakeRun({ auto: true })
    const { finder } = setup({
      run: fn,
      locate: async () => {
        throw new ApiError('engine_missing', 'yt-dlp is not on PATH.')
      },
    })
    expect(await apiError(finder.find(PORCELAIN))).toEqual({
      code: 'engine_missing',
      message: 'yt-dlp is not on PATH.',
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('answers from the cache without looking for yt-dlp', async () => {
    let missing = false
    const { finder, locate } = setup({
      locate: async () => {
        if (missing) throw new ApiError('engine_missing', 'yt-dlp is not on PATH.')
        return BIN
      },
    })
    const first = await finder.find(PORCELAIN)
    expect(locate).toHaveBeenCalledTimes(1)
    missing = true
    expect(await finder.find(PORCELAIN)).toEqual(first)
    expect(locate).toHaveBeenCalledTimes(1)
  })

  it("stops the other platform's search when one platform's search throws", async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const fake = fakeRun()
    const fn = vi.fn<typeof run>((bin, argv, options) => {
      if (argv.at(-1)?.startsWith('scsearch')) return Promise.reject(new SpawnError(BIN, enoent))
      return fake.fn(bin, argv, options)
    })
    const { finder } = setup({ run: fn })
    const failed = apiError(finder.find(PORCELAIN))
    const youtube = await fake.runOf('ytsearch30')
    expect(await failed).toMatchObject({ code: 'engine_missing' })
    expect(youtube.options.signal?.aborted).toBe(true)
  })

  it('answers engine_missing when yt-dlp cannot start, and tries again next time', async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const fn = vi.fn<typeof run>(async () => {
      throw new SpawnError(BIN, enoent)
    })
    const { finder } = setup({ run: fn })
    const youtube = { ...PORCELAIN, platforms: ['youtube' as const] }
    expect(await apiError(finder.find(youtube))).toMatchObject({ code: 'engine_missing' })
    expect(await apiError(finder.find(youtube))).toMatchObject({ code: 'engine_missing' })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('answers unknown, never an off-contract answer, and logs no names', async () => {
    const { finder, log } = setup()
    // The route caps the title; called directly, the song's title outgrows the contract.
    const title = `Porcelain ${'x'.repeat(1000)}`
    expect(await apiError(finder.find({ title, artist: 'Moby' }))).toEqual({
      code: 'unknown',
      message: 'yt-dlp returned data DJ Scraper could not read.',
    })
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/^\[remixes\] off-contract answer: song\.title: /)
    expect(String(log.warn.mock.calls[0]?.[0])).not.toContain('Porcelain')
    expect(log.info).not.toHaveBeenCalled()
  })

  it('answers canceled when the request was aborted before it started', async () => {
    const { fn } = fakeRun({ auto: true })
    const { finder } = setup({ run: fn })
    const controller = new AbortController()
    controller.abort()
    expect(await apiError(finder.find(PORCELAIN, controller.signal))).toMatchObject({
      code: 'canceled',
    })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('createRemixFinder: shared searches', () => {
  it('shares one search per platform between two requests in flight', async () => {
    const { fn, runOf, started } = fakeRun()
    const { finder } = setup({ run: fn })
    const first = finder.find(PORCELAIN)
    const second = finder.find({
      ...PORCELAIN,
      exclude: { platform: 'youtube', id: 'MU5FD_0iWHk' },
    })
    ;(await runOf('ytsearch30')).finish()
    ;(await runOf('scsearch30')).finish()
    const [a, b] = await Promise.all([first, second])
    expect(started).toHaveLength(2)
    expect(arty(a)?.uploads).toHaveLength(4)
    // Each request's own exclude applies to the shared results.
    expect(arty(b)?.uploads).toHaveLength(3)
  })

  it("shares YouTube's search between the web's YouTube-first request and its full one", async () => {
    const { fn, runOf, started } = fakeRun()
    const { finder } = setup({ run: fn })
    const youtubeFirst = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    const both = finder.find(PORCELAIN)
    ;(await runOf('ytsearch30')).finish()
    expect((await youtubeFirst).searches.soundcloud).toEqual({ status: 'skipped' })
    ;(await runOf('scsearch30')).finish()
    expect((await both).searches.soundcloud).toEqual({ status: 'ok', found: 27 })
    expect(started.map((entry) => entry.site)).toEqual(['ytsearch30', 'scsearch30'])
  })

  it('answers a later request from the cache, running nothing, for 30 minutes', async () => {
    const { fn } = fakeRun({ auto: true })
    const time = manualClock()
    const { finder } = setup({ run: fn, clock: time.clock })
    const first = await finder.find(PORCELAIN)
    expect(fn).toHaveBeenCalledTimes(2)

    time.advance(REMIX_CACHE_TTL_MS - 1)
    // A pasted remix of the same song searches the same query.
    expect(await finder.find({ title: 'Porcelain (Arty Remix)', artist: 'Moby' })).toEqual(first)
    expect(fn).toHaveBeenCalledTimes(2)

    time.advance(1)
    await finder.find(PORCELAIN)
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('caches each platform on its own: asking for both after YouTube runs only SoundCloud', async () => {
    const { fn, started } = fakeRun({ auto: true })
    const { finder } = setup({ run: fn })
    await finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    await finder.find(PORCELAIN)
    expect(started.map((entry) => entry.site)).toEqual(['ytsearch30', 'scsearch30'])
  })

  it("doesn't cache a failed search: the next request searches again", async () => {
    const { fn, runOf, started } = fakeRun()
    const time = manualClock()
    const { finder } = setup({ run: fn, clock: time.clock })
    const failed = finder.find({ ...PORCELAIN, platforms: ['soundcloud'] })
    ;(await runOf('scsearch30')).finish({
      stdout: '',
      exitCode: 1,
      stderr: fixtureText('errors/soundcloud-429.log'),
    })
    expect((await failed).searches.soundcloud).toMatchObject({ status: 'error' })

    // SoundCloud's searches start at least a second apart.
    time.advance(1000)
    const retried = finder.find({ ...PORCELAIN, platforms: ['soundcloud'] })
    ;(await runOf('scsearch30', 1)).finish()
    expect((await retried).searches.soundcloud).toEqual({ status: 'ok', found: 27 })
    expect(started).toHaveLength(2)
  })

  it('keeps a search running for the request still waiting when another aborts', async () => {
    const { fn, runOf, started } = fakeRun()
    const { finder } = setup({ run: fn })
    const leaving = new AbortController()
    const left = finder.find({ ...PORCELAIN, platforms: ['youtube'] }, leaving.signal)
    const staying = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    const search = await runOf('ytsearch30')

    leaving.abort()
    expect(await apiError(left)).toMatchObject({ code: 'canceled' })
    expect(search.options.signal?.aborted).toBe(false)

    search.finish()
    expect((await staying).searches.youtube).toEqual({ status: 'ok', found: 22 })
    expect(started).toHaveLength(1)
  })

  it('stops the search once every waiting request has aborted, and caches nothing', async () => {
    const { fn, runOf, started } = fakeRun({})
    const { finder } = setup({ run: fn })
    const one = new AbortController()
    const two = new AbortController()
    const first = finder.find({ ...PORCELAIN, platforms: ['youtube'] }, one.signal)
    const second = finder.find({ ...PORCELAIN, platforms: ['youtube'] }, two.signal)
    const search = await runOf('ytsearch30')

    one.abort()
    expect(search.options.signal?.aborted).toBe(false)
    two.abort()
    expect(search.options.signal?.aborted).toBe(true)
    expect(await apiError(first)).toMatchObject({ code: 'canceled' })
    expect(await apiError(second)).toMatchObject({ code: 'canceled' })

    // The stopped search left nothing in the cache: the next request searches anew.
    const next = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    ;(await runOf('ytsearch30', 1)).finish()
    expect((await next).searches.youtube).toEqual({ status: 'ok', found: 22 })
    expect(started).toHaveLength(2)
  })

  it('starts a fresh search for a request that comes while a stopped one is still exiting', async () => {
    // React's StrictMode mounts twice: a request, its abort, and the same request at once.
    const { fn, runOf, started } = fakeRun()
    // yt-dlp takes a moment to exit after SIGINT: this run ends only when the test says.
    const slow = vi.fn<typeof run>((bin, argv, { signal: _signal, ...options } = {}) =>
      fn(bin, argv, options),
    )
    const { finder } = setup({ run: slow })
    const gone = new AbortController()
    const first = finder.find({ ...PORCELAIN, platforms: ['youtube'] }, gone.signal)
    const stopped = await runOf('ytsearch30')
    gone.abort()
    expect(await apiError(first)).toMatchObject({ code: 'canceled' })

    const again = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    // One search at a time on YouTube: the fresh one starts once the stopped one has exited.
    stopped.finish({ stdout: '', aborted: true })
    ;(await runOf('ytsearch30', 1)).finish()
    expect((await again).searches.youtube).toEqual({ status: 'ok', found: 22 })
    expect(started).toHaveLength(2)
  })

  it('runs searches of different songs side by side, one at a time per platform', async () => {
    const { fn, runOf, started } = fakeRun()
    const { finder } = setup({ run: fn })
    const porcelain = finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    const other = finder.find({ title: 'Natural Blues', artist: 'Moby', platforms: ['youtube'] })
    const first = await runOf('ytsearch30')
    // The second search waits for the first: a burst of pastes queues.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toHaveLength(1)
    first.finish()
    await porcelain
    const second = await runOf('ytsearch30', 1)
    expect(second.argv.at(-1)).toBe('ytsearch30:Moby Natural Blues remix')
    second.finish({ stdout: JSON.stringify({ entries: [] }) })
    expect((await other).suggestions).toEqual([])
  })
})

describe('createRemixFinder: SoundCloud budget', () => {
  /** A bucket that records its takes: the instance the enricher and downloads also hold. */
  function sharedBucket(budget: { burst: number; refillMs: number }) {
    const bucket = createTokenBucket(budget)
    const take = vi.spyOn(bucket, 'take')
    return { bucket, take }
  }

  it('spends a token of the shared bucket per SoundCloud search, none for YouTube', async () => {
    const { bucket, take } = sharedBucket({ burst: 5, refillMs: 1000 })
    const time = manualClock()
    const { finder } = setup({ soundcloudBudget: bucket, clock: time.clock })
    await finder.find({ ...PORCELAIN, platforms: ['youtube'] })
    expect(take).not.toHaveBeenCalled()
    await finder.find(PORCELAIN)
    expect(take).toHaveBeenCalledTimes(1)
    expect(take).toHaveBeenCalledWith(time.clock())
    // A cached answer spends nothing.
    await finder.find(PORCELAIN)
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('waits for a token when the bucket’s other holders have spent it', async () => {
    const { bucket } = sharedBucket({ burst: 1, refillMs: 300 })
    const { fn, started } = fakeRun({ auto: true })
    // The real monotonic clock, which the bucket's other holders use too.
    const { finder } = setup({ run: fn, soundcloudBudget: bucket, clock: () => performance.now() })
    // A lookup or a download took the last token.
    bucket.take(performance.now())
    const before = performance.now()
    const answer = await finder.find({ ...PORCELAIN, platforms: ['soundcloud'] })
    expect(performance.now() - before).toBeGreaterThanOrEqual(250)
    expect(answer.searches.soundcloud).toEqual({ status: 'ok', found: 27 })
    expect(started).toHaveLength(1)
  })

  it('stops waiting for a token when the request aborts, without spending one', async () => {
    const { bucket, take } = sharedBucket({ burst: 1, refillMs: 60_000 })
    bucket.take(performance.now())
    take.mockClear()
    const { fn } = fakeRun({ auto: true })
    const { finder } = setup({ run: fn, soundcloudBudget: bucket, clock: () => performance.now() })
    const controller = new AbortController()
    const pending = finder.find({ ...PORCELAIN, platforms: ['soundcloud'] }, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    expect(await apiError(pending)).toMatchObject({ code: 'canceled' })
    expect(fn).not.toHaveBeenCalled()
    expect(take).not.toHaveBeenCalled()
  })
})
