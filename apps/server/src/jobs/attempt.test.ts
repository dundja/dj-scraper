import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AudioSourceSchema,
  type DownloadOptions,
  type ErrorInfo,
  JobProgressSchema,
  type TrackMatch,
  TrackMatchSchema,
  type TrackRef,
  type ValidUrl,
} from '@dj-scraper/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RunOptions, type RunResult, type run, SpawnError } from '../engine/run.ts'
import { DONE_PRINT } from '../engine/ytdlp-args.ts'
import { checkUrl } from '../resolve/input.ts'
import { CANCELED } from '../resolve/ytdlp-call.ts'
import type { SpotifyTrack } from '../spotify/embed.ts'
import { NO_MATCH, type SpotifyDownloads } from '../spotify/matcher.ts'
import {
  type AttemptDeps,
  createRunAttempt,
  KILL_GRACE_MS,
  LIST_URL,
  MAX_MATCH_TRIES,
  NO_FILE,
  nameBytesLeft,
  withSpotifyNames,
} from './attempt.ts'
import {
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptUpdate,
  type DoneInfo,
  type EngineBins,
  type Finalize,
  type FinalizeInput,
  type FinalizeResult,
  type Publish,
  type PublishRequest,
  type PublishResult,
  StepError,
  type TargetFolder,
} from './types.ts'

const downloadsDir = path.resolve(import.meta.dirname, '../../test/fixtures/downloads')
/** Later than every recording, so recorded `available_at` values mean "no wait". */
const NOW = Date.UTC(2026, 9, 3, 8, 0, 0)
const NODE = '/opt/homebrew/bin/node'
const BINS: EngineBins = {
  ytdlp: '/opt/homebrew/bin/yt-dlp',
  ffmpeg: '/opt/homebrew/bin/ffmpeg',
  ffprobe: '/opt/homebrew/bin/ffprobe',
}
const FOLDER: TargetFolder = {
  given: '/Users/dj/Music/DJ Scraper',
  real: '/Users/dj/Music/DJ Scraper',
}
const MP3: DownloadOptions = {
  format: 'mp3',
  filenameTemplate: '{artist} - {title}',
  embedArtwork: true,
  sourceUrlComment: true,
}
const YT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const SC_URL = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'
const ATTEMPT = '00000000-0000-4000-8000-0000000000a1'
const JOB = '00000000-0000-4000-8000-000000000001'

const OUTPUT = {
  ext: 'mp3',
  codec: 'mp3',
  bitrateKbps: 320,
  sampleRateHz: 48000,
  channels: 2,
  encoded: true,
}

let dataDir = ''
beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-attempt-')))
  await mkdir(path.join(dataDir, 'jobs'), { mode: 0o700 })
})
afterEach(async () => {
  // Whatever a test did, its job dir is gone.
  expect(await readdir(path.join(dataDir, 'jobs'))).toEqual([])
  await rm(dataDir, { recursive: true, force: true })
})

const jobDir = () => path.join(dataDir, 'jobs', ATTEMPT)

function request(url = YT_URL, overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  const checked = checkUrl(url)
  if (!checked.ok) throw new Error(`test URL refused: ${url}`)
  const ref: TrackRef = { platform: checked.input.platform, id: 'x', url }
  return {
    jobId: JOB,
    attemptId: ATTEMPT,
    ref,
    input: checked.input,
    folder: FOLDER,
    options: MP3,
    ...overrides,
  }
}

type Line = ['stdout' | 'stderr', string]

/** Splits like run.ts: `\n`, `\r\n` or a lone `\r` ends a line; no empty line after the last end. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (/[\r\n]$/.test(text)) lines.pop()
  return lines
}

/**
 * A recorded download (test/fixtures/downloads) in the order the fake yt-dlp replays it: stdout up
 * to the last DL `finished`, then stderr, then the rest of stdout (DONE).
 */
function recorded(name: string): Line[] {
  const read = (stream: string) =>
    splitLines(readFileSync(path.join(downloadsDir, `${name}.${stream}.log`), 'utf8'))
  const stdout = read('stdout')
  const stderr = read('stderr')
  const finished = stdout.findLastIndex((line) => /^DL .*"status": "finished"/.test(line))
  const cut = finished === -1 ? stdout.findIndex((line) => line.startsWith('DONE ')) : finished + 1
  const at = cut === -1 ? stdout.length : cut
  return [
    ...stdout.slice(0, at).map((line): Line => ['stdout', line]),
    ...stderr.map((line): Line => ['stderr', line]),
    ...stdout.slice(at).map((line): Line => ['stdout', line]),
  ]
}

type Script = {
  lines: Line[]
  exitCode?: number | null
  /** After this many lines, waits for the signal, then answers like a SIGINTed yt-dlp. */
  hangAfter?: number
}

type RunCall = { bin: string; argv: readonly string[]; options: RunOptions; jobDirMode: number }

/** A run() that plays `script` through the line callbacks, as yt-dlp would print it. */
function fakeRun(script: Script | (() => Script)) {
  const calls: RunCall[] = []
  const runFn = vi.fn<typeof run>(async (bin, argv, options = {}) => {
    const { lines, exitCode = 0, hangAfter } = typeof script === 'function' ? script() : script
    const dir = argv[argv.indexOf('-P') + 1] ?? ''
    // The job dir exists, private, while yt-dlp runs.
    calls.push({ bin, argv, options, jobDirMode: (await stat(dir)).mode & 0o777 })
    const jsonDir = JSON.stringify(dir).slice(1, -1)
    const out: Record<'stdout' | 'stderr', string[]> = { stdout: [], stderr: [] }
    let aborted = false
    for (const [index, [stream, raw]] of lines.entries()) {
      if (index === hangAfter || options.signal?.aborted) {
        await untilAborted(options.signal)
        aborted = true
        break
      }
      const line = raw
        .replaceAll('{JOBDIR}', jsonDir)
        .replace(/\{NOW\+(\d+)\}/g, (_, n: string) => String(Math.floor(NOW / 1000) + Number(n)))
      out[stream].push(line)
      if (stream === 'stdout') options.onStdoutLine?.(line)
      else options.onStderrLine?.(line)
    }
    if (!aborted && hangAfter !== undefined && hangAfter >= lines.length) {
      await untilAborted(options.signal)
      aborted = true
    }
    if (aborted) out.stderr.push('', 'ERROR: Interrupted by user')
    return {
      pid: 4242,
      exitCode: aborted ? 1 : exitCode,
      signal: null,
      stdout: out.stdout.map((line) => `${line}\n`).join(''),
      stderr: out.stderr.map((line) => `${line}\n`).join(''),
      truncated: false,
      timedOut: false,
      aborted,
      durationMs: 5,
    } satisfies RunResult
  })
  return { runFn, calls }
}

const untilAborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

