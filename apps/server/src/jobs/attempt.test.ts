import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AudioSourceSchema,
  type DownloadOptions,
  type ErrorInfo,
  JobProgressSchema,
  type TrackRef,
} from '@dj-scraper/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RunOptions, type RunResult, type run, SpawnError } from '../engine/run.ts'
import { DONE_PRINT } from '../engine/ytdlp-args.ts'
import { checkUrl } from '../resolve/input.ts'
import {
  type AttemptDeps,
  createRunAttempt,
  KILL_GRACE_MS,
  LIST_URL,
  NO_FILE,
  nameBytesLeft,
} from './attempt.ts'
import {
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptUpdate,
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
    const drm = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
    expect(codeOf(await start({ ...base, ref: { ...base.ref, url: drm } }))).toBe('unsupported_url')
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