const FINALIZED = (input: FinalizeInput): FinalizeResult => ({
  file: path.join(input.jobDir, 'finalize', 'final.mp3'),
  name: 'jawed - Me at the zoo.mp3',
  output: OUTPUT,
  track: { title: 'Me at the zoo', artist: 'jawed', url: YT_URL },
})

const MOVED = (req: PublishRequest): PublishResult => ({
  status: 'moved',
  path: path.join(req.folder.real, req.name),
})

function setup(
  script: Script | (() => Script),
  overrides: Partial<AttemptDeps> & {
    finalize?: (input: FinalizeInput) => Promise<FinalizeResult>
    publish?: (request: PublishRequest) => Promise<PublishResult>
  } = {},
) {
  const { runFn, calls } = fakeRun(script)
  const finalize = vi.fn<Finalize>(overrides.finalize ?? (async (input) => FINALIZED(input)))
  const publish = vi.fn<Publish>(overrides.publish ?? (async (req) => MOVED(req)))
  const locate = vi.fn<AttemptDeps['locate']>(overrides.locate ?? (async () => BINS))
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const runAttempt = createRunAttempt({
    dataDir,
    run: runFn,
    jsRuntime: NODE,
    now: () => NOW,
    log,
    ...overrides,
    locate,
    finalize,
    publish,
  })
  const updates: AttemptUpdate[] = []
  const controller = new AbortController()
  const start = (req = request(), onUpdate?: (update: AttemptUpdate) => void) =>
    runAttempt(req, controller.signal, (update) => {
      // Everything an attempt reports is on the contract.
      if (update.progress) JobProgressSchema.parse(update.progress)
      if (update.source) AudioSourceSchema.parse(update.source)
      if (update.match) TrackMatchSchema.parse(update.match)
      updates.push(update)
      onUpdate?.(update)
    })
  return { start, runFn, calls, finalize, publish, locate, log, updates, controller }
}

const failedWith = (error: ErrorInfo): AttemptOutcome => ({ kind: 'failed', error })
const codeOf = (outcome: AttemptOutcome) =>
  outcome.kind === 'failed' ? outcome.error.code : outcome.kind

describe('runAttempt: a download that works', () => {
  it('downloads the classified URL into its job dir, finalizes, publishes, and cleans up', async () => {
    const { start, calls, finalize, publish, updates } = setup({ lines: recorded('youtube-ba') })
    const outcome = await start()

    expect(outcome).toEqual({
      kind: 'done',
      outputPath: '/Users/dj/Music/DJ Scraper/jawed - Me at the zoo.mp3',
      output: OUTPUT,
      track: { title: 'Me at the zoo', artist: 'jawed', url: YT_URL },
      source: { codec: 'opus', bitrateKbps: 106.064 },
    })

    // yt-dlp: the classified URL after `--`, the job dir as -P, the cover for an MP3, killGraceMs 3 s.
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.bin).toBe(BINS.ytdlp)
    expect(call?.argv.slice(-2)).toEqual(['--', YT_URL])
    expect(call?.argv).toContain('--write-thumbnail')
    expect(call?.argv).toContain(`node:${NODE}`)
    expect(call?.argv).not.toContain('--ffmpeg-location')
    expect(call?.argv[call.argv.indexOf('-P') + 1]).toBe(jobDir())
    expect(call?.argv).toContain(DONE_PRINT)
    expect(call?.jobDirMode).toBe(0o700)
    expect(call?.options).toMatchObject({ killGraceMs: KILL_GRACE_MS })

    expect(updates).toEqual([
      { source: { codec: 'opus', bitrateKbps: 106.064 } },
      {
        status: 'downloading',
        progress: { percent: (1024 / 252182) * 100, downloadedBytes: 1024, totalBytes: 252182 },
      },
      { status: 'processing' },
    ])

    expect(finalize).toHaveBeenCalledTimes(1)
    const input = finalize.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      jobDir: jobDir(),
      bins: { ffmpeg: BINS.ffmpeg, ffprobe: BINS.ffprobe },
      done: {
        id: 'jNQXAC9IVRw',
        filepath: path.join(jobDir(), 'jNQXAC9IVRw.webm'),
        title: 'Me at the zoo',
        durationSec: 19,
      },
      input: { url: YT_URL, platform: 'youtube' },
      platform: 'youtube',
      format: 'mp3',
      options: {
        filenameTemplate: '{artist} - {title}',
        embedArtwork: true,
        sourceUrlComment: true,
      },
      // 1023 bytes less '/Users/dj/Music/DJ Scraper/'.
      nameMaxBytes: 996,
    })
    expect(publish).toHaveBeenCalledWith({
      src: path.join(jobDir(), 'finalize', 'final.mp3'),
      folder: FOLDER,
      name: 'jawed - Me at the zoo.mp3',
      attemptId: ATTEMPT,
      jobsDir: path.join(dataDir, 'jobs'),
      signal: expect.any(AbortSignal),
    })
  })

  it('reports skipped when a file of that name was already there', async () => {
    const { start } = setup(
      { lines: recorded('youtube-ba') },
      {
        publish: async (req) => ({ status: 'exists', path: path.join(req.folder.real, req.name) }),
      },
    )
    expect(await start()).toEqual({
      kind: 'skipped',
      outputPath: '/Users/dj/Music/DJ Scraper/jawed - Me at the zoo.mp3',
      track: { title: 'Me at the zoo', artist: 'jawed', url: YT_URL },
      source: { codec: 'opus', bitrateKbps: 106.064 },
    })
  })

  it('asks for no cover for WAV, nor without embedArtwork, and passes FFMPEG_PATH only when set', async () => {
    const { start, calls } = setup({ lines: recorded('youtube-ba') }, { ffmpegLocation: '/opt/ff' })
    await start(request(YT_URL, { options: { ...MP3, format: 'wav' } }))
    await start(request(YT_URL, { options: { ...MP3, embedArtwork: false } }))
    await start(request(YT_URL, { options: { ...MP3, format: 'm4a' } }))
    expect(calls.map((call) => call.argv.includes('--write-thumbnail'))).toEqual([
      false,
      false,
      true,
    ])
    for (const call of calls) {
      expect(call.argv[call.argv.indexOf('--ffmpeg-location') + 1]).toBe('/opt/ff')
    }
  })

  it('asks for no cover for a YouTube original (Opus in WebM), but for other originals', async () => {
    const { start, calls } = setup({ lines: recorded('youtube-ba') })
    const original = { ...MP3, format: 'original' } as const
    await start(request(YT_URL, { options: original }))
    await start(request(SC_URL, { options: original }))
    await start(request('https://example.com/mix.mp3', { options: original }))
    expect(calls.map((call) => call.argv.includes('--write-thumbnail'))).toEqual([
      false,
      true,
      true,
    ])
    // The selector stays the platform's best stream: "original" is never narrowed to fit a cover.
    expect(calls[0]?.argv[calls[0].argv.indexOf('-f') + 1]).toBe('ba')
  })

  it('uses the SoundCloud selector and break filter for a SoundCloud URL', async () => {
    const { start, calls, finalize } = setup({ lines: recorded('soundcloud-ba') })
    expect(codeOf(await start(request(SC_URL)))).toBe('done')
    expect(calls[0]?.argv).toContain('--break-match-filters')
    expect(calls[0]?.argv.slice(-1)).toEqual([SC_URL])
    expect(finalize.mock.calls[0]?.[0]).toMatchObject({ platform: 'soundcloud' })
  })

  it("forwards each DL line's percent as parsed: the queue keeps it from going back", async () => {
    const dl = (fields: object) => JSON.stringify({ status: 'downloading', ...fields })
    const { start, updates } = setup({
      lines: [
        ['stdout', 'START {"acodec": "mp4a.40.2", "abr": 160}'],
        ['stdout', `DL ${dl({ downloaded_bytes: 10, total_bytes_estimate: 20 })}`],
        ['stdout', `DL ${dl({ downloaded_bytes: 11, total_bytes_estimate: 1100 })}`],
        ['stdout', `DL ${dl({ downloaded_bytes: 12 })}`],
        ['stdout', `DL ${dl({ downloaded_bytes: 30, total_bytes: 40 })}`],
        ...recorded('soundcloud-hls-aac').slice(-5),
      ],
    })
    await start(request(SC_URL))
    const percents = updates.flatMap((update) =>
      update.progress === undefined || update.progress === null ? [] : [update.progress.percent],
    )
    expect(percents).toEqual([50, 1, undefined, 75])
  })

  it('reports the fragments of an HLS download as its percent (soundcloud-hls-aac)', async () => {
    const { start, updates } = setup({ lines: recorded('soundcloud-hls-aac') })
    expect(
      codeOf(await start(request('https://soundcloud.com/the-concept-band/knocked-up-mastered'))),
    ).toBe('done')
    const percents = updates.flatMap((update) =>
      update.progress === undefined || update.progress === null ? [] : [update.progress.percent],
    )
    expect(percents).toEqual([0, 1, 7, 13, 17, 21].map((index) => (index / 23) * 100))
    expect(updates.at(-1)).toEqual({ status: 'processing' })
  })
})

describe('runAttempt: waiting', () => {
  it('shows when the site makes yt-dlp wait, and clears it with the first DL line (youtube-ba-wait)', async () => {
    const { start, updates } = setup({ lines: recorded('youtube-ba-wait') })
    expect(codeOf(await start())).toBe('done')
    expect(updates[0]).toEqual({
      source: { codec: 'opus', bitrateKbps: 106.064 },
      progress: { waitingUntil: new Date(NOW + 3000).toISOString() },
    })
    expect(updates[1]?.status).toBe('downloading')
    expect(updates[1]?.progress).not.toHaveProperty('waitingUntil')
  })

  it("doesn't wait for an available_at in the past (youtube-ba)", async () => {
    const { start, updates } = setup({ lines: recorded('youtube-ba') })
    await start()
    expect(updates.some((update) => update.progress?.waitingUntil !== undefined)).toBe(false)
  })
})

describe('runAttempt: a link that is a list', () => {
  it('stops at a START with playlist_id (soundcloud-list-break, never preview_only)', async () => {
    const { start, finalize, controller, calls, log } = setup({
      lines: recorded('soundcloud-list-break'),
      // A live run goes on after the first START; the fake waits to be stopped instead.
      hangAfter: 1,
      exitCode: 101,
    })
    expect(await start(request(SC_URL))).toEqual(failedWith(LIST_URL))
    expect(calls[0]?.options.signal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(finalize).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      '[attempt] 00000000: the soundcloud link is a list, stopped',
    )
  })

  it('stops at the second START, even without playlist_id', async () => {
    const start1 = 'START {"format_id": "251", "acodec": "opus"}'
    const { start, calls } = setup({
      lines: [
        ['stdout', start1],
        ['stdout', start1],
      ],
      hangAfter: 2,
    })
    expect(await start()).toEqual(failedWith(LIST_URL))
    expect(calls[0]?.options.signal?.aborted).toBe(true)
  })

  it('stops at the second START with playlist_id of a list that got through (soundcloud-list)', async () => {
    const { start } = setup({ lines: recorded('soundcloud-list') })
    expect(await start(request(SC_URL))).toEqual(failedWith(LIST_URL))
  })

  it('stops at a second DONE', async () => {
    const lines = recorded('youtube-ba')
    const done = lines.at(-1)
    if (done === undefined) throw new Error('fixture has no DONE')
    const { start, finalize } = setup({ lines: [...lines, done] })
    expect(await start()).toEqual(failedWith(LIST_URL))
    expect(finalize).not.toHaveBeenCalled()
  })

  it('refuses a collection URL without starting yt-dlp', async () => {
    const url = 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep'
    const { start, runFn, locate } = setup({ lines: [] })
    const checked = checkUrl(url)
    if (!checked.ok) throw new Error('refused')
    expect(
      await start(
        request(SC_URL, { ref: { platform: 'soundcloud', id: '1', url }, input: checked.input }),
      ),
    ).toEqual(failedWith(LIST_URL))
    expect(runFn).not.toHaveBeenCalled()
    expect(locate).not.toHaveBeenCalled()
  })
})

describe('runAttempt: failures', () => {
  it('maps a Go+ preview (exit 101 with the break filter) to preview_only (soundcloud-preview-break)', async () => {
    const { start, finalize } = setup({
      lines: recorded('soundcloud-preview-break'),
      exitCode: 101,
    })
    const outcome = await start(request('https://soundcloud.com/the-concept-band/world-on-fire-1'))
    expect(codeOf(outcome)).toBe('preview_only')
    expect(finalize).not.toHaveBeenCalled()
  })

  it('reads exit 101 on YouTube as unexpected, never as a preview', async () => {
    const { start, log } = setup({ lines: [], exitCode: 101 })
    expect(codeOf(await start())).toBe('unknown')
    expect(log.warn).toHaveBeenCalledWith('[attempt] 00000000: yt-dlp failed (exit 101)')
  })

  it('maps a failed fragment to network (local-hls-404)', async () => {
    const { start } = setup({ lines: recorded('local-hls-404'), exitCode: 1 })
    expect(await start(request('http://127.0.0.1:4799/missing/master.m3u8'))).toEqual(
      failedWith({
        code: 'network',
        message: "Part of the file couldn't be downloaded. Try again.",
      }),
    )
  })

  it('maps a 429 to rate_limited (local-progressive-429)', async () => {
    const { start } = setup({ lines: recorded('local-progressive-429'), exitCode: 1 })
    expect(codeOf(await start(request('http://127.0.0.1:4799/flaky/tone.mp3')))).toBe(
      'rate_limited',
    )
  })

  it('fails with "no file" when yt-dlp exits 0 without a DONE line', async () => {
    const lines = recorded('youtube-ba').filter(([, line]) => !line.startsWith('DONE '))
    const { start, finalize } = setup({ lines })
    expect(await start()).toEqual(failedWith(NO_FILE))
    expect(finalize).not.toHaveBeenCalled()
  })

  it('fails with engine_missing, without spawning, when the engine is gone', async () => {
    const missing = new StepError('engine_missing', 'yt-dlp is not on PATH.')
    const { start, runFn } = setup(
      { lines: [] },
      {
        locate: async () => {
          throw missing
        },
      },
    )
    expect(await start()).toEqual(failedWith(missing.info))
    expect(runFn).not.toHaveBeenCalled()
  })

  it('fails with engine_missing when yt-dlp cannot start', async () => {
    const { start } = setup(() => {
      throw new SpawnError(BINS.ytdlp, Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    })
    expect(await start()).toEqual(
      failedWith({ code: 'engine_missing', message: "yt-dlp can't start (EACCES)." }),
    )
  })

  it.each([
    ['finalize', 'postprocess_failed'],
    ['publish', 'folder_unavailable'],
    ['publish', 'disk_full'],
  ] as const)('fails with the StepError of %s (%s)', async (step, code) => {
    const error = new StepError(code, 'It went wrong.')
    const reject = async () => {
      throw error
    }
    const { start } = setup(
      { lines: recorded('youtube-ba') },
      step === 'finalize' ? { finalize: reject } : { publish: reject },
    )
    expect(await start()).toEqual(failedWith({ code, message: 'It went wrong.' }))
  })

  it('rejects with what finalize threw when it is no StepError (the queue words it), still cleaning up', async () => {
    const bug = new TypeError('bug')
    const { start } = setup(
      { lines: recorded('youtube-ba') },
      {
        finalize: async () => {
          throw bug
        },
      },
    )
    await expect(start()).rejects.toBe(bug)
  })

  it('refuses a ref whose URL no longer matches the classified input, without spawning', async () => {
    const other = checkUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa')
    if (!other.ok) throw new Error('refused')
    const { start, runFn } = setup({ lines: [] })
    const outcome = await start(request(YT_URL, { input: other.input }))
    expect(codeOf(outcome)).toBe('invalid_request')
    expect(runFn).not.toHaveBeenCalled()
  })

  it('refuses a ref URL that does not classify (invalid_url) or is DRM (unsupported_url)', async () => {
    const { start, runFn } = setup({ lines: [] })
    const base = request()
    expect(codeOf(await start({ ...base, ref: { ...base.ref, url: 'notaurl' } }))).toBe(
      'invalid_url',
    )
    const drm = 'https://music.apple.com/us/album/x/1440857781?i=1440857786'
    expect(codeOf(await start({ ...base, ref: { ...base.ref, url: drm } }))).toBe('unsupported_url')
    const spotifyArtist = 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt'
    expect(codeOf(await start({ ...base, ref: { ...base.ref, url: spotifyArtist } }))).toBe(
      'unsupported_url',
    )
    expect(runFn).not.toHaveBeenCalled()
  })

  it('maps a full data drive while yt-dlp writes to disk_full (local-enospc-write)', async () => {
    const stderr = readFileSync(path.join(downloadsDir, '../errors/local-enospc-write.log'), 'utf8')
    const { start } = setup({
      lines: [
        ...recorded('youtube-ba').slice(0, 2),
        ...splitLines(stderr).map((line): Line => ['stderr', line]),
      ],
      exitCode: 1,
    })
    expect(await start()).toEqual(
      failedWith({ code: 'disk_full', message: "The drive with DJ Scraper's data is full." }),
    )
  })

  it("cuts the job dir out of yt-dlp's words", async () => {
    const { start } = setup({
      lines: [['stderr', 'ERROR: Odd failure in {JOBDIR}/jNQXAC9IVRw.webm.part']],
      exitCode: 1,
    })
    expect(await start()).toEqual(
      failedWith({ code: 'unknown', message: 'yt-dlp: Odd failure in …/jNQXAC9IVRw.webm.part.' }),
    )
  })

  it('refuses a folder whose path leaves no room for the part file, without spawning', async () => {
    // 1023 bytes less the folder and its slash must hold `._.djs-<uuid>.part` (48 bytes).
    const real = `/Volumes/USB/${'日'.repeat(321)}`
    expect(nameBytesLeft(real)).toBe(46)
    const { start, runFn, finalize } = setup({ lines: recorded('youtube-ba') })
    expect(await start(request(YT_URL, { folder: { given: real, real } }))).toEqual(
      failedWith({
        code: 'invalid_request',
        message:
          'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
      }),
    )
    expect(runFn).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it('fails with disk_full when the job dir cannot be created on a full drive', async () => {
    const enospc = Object.assign(new Error('ENOSPC: /secret'), { code: 'ENOSPC' })
    const { start, runFn } = setup(
      { lines: [] },
      {
        fs: {
          mkdir: async () => {
            throw enospc
          },
        },
      },
    )
    expect(codeOf(await start())).toBe('disk_full')
    const other = Object.assign(new Error('EACCES: /secret'), { code: 'EACCES' })
    const second = setup(
      { lines: [] },
      {
        fs: {
          mkdir: async () => {
            throw other
          },
        },
      },
    )
    expect(await second.start()).toEqual(
      failedWith({
        code: 'unknown',
        message: "The download's work folder can't be created (EACCES).",
      }),
    )
    expect(runFn).not.toHaveBeenCalled()
  })

  it('keeps going when an update listener throws', async () => {
    const { start, log } = setup({ lines: recorded('youtube-ba') })
    const outcome = await start(request(), () => {
      throw new Error('listener bug')
    })
    expect(codeOf(outcome)).toBe('done')
    expect(log.error).toHaveBeenCalledWith('[attempt] 00000000: an update listener failed: Error')
  })
})

describe('nameBytesLeft', () => {
  it("counts the folder's bytes, not its characters, against macOS's 1023", () => {
    expect(nameBytesLeft('/Users/dj/Music/DJ Scraper')).toBe(1023 - 27)
    // 3 bytes a character: a CJK playlist subfolder leaves less than its length suggests.
    expect(nameBytesLeft('/Users/dj/Music/日本語のプレイリスト')).toBe(1023 - 16 - 30 - 1)
    expect(nameBytesLeft('/')).toBe(1022)
  })

  it('hands finalize the bytes a long CJK folder leaves', async () => {
    const real = `/Users/dj/Music/${'日'.repeat(195)}`
    const { start, finalize } = setup({ lines: recorded('youtube-ba') })
    await start(request(YT_URL, { folder: { given: real, real } }))
    expect(finalize.mock.calls[0]?.[0].nameMaxBytes).toBe(1023 - 16 - 585 - 1)
  })
})

describe('runAttempt: cancel', () => {
  it('returns canceled at once when the signal is already aborted, without a job dir', async () => {
    const mkdirSpy = vi.fn(async () => undefined)
    const { start, controller, runFn } = setup({ lines: [] }, { fs: { mkdir: mkdirSpy } })
    controller.abort({ kind: 'cancel' })
    expect(await start()).toEqual({ kind: 'canceled' })
    expect(mkdirSpy).not.toHaveBeenCalled()
    expect(runFn).not.toHaveBeenCalled()
  })

  it('returns canceled when the cancel comes while the engine is located', async () => {
    const located = Promise.withResolvers<EngineBins>()
    const { start, controller, runFn, locate } = setup(
      { lines: [] },
      { locate: () => located.promise },
    )
    const outcome = start()
    await vi.waitFor(() => expect(locate).toHaveBeenCalled())
    controller.abort({ kind: 'cancel' })
    located.resolve(BINS)
    expect(await outcome).toEqual({ kind: 'canceled' })
    expect(runFn).not.toHaveBeenCalled()
  })

  it('stops yt-dlp and returns canceled when the cancel comes while it downloads (youtube-cancel-download)', async () => {
    const { start, controller, calls, finalize, updates } = setup({
      lines: recorded('youtube-cancel-download'),
      hangAfter: 3,
    })
    const outcome = start()
    await vi.waitFor(() => expect(updates).toHaveLength(3))
    controller.abort({ kind: 'cancel' })
    expect(await outcome).toEqual({ kind: 'canceled' })
    expect(calls[0]?.options.signal?.aborted).toBe(true)
    expect(finalize).not.toHaveBeenCalled()
  })

  it('returns canceled for a shutdown as well (the queue tells them apart)', async () => {
    const { start, controller, calls } = setup({ lines: recorded('youtube-ba'), hangAfter: 1 })
    const outcome = start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    controller.abort({ kind: 'shutdown' })
    expect(await outcome).toEqual({ kind: 'canceled' })
  })

  it.each(['finalize', 'publish'] as const)(
    'returns canceled when the cancel comes during %s',
    async (step) => {
      const entered = Promise.withResolvers<void>()
      const untilCanceled = async (input: { signal: AbortSignal }): Promise<never> => {
        entered.resolve()
        await untilAborted(input.signal)
        throw input.signal.reason
      }
      const { start, controller, publish } = setup(
        { lines: recorded('youtube-ba') },
        step === 'finalize' ? { finalize: untilCanceled } : { publish: untilCanceled },
      )
      const outcome = start()
      await entered.promise
      controller.abort({ kind: 'cancel' })
      expect(await outcome).toEqual({ kind: 'canceled' })
      if (step === 'finalize') expect(publish).not.toHaveBeenCalled()
    },
  )

  it('keeps a file that reached the folder although the cancel came during publish', async () => {
    const { start, controller } = setup(
      { lines: recorded('youtube-ba') },
      {
        // The claim is the one step a cancel doesn't stop.
        publish: async (req) => {
          controller.abort({ kind: 'cancel' })
          return MOVED(req)
        },
      },
    )
    expect(codeOf(await start())).toBe('done')
  })

  it('returns canceled when a finalize StepError races a cancel', async () => {
    const { start, controller } = setup(
      { lines: recorded('youtube-ba') },
      {
        finalize: async () => {
          controller.abort({ kind: 'cancel' })
          throw new StepError('postprocess_failed', 'ffmpeg was stopped.')
        },
      },
    )
    expect(await start()).toEqual({ kind: 'canceled' })
  })
})

describe('runAttempt: cleanup', () => {
  it('removes the job dir with everything in it after every outcome', async () => {
    const rmSpy = vi.fn<NonNullable<NonNullable<AttemptDeps['fs']>['rm']>>((dir, options) =>
      rm(dir, options),
    )
    const outcomes: string[] = []
    for (const exitCode of [0, 1]) {
      const { start } = setup(
        { lines: recorded('youtube-ba'), exitCode },
        {
          fs: { rm: rmSpy },
          finalize: async (input) => {
            // Something finalize left in the job dir.
            await mkdir(path.join(input.jobDir, 'finalize'))
            return FINALIZED(input)
          },
        },
      )
      outcomes.push(codeOf(await start()))
    }
    expect(outcomes).toEqual(['done', 'unknown'])
    expect(rmSpy).toHaveBeenCalledTimes(2)
    expect(rmSpy).toHaveBeenCalledWith(jobDir(), { recursive: true, force: true })
  })

  it('logs (by code) a job dir it could not remove, and keeps the outcome', async () => {
    const { start, log } = setup(
      { lines: recorded('youtube-ba') },
      {
        fs: {
          rm: async (dir, options) => {
            await rm(dir, options)
            throw Object.assign(new Error(`EBUSY: ${dir}`), { code: 'EBUSY' })
          },
        },
      },
    )
    expect(codeOf(await start())).toBe('done')
    expect(log.warn).toHaveBeenCalledWith("[attempt] 00000000: can't remove the job dir (EBUSY)")
  })

  it('never logs the URL, the title or a path', async () => {
    const { start, log } = setup({ lines: recorded('soundcloud-list-break'), hangAfter: 1 })
    await start(request(SC_URL))
    const second = setup({ lines: [], exitCode: 7 })
    await second.start()
    const logged = [log, second.log]
      .flatMap((l) => [...l.info.mock.calls, ...l.warn.mock.calls, ...l.error.mock.calls])
      .flat()
      .join('\n')
    expect(logged).not.toMatch(/https?:|s-8Pjrp|zoo|\/Users|\/private|\/var/)
  })
})

describe('runAttempt: a Spotify track (ADR-026)', () => {
  const SPOTIFY_URL = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
  const COVER_URL =
    'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673'
  const COVER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])
  const YT_THUMBNAIL = 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp'
  const TRACK: SpotifyTrack = {
    id: '4uLU6hMCjMI75M1A2tKUQC',
    title: 'Never Gonna Give You Up',
    artists: ['Rick Astley'],
    durationSec: 213.573,
    releaseYear: 1987,
    coverUrl: COVER_URL,
  }
  /** The recorded download (youtube-ba, jNQXAC9IVRw) stands in for the matched video's. */
  const MATCH: TrackMatch = {
    platform: 'youtube',
    id: 'jNQXAC9IVRw',
    url: YT_URL,
    title: 'Me at the zoo',
    uploader: 'jawed',
    durationSec: 19,
  }

  function youtubeInput() {
    const checked = checkUrl(YT_URL)
    if (!checked.ok) throw new Error('refused')
    return checked.input
  }

  type Found = Awaited<ReturnType<SpotifyDownloads['match']>>
  const matched = (track: SpotifyTrack = TRACK): Found => ({
    ok: true,
    matched: { track, match: MATCH, input: youtubeInput() },
  })

  function fakeSpotify({
    found = matched(),
    cover = async () => COVER,
  }: {
    found?: Found | ((signal: AbortSignal) => Promise<Found>)
    cover?: SpotifyDownloads['cover']
  } = {}) {
    return {
      match: vi.fn<SpotifyDownloads['match']>(async (_input, _ytdlp, signal) =>
        typeof found === 'function' ? found(signal) : found,
      ),
      cover: vi.fn<SpotifyDownloads['cover']>(cover),
    }
  }

  /** finalize as the real one sees it: the DONE info, and the cover file in the job dir. */
  function finalizeSpy() {
    const seen: { done?: DoneInfo; cover?: Uint8Array; coverMode?: number; input?: FinalizeInput } =
      {}
    const finalize = async (input: FinalizeInput): Promise<FinalizeResult> => {
      seen.done = input.done
      seen.input = input
      if (input.done.thumbnailPath?.endsWith('spotify-cover.jpg')) {
        seen.cover = new Uint8Array(await readFile(input.done.thumbnailPath))
        seen.coverMode = (await stat(input.done.thumbnailPath)).mode & 0o777
      }
      return {
        file: path.join(input.jobDir, 'finalize', 'final.mp3'),
        name: 'Rick Astley - Never Gonna Give You Up.mp3',
        output: OUTPUT,
        track: {
          ...(input.done.title === undefined ? {} : { title: input.done.title }),
          ...(input.done.artist === undefined ? {} : { artist: input.done.artist }),
          ...(input.done.webpageUrl === undefined ? {} : { url: input.done.webpageUrl }),
          ...(input.done.thumbnailUrl === undefined
            ? {}
            : { thumbnailUrl: input.done.thumbnailUrl }),
        },
      }
    }
    return { finalize, seen }
  }

  it('matches the track first, reports the match, then downloads only the matched video', async () => {
    const spotify = fakeSpotify()
    const { finalize, seen } = finalizeSpy()
    const { start, calls, runFn, updates } = setup(
      { lines: recorded('youtube-ba') },
      { spotify, finalize },
    )
    let ranBeforeMatch = true
    const outcome = await start(request(SPOTIFY_URL), (update) => {
      if (update.match !== undefined) ranBeforeMatch = runFn.mock.calls.length > 0
    })

    expect(spotify.match).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ platform: 'spotify', kind: 'spotify_track', url: SPOTIFY_URL }),
      BINS.ytdlp,
      expect.any(AbortSignal),
      JOB,
      // The search names the job dir, so the startup sweep finds it.
      jobDir(),
    )
    // The match is the first thing the job hears, before yt-dlp starts.
    expect(updates[0]).toEqual({ match: MATCH })
    expect(updates.filter((update) => update.match !== undefined)).toHaveLength(1)
    expect(ranBeforeMatch).toBe(false)

    // yt-dlp gets the YouTube video, as a YouTube download, and never the Spotify link.
    expect(calls).toHaveLength(1)
    const argv = calls[0]?.argv ?? []
    expect(argv.slice(-2)).toEqual(['--', YT_URL])
    expect(argv.join('\n')).not.toContain('spotify')
    expect(argv[argv.indexOf('-f') + 1]).toBe('ba')
    expect(argv).toContain('--write-thumbnail')
    expect(seen.input).toMatchObject({ platform: 'youtube', input: youtubeInput() })

    expect(outcome).toEqual({
      kind: 'done',
      outputPath: '/Users/dj/Music/DJ Scraper/Rick Astley - Never Gonna Give You Up.mp3',
      output: OUTPUT,
      // The job keeps its Spotify link (no url here) and shows Spotify's cover.
      track: { title: 'Never Gonna Give You Up', artist: 'Rick Astley', thumbnailUrl: COVER_URL },
      source: { codec: 'opus', bitrateKbps: 106.064 },
    })
  })

  it("tags with Spotify's names, year and cover, and keeps YouTube's page for the comment", async () => {
    const spotify = fakeSpotify()
    const { finalize, seen } = finalizeSpy()
    const { start } = setup({ lines: recorded('youtube-ba') }, { spotify, finalize })
    await start(request(SPOTIFY_URL))

    expect(spotify.cover).toHaveBeenCalledExactlyOnceWith(COVER_URL, expect.any(AbortSignal))
    const coverPath = path.join(jobDir(), 'spotify-cover.jpg')
    expect(seen.done).toEqual({
      id: 'jNQXAC9IVRw',
      filepath: path.join(jobDir(), 'jNQXAC9IVRw.webm'),
      ext: 'webm',
      formatId: '251',
      acodec: 'opus',
      abrKbps: 106.064,
      asrHz: 48000,
      durationSec: 19,
      title: 'Never Gonna Give You Up',
      track: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      artists: ['Rick Astley'],
      releaseYear: 1987,
      uploader: 'jawed',
      channel: 'jawed',
      webpageUrl: YT_URL,
      extractorKey: 'Youtube',
      availability: 'public',
      thumbnailPath: coverPath,
      thumbnailUrl: COVER_URL,
    })
    // The cover's bytes as Spotify sent them, private to the job dir.
    expect(seen.cover).toEqual(COVER)
    expect(seen.coverMode).toBe(0o600)
  })

  it.each([
    ['no cover', async () => undefined],
    [
      'a cover that fails',
      async () => {
        throw Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' })
      },
    ],
  ])(
    "keeps YouTube's thumbnail when Spotify's gives %s, and still downloads",
    async (_label, cover) => {
      const spotify = fakeSpotify({ cover })
      const { finalize, seen } = finalizeSpy()
      const { start, log } = setup({ lines: recorded('youtube-ba') }, { spotify, finalize })
      // The job shows the cover the file really got: YouTube's.
      expect(await start(request(SPOTIFY_URL))).toMatchObject({
        kind: 'done',
        track: { title: 'Never Gonna Give You Up', thumbnailUrl: YT_THUMBNAIL },
      })
      expect(seen.done).toMatchObject({
        title: 'Never Gonna Give You Up',
        thumbnailPath: path.join(jobDir(), 'jNQXAC9IVRw.webp'),
        thumbnailUrl: YT_THUMBNAIL,
      })
      expect(seen.cover).toBeUndefined()
      const logged = [...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')
      expect(logged).not.toContain('/secret')
      expect(logged).not.toContain('spotifycdn')
    },
  )

  it('logs a failed cover by its error code only', async () => {
    const eacces = Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' })
    const spotify = fakeSpotify()
    const { start, log } = setup(
      { lines: recorded('youtube-ba') },
      {
        spotify,
        fs: {
          writeFile: async () => {
            throw eacces
          },
        },
      },
    )
    expect(await start(request(SPOTIFY_URL))).toMatchObject({ kind: 'done' })
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[attempt] 00000000: the Spotify cover failed (EACCES)',
    )
  })

  it.each([
    ['WAV, which holds no cover', { format: 'wav' as const }],
    ['artwork turned off', { embedArtwork: false }],
  ])('fetches no Spotify cover for %s', async (_label, options) => {
    const spotify = fakeSpotify()
    const { finalize, seen } = finalizeSpy()
    const { start, calls } = setup({ lines: recorded('youtube-ba-nothumb') }, { spotify, finalize })
    const outcome = await start(request(SPOTIFY_URL, { options: { ...MP3, ...options } }))
    expect(spotify.cover).not.toHaveBeenCalled()
    // No file holds a cover, so the job shows Spotify's, as the track list did.
    expect(outcome).toMatchObject({ kind: 'done', track: { thumbnailUrl: TRACK.coverUrl } })
    expect(calls[0]?.argv).not.toContain('--write-thumbnail')
    expect(seen.done).not.toHaveProperty('thumbnailPath')
    expect(seen.done).toMatchObject({ title: 'Never Gonna Give You Up', releaseYear: 1987 })
  })

  it('fetches no cover for a Spotify track without one', async () => {
    const { coverUrl: _none, ...noCover } = TRACK
    const spotify = fakeSpotify({ found: matched(noCover) })
    const { finalize, seen } = finalizeSpy()
    const { start } = setup({ lines: recorded('youtube-ba') }, { spotify, finalize })
    const outcome = await start(request(SPOTIFY_URL))
    expect(spotify.cover).not.toHaveBeenCalled()
    expect(seen.done).toMatchObject({ thumbnailUrl: YT_THUMBNAIL })
    // The job shows the cover the file got.
    expect(outcome).toMatchObject({ kind: 'done', track: { thumbnailUrl: YT_THUMBNAIL } })
  })

  it('fails with no_match without starting a download', async () => {
    const spotify = fakeSpotify({ found: { ok: false, error: NO_MATCH } })
    const { start, runFn, finalize, updates } = setup(
      { lines: recorded('youtube-ba') },
      { spotify },
    )
    expect(await start(request(SPOTIFY_URL))).toEqual(failedWith(NO_MATCH))
    expect(runFn).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it.each([
    {
      code: 'unavailable',
      message: "Spotify doesn't show this link: it may be private, removed or mistyped.",
    },
    {
      code: 'bot_check',
      message: "YouTube wants to check that you're not a bot. Try again later.",
    },
    { code: 'engine_missing', message: 'yt-dlp is not on PATH.' },
  ] as const)('fails with the match step’s $code', async (error) => {
    const spotify = fakeSpotify({ found: { ok: false, error } })
    const { start, runFn } = setup({ lines: [] }, { spotify })
    expect(await start(request(SPOTIFY_URL))).toEqual(failedWith(error))
    expect(runFn).not.toHaveBeenCalled()
  })

  it('refuses a Spotify job when the server has no Spotify reader', async () => {
    const { start, runFn } = setup({ lines: recorded('youtube-ba') })
    expect(await start(request(SPOTIFY_URL))).toEqual(
      failedWith({
        code: 'unsupported_url',
        message: "This server can't download Spotify tracks.",
      }),
    )
    expect(runFn).not.toHaveBeenCalled()
  })

  it('ends canceled when the cancel comes while matching, without downloading', async () => {
    const spotify = fakeSpotify({
      found: (signal) =>
        new Promise<Found>((resolve) => {
          signal.addEventListener('abort', () => resolve({ ok: false, error: CANCELED }))
        }),
    })
    const { start, runFn, controller, updates } = setup(
      { lines: recorded('youtube-ba') },
      { spotify },
    )
    const outcome = start(request(SPOTIFY_URL))
    await vi.waitFor(() => expect(spotify.match).toHaveBeenCalled())
    controller.abort({ kind: 'cancel' })
    expect(await outcome).toEqual({ kind: 'canceled' })
    expect(runFn).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('ends canceled when the cancel comes while fetching the cover, before finalizing', async () => {
    let started = () => {}
    const fetching = new Promise<void>((resolve) => {
      started = resolve
    })
    const spotify = fakeSpotify({
      cover: (_url, signal) =>
        new Promise((_resolve, reject) => {
          started()
          signal?.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    const { start, controller, finalize } = setup({ lines: recorded('youtube-ba') }, { spotify })
    const outcome = start(request(SPOTIFY_URL))
    await fetching
    controller.abort({ kind: 'cancel' })
    expect(await outcome).toEqual({ kind: 'canceled' })
    expect(finalize).not.toHaveBeenCalled()
  })

  describe('when YouTube refuses the match', () => {
    const errorsDir = path.join(downloadsDir, '../errors')
    /** A download that fails like the recorded lookup error `<name>.log`, exit 1. */
    const refusal = (name: string): Script => ({
      lines: splitLines(readFileSync(path.join(errorsDir, `${name}.log`), 'utf8')).map(
        (line): Line => ['stderr', line],
      ),
      exitCode: 1,
    })
    const nextMatch = (id: string, title: string): { match: TrackMatch; input: ValidUrl } => {
      const url = `https://www.youtube.com/watch?v=${id}`
      const checked = checkUrl(url)
      if (!checked.ok) throw new Error('refused')
      return {
        match: { platform: 'youtube', id, url, title, uploader: 'Rick Astley', durationSec: 213 },
        input: checked.input,
      }
    }
    const SECOND = nextMatch('LLFhKaqnWwk', 'Rick Astley - Never Gonna Give You Up (Animated)')
    const THIRD = nextMatch('3BFTio5296w', 'Never Gonna Give You Up (2022 Remaster)')
    const FOURTH = nextMatch('RrESvSRNpeo', 'Rick Astley - Never Gonna Give You Up')
    const withAlternatives = (alternatives = [SECOND, THIRD]): Found => ({
      ok: true,
      matched: { track: TRACK, match: MATCH, input: youtubeInput(), alternatives },
    })
    /** One script per yt-dlp run, in order. */
    const runs = (...scripts: Script[]) => {
      let call = 0
      return () => scripts[Math.min(call++, scripts.length - 1)] ?? { lines: [] }
    }
    const urlsOf = (calls: readonly RunCall[]) => calls.map((call) => call.argv.at(-1))

    it('downloads the next match, reporting it with the progress cleared', async () => {
      const spotify = fakeSpotify({ found: withAlternatives() })
      const { finalize, seen } = finalizeSpy()
      const { start, calls, updates, log } = setup(
        runs(refusal('youtube-unavailable'), { lines: recorded('youtube-ba') }),
        { spotify, finalize },
      )
      const outcome = await start(request(SPOTIFY_URL))
      expect(outcome).toMatchObject({ kind: 'done', track: { title: 'Never Gonna Give You Up' } })
      expect(urlsOf(calls)).toEqual([YT_URL, SECOND.match.url])
      expect(updates.filter((update) => update.match !== undefined)).toEqual([
        { match: MATCH },
        { match: SECOND.match, progress: null },
      ])
      // The second try reports its match before its own yt-dlp lines.
      const second = updates.findIndex((update) => update.match === SECOND.match)
      expect(updates.slice(second + 1).some((update) => update.progress)).toBe(true)
      expect(seen.input?.input).toEqual(SECOND.input)
      expect(seen.done?.webpageUrl).toBe(YT_URL) // the replayed recording's own page
      expect(log.info).toHaveBeenCalledWith('[attempt] 00000000: match 1 refused, trying the next')
    })

    it.each([
      ['private', 'youtube-private'],
      ['geo_blocked', 'youtube-geo-blocked'],
      ['age_restricted', 'youtube-age-restricted'],
      ['login_required', 'youtube-members-only'],
    ])('tries the next match after %s too', async (_code, log) => {
      const spotify = fakeSpotify({ found: withAlternatives() })
      const { start, calls } = setup(runs(refusal(log), { lines: recorded('youtube-ba') }), {
        spotify,
      })
      expect(await start(request(SPOTIFY_URL))).toMatchObject({ kind: 'done' })
      expect(urlsOf(calls)).toEqual([YT_URL, SECOND.match.url])
    })

    it.each([
      ['network', 'network-timeout'],
      ['bot_check', 'youtube-bot-check'],
      ['rate_limited', 'youtube-rate-limited'],
    ])('ends with %s at once: another upload would fail the same way', async (code, log) => {
      const spotify = fakeSpotify({ found: withAlternatives() })
      const { start, calls, updates } = setup(
        runs(refusal(log), { lines: recorded('youtube-ba') }),
        {
          spotify,
        },
      )
      expect(codeOf(await start(request(SPOTIFY_URL)))).toBe(code)
      expect(urlsOf(calls)).toEqual([YT_URL])
      expect(updates.filter((update) => update.match !== undefined)).toEqual([{ match: MATCH }])
    })

    it(`tries at most ${MAX_MATCH_TRIES} matches, and ends with the last one's refusal`, async () => {
      const spotify = fakeSpotify({ found: withAlternatives([SECOND, THIRD, FOURTH]) })
      const { start, calls, finalize } = setup(
        runs(
          refusal('youtube-unavailable'),
          refusal('youtube-private'),
          refusal('youtube-geo-blocked'),
          { lines: recorded('youtube-ba') },
        ),
        { spotify },
      )
      expect(codeOf(await start(request(SPOTIFY_URL)))).toBe('geo_blocked')
      expect(MAX_MATCH_TRIES).toBe(3)
      expect(urlsOf(calls)).toEqual([YT_URL, SECOND.match.url, THIRD.match.url])
      expect(finalize).not.toHaveBeenCalled()
    })

    it('ends with the refusal when there is no other match', async () => {
      const spotify = fakeSpotify()
      const { start, calls } = setup(runs(refusal('youtube-unavailable')), { spotify })
      expect(codeOf(await start(request(SPOTIFY_URL)))).toBe('unavailable')
      expect(calls).toHaveLength(1)
    })

    it('ends canceled when the cancel comes during the next match’s download', async () => {
      const spotify = fakeSpotify({ found: withAlternatives() })
      const { start, calls, controller, finalize } = setup(
        runs(
          refusal('youtube-unavailable'),
          { lines: recorded('youtube-ba'), hangAfter: 2 },
          {
            lines: recorded('youtube-ba'),
          },
        ),
        { spotify },
      )
      const outcome = start(request(SPOTIFY_URL))
      await vi.waitFor(() => expect(calls).toHaveLength(2))
      controller.abort({ kind: 'cancel' })
      expect(await outcome).toEqual({ kind: 'canceled' })
      expect(urlsOf(calls)).toEqual([YT_URL, SECOND.match.url])
      expect(finalize).not.toHaveBeenCalled()
    })
  })
})

describe('withSpotifyNames', () => {
  const DONE: DoneInfo = {
    id: 'dQw4w9WgXcQ',
    filepath: '/jobs/x/dQw4w9WgXcQ.webm',
    ext: 'webm',
    title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
    track: 'Never Gonna Give You Up (Remastered)',
    artist: 'Rick Astley',
    artists: ['Rick Astley'],
    uploader: 'Rick Astley',
    channel: 'Rick Astley',
    album: 'The Best of Me',
    albumArtist: 'Various Artists',
    releaseYear: 2019,
    releaseDate: '20191025',
    webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    extractorKey: 'Youtube',
    thumbnailPath: '/jobs/x/dQw4w9WgXcQ.webp',
    thumbnailUrl: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
  }
  const TRACK: SpotifyTrack = {
    id: '4uLU6hMCjMI75M1A2tKUQC',
    title: 'Never Gonna Give You Up',
    artists: ['Rick Astley', 'Guest'],
    durationSec: 213.573,
    releaseYear: 1987,
    coverUrl: 'https://i.scdn.co/image/ab67616d0000b273',
  }

  it("puts Spotify's title, artists, year and cover in YouTube's place, and drops its album", () => {
    expect(withSpotifyNames(DONE, TRACK, '/jobs/x/spotify-cover.jpg')).toStrictEqual({
      id: 'dQw4w9WgXcQ',
      filepath: '/jobs/x/dQw4w9WgXcQ.webm',
      ext: 'webm',
      title: 'Never Gonna Give You Up',
      track: 'Never Gonna Give You Up',
      artist: 'Rick Astley, Guest',
      artists: ['Rick Astley', 'Guest'],
      releaseYear: 1987,
      // The upload's channel and page stay: the comment tag names where the audio came from.
      uploader: 'Rick Astley',
      channel: 'Rick Astley',
      webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      extractorKey: 'Youtube',
      thumbnailPath: '/jobs/x/spotify-cover.jpg',
      thumbnailUrl: 'https://i.scdn.co/image/ab67616d0000b273',
    })
  })

  it("keeps YouTube's thumbnail without a Spotify cover file", () => {
    expect(withSpotifyNames(DONE, TRACK, undefined)).toMatchObject({
      thumbnailPath: DONE.thumbnailPath,
      thumbnailUrl: DONE.thumbnailUrl,
    })
  })

  it("never falls back to YouTube's year, album or release date", () => {
    const { releaseYear: _none, ...undated } = TRACK
    const named = withSpotifyNames(DONE, undated, undefined)
    for (const key of ['releaseYear', 'releaseDate', 'album', 'albumArtist']) {
      expect(named).not.toHaveProperty(key)
    }
  })

  it('leaves no field present but undefined', () => {
    const bare: DoneInfo = { id: 'x', filepath: '/jobs/x/x.webm' }
    const named = withSpotifyNames(bare, { id: TRACK.id, title: 'T', artists: [] }, undefined)
    expect(named).toStrictEqual({ id: 'x', filepath: '/jobs/x/x.webm', title: 'T', track: 'T' })
  })
})
