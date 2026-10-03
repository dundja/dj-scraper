import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyUrl, type DownloadFormat, type ValidUrl } from '@dj-scraper/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  framesOf,
  readAiff,
  readAiffTag,
  readComment,
  readMp3Tag,
  readPicture,
  textOf,
} from '../../test/id3-reader.ts'
import { type DoneInfo, type FinalizeInput, StepError } from '../jobs/types.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import {
  audioTimeoutMs,
  COVER_TIMEOUT_MS,
  createFinalize,
  FINALIZE_DIR,
  type FinalizeFs,
  MEASURE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from './finalize.ts'
import { type RunOptions, type RunResult, type run, SpawnError } from './run.ts'

const FFPROBE_DIR = path.join(import.meta.dirname, '../../test/fixtures/ffprobe')
const YOUTUBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const SOUNDCLOUD = 'https://soundcloud.com/the-concept-band/knocked-up-mastered'
const SOUNDCLOUD_SECRET = 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp'
const BINS = { ffmpeg: '/opt/fake/ffmpeg', ffprobe: '/opt/fake/ffprobe' }

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 9, 9)
const WEBP = Uint8Array.from([...'RIFF\u{24}\u{5a}\u{0}\u{0}WEBPVP8 '].map((c) => c.charCodeAt(0)))
const FAKE_AUDIO = new TextEncoder().encode('FAKEAUDIO frames')

/** A minimal AIFF like ffmpeg's: FORM, COMM, SSND (even length, exact FORM size). */
function minimalAiff(): Uint8Array {
  const comm = [0x43, 0x4f, 0x4d, 0x4d, 0, 0, 0, 18, 0, 2, 0, 0, 0, 1, 0, 16, 0x40, 0x0e]
  comm.push(0xbb, 0x80, 0, 0, 0, 0, 0, 0)
  const ssnd = [0x53, 0x53, 0x4e, 0x44, 0, 0, 0, 12, ...new Array(12).fill(0)]
  const body = [0x41, 0x49, 0x46, 0x46, ...comm, ...ssnd]
  return Uint8Array.from([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, body.length, ...body])
}

type Call = { bin: string; argv: readonly string[]; options: RunOptions }
type Reply = {
  exitCode?: number
  stdout?: string
  stderr?: string
  timedOut?: boolean
  /** Waits for the signal, then settles as run() does after stopping the group. */
  hang?: boolean
  /** Bytes for the output file (the last argv entry) instead of the default; false: none. */
  write?: Uint8Array | false
  spawnError?: string
}

/** ffmpeg 8's `-progress pipe:1` report at the end of a pass that reached `seconds`. */
function progressReport(seconds: number): string {
  const micros = Math.round(seconds * 1_000_000)
  return `bitrate=N/A\ntotal_size=N/A\nout_time_us=${micros}\nout_time_ms=${micros}\nout_time=00:00:00.000000\ndup_frames=0\ndrop_frames=0\nspeed=9.42e+03x\nprogress=end\n`
}

const isMeasuring = (call: Pick<Call, 'bin' | 'argv'>) =>
  call.bin === BINS.ffmpeg && call.argv.includes('-progress')

/**
 * A scripted run(): ffprobe answers with the recorded JSON for the probed file's name (`probes`),
 * ffmpeg's measuring pass reports that JSON's duration (a file with a Xing header), and the other
 * ffmpeg passes write their output file (JPEG bytes for a cover, a real FORM for AIFF, else
 * FAKEAUDIO). `respond` overrides a call. Follows run()'s contract for signals.
 */
function fakeEngine(probes: Record<string, string>, respond?: (call: Call) => Reply | undefined) {
  const calls: Call[] = []
  const runFake: typeof run = async (bin, argv, options = {}) => {
    const { signal } = options
    signal?.throwIfAborted()
    const call = { bin, argv, options }
    calls.push(call)
    const reply = respond?.(call) ?? {}
    if (reply.spawnError !== undefined) {
      throw new SpawnError(
        bin,
        Object.assign(new Error('spawn failed'), { code: reply.spawnError }),
      )
    }
    const output = argv.at(-1) ?? ''
    if (reply.hang) {
      await new Promise<void>((resolve) => {
        if (signal === undefined) return
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return result({ exitCode: null, signal: 'SIGINT', aborted: true })
    }
    let stdout = reply.stdout ?? ''
    if (bin === BINS.ffprobe && reply.stdout === undefined) {
      const fixture = probes[path.basename(output)]
      if (fixture === undefined) return result({ exitCode: 1, stderr: `${output}: No such file\n` })
      stdout = await readFile(path.join(FFPROBE_DIR, `${fixture}.json`), 'utf8')
    }
    const measuring = isMeasuring(call)
    if (measuring && reply.stdout === undefined && (reply.exitCode ?? 0) === 0) {
      const fixture = probes[path.basename(argv[argv.indexOf('-i') + 1] ?? '')] ?? fail()
      const json = JSON.parse(await readFile(path.join(FFPROBE_DIR, `${fixture}.json`), 'utf8'))
      stdout = progressReport(Number(json.format.duration))
    }
    if (bin === BINS.ffmpeg && !measuring && reply.write !== false && (reply.exitCode ?? 0) === 0) {
      const format = argv[argv.lastIndexOf('-f') + 1]
      const bytes =
        reply.write ?? (format === 'image2' ? JPEG : format === 'aiff' ? minimalAiff() : FAKE_AUDIO)
      await writeFile(output, bytes, { flag: 'wx' })
    }
    return result({
      exitCode: reply.exitCode ?? 0,
      stdout,
      stderr: reply.stderr ?? '',
      timedOut: reply.timedOut ?? false,
    })
  }
  return { run: runFake, calls }
}

function result(fields: Partial<RunResult>): RunResult {
  return {
    pid: 4242,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...fields,
  }
}

function silentLog(): Logger & { lines: () => string[] } {
  const warn = vi.fn()
  return {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    lines: () => warn.mock.calls.map((args) => args.join(' ')),
  }
}

function valid(url: string): ValidUrl {
  const classified = classifyUrl(url)
  if (!classified.ok) throw new Error(url)
  return classified
}

let root: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scraper-finalize-')))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A job dir holding what yt-dlp left: the download and (optionally) its thumbnail. */
async function jobWith(files: Record<string, Uint8Array>): Promise<string> {
  const jobDir = path.join(root, 'jobs', randomUUID())
  await mkdir(jobDir, { recursive: true, mode: 0o700 })
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(jobDir, name), bytes)
  return jobDir
}

function youtubeDone(jobDir: string, overrides: Partial<DoneInfo> = {}): DoneInfo {
  return {
    id: 'jNQXAC9IVRw',
    filepath: path.join(jobDir, 'jNQXAC9IVRw.webm'),
    ext: 'webm',
    formatId: '251',
    acodec: 'opus',
    abrKbps: 106.064,
    asrHz: 48000,
    durationSec: 19,
    title: 'Me at the zoo',
    uploader: 'jawed',
    channel: 'jawed',
    webpageUrl: YOUTUBE,
    extractorKey: 'Youtube',
    availability: 'public',
    thumbnailPath: path.join(jobDir, 'jNQXAC9IVRw.webp'),
    thumbnailUrl: 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp',
    ...overrides,
  }
}

function input(
  jobDir: string,
  format: DownloadFormat,
  done: DoneInfo,
  overrides: Partial<FinalizeInput> & { url?: string } = {},
): FinalizeInput {
  const { url = YOUTUBE, ...rest } = overrides
  const classified = valid(url)
  return {
    jobDir,
    bins: BINS,
    done,
    input: classified,
    platform: classified.platform,
    format,
    options: { filenameTemplate: '{artist} - {title}', embedArtwork: true, sourceUrlComment: true },
    // What '/Users/dj/Music/DJ Scraper' leaves of 1023 bytes.
    nameMaxBytes: 996,
    signal: new AbortController().signal,
    ...rest,
  }
}

const youtubeFiles = () => ({ 'jNQXAC9IVRw.webm': FAKE_AUDIO, 'jNQXAC9IVRw.webp': WEBP })
/** The ffmpeg passes that write a file: the cover and the audio pass, not the measuring one. */
const ffmpegCalls = (calls: Call[]) =>
  calls.filter((call) => call.bin === BINS.ffmpeg && !isMeasuring(call))
const measureCalls = (calls: Call[]) => calls.filter(isMeasuring)

async function stepError(promise: Promise<unknown>, code: string, message?: string | RegExp) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(StepError)
  expect((error as StepError).code).toBe(code)
  if (message !== undefined) expect((error as StepError).message).toMatch(message)
  expect((error as StepError).message).not.toContain(root)
  return error as StepError
}

describe('createFinalize', () => {
  it('YouTube Opus → MP3 320 with our ID3 tag: title, artist, COMM URL, APIC cover', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.mp3': 'out-mp3-encode',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = await finalize(input(jobDir, 'mp3', youtubeDone(jobDir)))

    const work = path.join(jobDir, FINALIZE_DIR)
    expect(done).toEqual({
      file: path.join(work, 'final.mp3'),
      name: 'jawed - Me at the zoo.mp3',
      output: {
        ext: 'mp3',
        codec: 'mp3',
        bitrateKbps: 320,
        sampleRateHz: 48000,
        channels: 2,
        encoded: true,
      },
      track: {
        title: 'Me at the zoo',
        url: YOUTUBE,
        thumbnailUrl: 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp',
      },
    })

    // probe → cover → audio → probe, each with its timeout, the signal and a 3 s kill grace.
    expect(engine.calls.map((call) => [call.bin, call.argv.at(-1)])).toEqual([
      [BINS.ffprobe, path.join(jobDir, 'jNQXAC9IVRw.webm')],
      [BINS.ffmpeg, path.join(work, 'cover.jpg')],
      [BINS.ffmpeg, path.join(work, 'out.mp3')],
      [BINS.ffprobe, path.join(work, 'out.mp3')],
    ])
    expect(engine.calls.map((call) => call.options.timeoutMs)).toEqual([
      PROBE_TIMEOUT_MS,
      COVER_TIMEOUT_MS,
      audioTimeoutMs(19.021),
      PROBE_TIMEOUT_MS,
    ])
    expect(engine.calls.every((call) => call.options.killGraceMs === 3000)).toBe(true)
    expect(engine.calls.every((call) => call.options.signal !== undefined)).toBe(true)
    expect(engine.calls[1]?.argv).toContain('webp_pipe')
    // MP3: ffmpeg writes no tags (ours follow), the cover isn't mapped into the audio pass.
    const audio = engine.calls[2]?.argv ?? []
    expect(audio).toContain('-id3v2_version')
    expect(audio).not.toContain('-metadata')
    expect(audio).not.toContain(path.join(work, 'cover.jpg'))

    const { tag, audio: frames } = await readMp3Tag(done.file)
    expect(frames).toEqual(FAKE_AUDIO)
    expect(textOf(tag, 'TIT2')).toBe('Me at the zoo')
    expect(textOf(tag, 'TPE1')).toBe('jawed')
    expect(readComment(framesOf(tag, 'COMM')[0] ?? fail())).toMatchObject({
      language: 'eng',
      description: '',
      text: YOUTUBE,
    })
    expect(readPicture(framesOf(tag, 'APIC')[0] ?? fail())).toMatchObject({
      mime: 'image/jpeg',
      type: 3,
      data: JPEG,
    })
    // The source and everything else stay in the job dir.
    expect((await readdir(work)).sort()).toEqual(['cover.jpg', 'final.mp3', 'out.mp3'])
  })

  it('YouTube AAC → M4A: copied, cover and tags by ffmpeg, no ID3 step', async () => {
    const jobDir = await jobWith({ 'jNQXAC9IVRw.m4a': FAKE_AUDIO, 'jNQXAC9IVRw.webp': WEBP })
    const engine = fakeEngine({
      'jNQXAC9IVRw.m4a': 'src-youtube-140-m4a',
      'out.m4a': 'out-m4a-copy',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = await finalize(
      input(
        jobDir,
        'm4a',
        youtubeDone(jobDir, { filepath: path.join(jobDir, 'jNQXAC9IVRw.m4a'), ext: 'm4a' }),
      ),
    )
    expect(done.file).toBe(path.join(jobDir, FINALIZE_DIR, 'out.m4a'))
    expect(done.name).toBe('jawed - Me at the zoo.m4a')
    expect(done.output).toEqual({
      ext: 'm4a',
      codec: 'aac',
      bitrateKbps: 128,
      sampleRateHz: 44100,
      channels: 2,
      encoded: false,
    })
    const audio = ffmpegCalls(engine.calls)[1]?.argv ?? []
    expect(audio).toContain(path.join(jobDir, FINALIZE_DIR, 'cover.jpg'))
    expect(audio).toContain(`comment=${YOUTUBE}`)
    expect(await readFile(done.file)).toEqual(Buffer.from(FAKE_AUDIO))
  })

  it('SoundCloud secret MP3 → MP3: copied, no comment, no placeholder artwork', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO, '123998367.png': JPEG })
    const engine = fakeEngine({ '123998367.mp3': 'src-soundcloud-mp3', 'out.mp3': 'out-mp3-copy' })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done: DoneInfo = {
      id: '123998367',
      filepath: path.join(jobDir, '123998367.mp3'),
      ext: 'mp3',
      acodec: 'mp3',
      abrKbps: 128,
      durationSec: 9.927,
      title: "Youtube - Dl Test Video '' A\u{308}\u{21ad}",
      track: "Youtube - Dl Test Video '' A\u{308}\u{21ad}",
      uploader: 'jaimeMF',
      webpageUrl: SOUNDCLOUD_SECRET,
      extractorKey: 'Soundcloud',
      thumbnailPath: path.join(jobDir, '123998367.png'),
      thumbnailUrl: 'https://a1.sndcdn.com/images/default_avatar_large.png',
    }
    const result = await finalize(input(jobDir, 'mp3', done, { url: SOUNDCLOUD_SECRET }))
    // NFC: A + U+0308 is stored as Ä.
    expect(result.name).toBe("Youtube - Dl Test Video '' \u{c4}\u{21ad}.mp3")
    expect(result.output).toMatchObject({ codec: 'mp3', bitrateKbps: 128, encoded: false })
    expect(result.track).toEqual({
      title: "Dl Test Video '' A\u{308}\u{21ad}",
      artist: 'Youtube',
      url: SOUNDCLOUD_SECRET,
    })
    expect(ffmpegCalls(engine.calls)).toHaveLength(1)
    // An MP3 source is measured first: no -xerror, nothing decoded or written.
    expect(engine.calls.map((call) => [call.bin, isMeasuring(call)])).toEqual([
      [BINS.ffprobe, false],
      [BINS.ffmpeg, true],
      [BINS.ffmpeg, false],
      [BINS.ffprobe, false],
    ])
    expect(measureCalls(engine.calls)[0]?.options.timeoutMs).toBe(MEASURE_TIMEOUT_MS)
    const { tag } = await readMp3Tag(result.file)
    expect(tag.frames.map((frame) => frame.id)).toEqual(['TIT2', 'TPE1'])
    expect(textOf(tag, 'TIT2')).toBe("Dl Test Video '' A\u{308}\u{21ad}")
  })

  it('AIFF: our ID3 chunk appended to ffmpeg’s FORM, the FORM size rewritten', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.aiff': 'out-aiff',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = await finalize(input(jobDir, 'aiff', youtubeDone(jobDir)))
    expect(done.file).toBe(path.join(jobDir, FINALIZE_DIR, 'out.aiff'))
    expect(done.name).toBe('jawed - Me at the zoo.aiff')
    expect(done.output).toEqual({
      ext: 'aiff',
      codec: 'pcm_s16be',
      sampleRateHz: 48000,
      channels: 2,
      encoded: true,
    })
    const audio = ffmpegCalls(engine.calls)[1]?.argv ?? []
    expect(audio).toEqual(expect.arrayContaining(['-write_id3v2', '0']))
    const { tag, chunks } = await readAiffTag(done.file)
    expect(chunks.map((chunk) => chunk.id)).toEqual(['COMM', 'SSND', 'ID3 '])
    expect(textOf(tag, 'TIT2')).toBe('Me at the zoo')
    expect(readComment(framesOf(tag, 'COMM')[0] ?? fail()).text).toBe(YOUTUBE)
    expect(readPicture(framesOf(tag, 'APIC')[0] ?? fail()).data).toEqual(JPEG)
  })

  it.each([
    ['wav', 'out-wav', 'wav', false],
    ['flac', 'out-flac', 'flac', true],
    ['original', 'out-original-webm', 'webm', false],
  ] as const)('%s: one ffmpeg pass with tags (cover: %s)', async (format, fixture, ext, cover) => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      [`out.${ext}`]: fixture,
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = await finalize(input(jobDir, format, youtubeDone(jobDir)))
    expect(done.file).toBe(path.join(jobDir, FINALIZE_DIR, `out.${ext}`))
    expect(done.name).toBe(`jawed - Me at the zoo.${ext}`)
    expect(done.output.ext).toBe(ext)
    expect(ffmpegCalls(engine.calls)).toHaveLength(cover ? 2 : 1)
    expect(ffmpegCalls(engine.calls).at(-1)?.argv).toContain('title=Me at the zoo')
  })

  it('skips the cover pass when artwork is off', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.mp3': 'out-mp3-encode',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const base = input(jobDir, 'mp3', youtubeDone(jobDir))
    const done = await finalize({ ...base, options: { ...base.options, embedArtwork: false } })
    expect(ffmpegCalls(engine.calls)).toHaveLength(1)
    const { tag } = await readMp3Tag(done.file)
    expect(framesOf(tag, 'APIC')).toEqual([])
  })

  it('writes no comment when the user turned it off', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.mp3': 'out-mp3-encode',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const base = input(jobDir, 'mp3', youtubeDone(jobDir))
    const done = await finalize({ ...base, options: { ...base.options, sourceUrlComment: false } })
    const { tag } = await readMp3Tag(done.file)
    expect(framesOf(tag, 'COMM')).toEqual([])
  })

  it('writes into its own folder, so a download named out.mp3 is not overwritten', async () => {
    const jobDir = await jobWith({ 'out.mp3': FAKE_AUDIO })
    // Both files are named out.mp3, so the fake probes both as the same MP3: a copy.
    const engine = fakeEngine({ 'out.mp3': 'src-soundcloud-mp3' })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done: DoneInfo = {
      id: 'out',
      filepath: path.join(jobDir, 'out.mp3'),
      title: 'Direct Link',
      durationSec: 9.9,
    }
    const result = await finalize(
      input(jobDir, 'mp3', done, { url: 'https://example.com/media/out.mp3' }),
    )
    expect(result.file).toBe(path.join(jobDir, FINALIZE_DIR, 'final.mp3'))
    expect(result.name).toBe('Direct Link.mp3')
    expect(await readFile(path.join(jobDir, 'out.mp3'))).toEqual(Buffer.from(FAKE_AUDIO))
  })

  it('falls back to <platform>-<id> when the template renders nothing', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.mp3': 'out-mp3-encode',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = youtubeDone(jobDir, { title: undefined, uploader: undefined, channel: undefined })
    const result = await finalize(input(jobDir, 'mp3', done))
    expect(result.name).toBe('youtube-jNQXAC9IVRw.mp3')
  })

  describe('the cover never fails the job', () => {
    const cases: [string, (jobDir: string) => Partial<DoneInfo>, Reply | undefined, string][] = [
      ['the cover pass fails', () => ({}), { exitCode: 234, stderr: 'boom' }, 'exit_234'],
      ['the cover pass times out', () => ({}), { timedOut: true, write: false }, 'timed_out'],
      ['the cover pass writes no JPEG', () => ({}), { write: FAKE_AUDIO }, 'no_jpeg'],
      ['the cover cannot start', () => ({}), { spawnError: 'EACCES' }, 'postprocess_failed'],
      [
        'the thumbnail is outside the job dir',
        () => ({ thumbnailPath: '/etc/hosts' }),
        undefined,
        'outside',
      ],
      [
        'the thumbnail is missing',
        (jobDir) => ({ thumbnailPath: path.join(jobDir, 'gone.webp') }),
        undefined,
        'outside',
      ],
    ]

    it.each(cases)('when %s', async (_label, doneOverrides, coverReply, reason) => {
      const jobDir = await jobWith(youtubeFiles())
      const engine = fakeEngine(
        { 'jNQXAC9IVRw.webm': 'src-youtube-251-webm', 'out.mp3': 'out-mp3-encode' },
        (call) => (call.argv.at(-1)?.endsWith('cover.jpg') ? coverReply : undefined),
      )
      const log = silentLog()
      const finalize = createFinalize({ run: engine.run, log })
      const done = await finalize(input(jobDir, 'mp3', youtubeDone(jobDir, doneOverrides(jobDir))))
      const { tag } = await readMp3Tag(done.file)
      expect(framesOf(tag, 'APIC')).toEqual([])
      expect(log.lines()).toEqual([
        `finalize ${path.basename(jobDir).slice(0, 8)}: no artwork (${reason})`,
      ])
    })

    it('when the thumbnail is not an image, without trying ffmpeg on it', async () => {
      const html = new TextEncoder().encode('<!doctype html><title>x</title>')
      const jobDir = await jobWith({ 'jNQXAC9IVRw.webm': FAKE_AUDIO, 'jNQXAC9IVRw.webp': html })
      const engine = fakeEngine({
        'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
        'out.mp3': 'out-mp3-encode',
      })
      const log = silentLog()
      await createFinalize({ run: engine.run, log })(input(jobDir, 'mp3', youtubeDone(jobDir)))
      expect(ffmpegCalls(engine.calls)).toHaveLength(1)
      expect(log.lines()[0]).toMatch(/no artwork \(not_an_image\)$/)
    })

    it('when the thumbnail is a symlink out of the job dir', async () => {
      const jobDir = await jobWith({ 'jNQXAC9IVRw.webm': FAKE_AUDIO })
      const outside = path.join(root, 'outside.jpg')
      await writeFile(outside, JPEG)
      await symlink(outside, path.join(jobDir, 'jNQXAC9IVRw.jpg'))
      const engine = fakeEngine({
        'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
        'out.mp3': 'out-mp3-encode',
      })
      const log = silentLog()
      await createFinalize({ run: engine.run, log })(
        input(
          jobDir,
          'mp3',
          youtubeDone(jobDir, { thumbnailPath: path.join(jobDir, 'jNQXAC9IVRw.jpg') }),
        ),
      )
      expect(ffmpegCalls(engine.calls)).toHaveLength(1)
      expect(log.lines()[0]).toMatch(/no artwork \(outside\)$/)
    })

    it('M4A without its cover is not checked for one', async () => {
      const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO, '123998367.jpg': JPEG })
      const engine = fakeEngine(
        { '123998367.mp3': 'src-soundcloud-mp3', 'out.m4a': 'out-m4a-encode' },
        (call) => (call.argv.at(-1)?.endsWith('cover.jpg') ? { exitCode: 1 } : undefined),
      )
      const done: DoneInfo = {
        id: '123998367',
        filepath: path.join(jobDir, '123998367.mp3'),
        durationSec: 9.927,
        title: 'Knocked Up',
        uploader: 'The Royal Concept',
        webpageUrl: SOUNDCLOUD,
        thumbnailPath: path.join(jobDir, '123998367.jpg'),
        thumbnailUrl: 'https://i1.sndcdn.com/artworks-000043574646-iq6flj-original.jpg',
      }
      const finalize = createFinalize({ run: engine.run, log: silentLog() })
      const result = await finalize(input(jobDir, 'm4a', done, { url: SOUNDCLOUD }))
      expect(result.output).toMatchObject({ codec: 'aac', encoded: true })
      expect(ffmpegCalls(engine.calls)).toHaveLength(2)
      expect(ffmpegCalls(engine.calls)[1]?.argv).not.toContain('1:v:0')
      // An MP3 source is decoded without -xerror (ADR-015): mid-stream junk isn't fatal.
      expect(ffmpegCalls(engine.calls)[1]?.argv).not.toContain('-xerror')
      expect(measureCalls(engine.calls)).toHaveLength(1)
    })
  })

  describe('abort', () => {
    const reason = { kind: 'cancel' }

    it('rejects at once, spawning nothing, when already aborted', async () => {
      const jobDir = await jobWith(youtubeFiles())
      const engine = fakeEngine({})
      const controller = new AbortController()
      controller.abort(reason)
      const finalize = createFinalize({ run: engine.run, log: silentLog() })
      await expect(
        finalize(input(jobDir, 'mp3', youtubeDone(jobDir), { signal: controller.signal })),
      ).rejects.toBe(reason)
      expect(engine.calls).toEqual([])
    })

    it.each([
      ['the probe', (call: Call) => call.bin === BINS.ffprobe],
      ['the cover pass', (call: Call) => call.argv.at(-1)?.endsWith('cover.jpg') === true],
      [
        'the audio pass',
        (call: Call) => call.argv.at(-1)?.endsWith('out.mp3') === true && call.bin === BINS.ffmpeg,
      ],
    ])(
      'rejects with the reason during %s (never swallowed as a cover failure)',
      async (_label, hangs) => {
        const jobDir = await jobWith(youtubeFiles())
        const controller = new AbortController()
        const engine = fakeEngine(
          { 'jNQXAC9IVRw.webm': 'src-youtube-251-webm', 'out.mp3': 'out-mp3-encode' },
          (call) => {
            if (!hangs(call)) return undefined
            setTimeout(() => controller.abort(reason), 5)
            return { hang: true }
          },
        )
        const log = silentLog()
        const finalize = createFinalize({ run: engine.run, log })
        await expect(
          finalize(input(jobDir, 'mp3', youtubeDone(jobDir), { signal: controller.signal })),
        ).rejects.toBe(reason)
        expect(log.lines()).toEqual([])
        // Nothing runs after the abort.
        expect(hangs(engine.calls.at(-1) ?? fail())).toBe(true)
      },
    )

    it('rejects with the reason when the abort comes during the tag write', async () => {
      const jobDir = await jobWith(youtubeFiles())
      const controller = new AbortController()
      const engine = fakeEngine({
        'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
        'out.mp3': 'out-mp3-encode',
      })
      const finalize = createFinalize({
        run: engine.run,
        log: silentLog(),
        fs: {
          writeWithHead: async () => {
            controller.abort(reason)
            throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          },
        },
      })
      await expect(
        finalize(input(jobDir, 'mp3', youtubeDone(jobDir), { signal: controller.signal })),
      ).rejects.toBe(reason)
    })
  })

  describe('failures', () => {
    const run = (
      format: DownloadFormat,
      probes: Record<string, string>,
      respond?: (call: Call) => Reply | undefined,
      doneOverrides: Partial<DoneInfo> = {},
      fs: Partial<FinalizeFs> = {},
    ) =>
      jobWith(youtubeFiles()).then((jobDir) => {
        const engine = fakeEngine(probes, respond)
        const finalize = createFinalize({ run: engine.run, log: silentLog(), fs })
        return finalize(input(jobDir, format, youtubeDone(jobDir, doneOverrides)))
      })
    const webmOnly = { 'jNQXAC9IVRw.webm': 'src-youtube-251-webm' }
    const webmAndMp3 = { ...webmOnly, 'out.mp3': 'out-mp3-encode' }

    it('a download ffprobe cannot read', async () => {
      await stepError(
        run('mp3', webmOnly, (call) =>
          call.bin === BINS.ffprobe
            ? {
                exitCode: 1,
                stderr:
                  '[in#0 @ 0x1] Error opening input: Invalid data found when processing input\n',
              }
            : undefined,
        ),
        'postprocess_failed',
        "The downloaded file can't be read: Error opening input: Invalid data found when processing input",
      )
    })

    it('ffprobe without JSON', async () => {
      await stepError(
        run('mp3', webmOnly, (call) =>
          call.bin === BINS.ffprobe ? { stdout: 'nope' } : undefined,
        ),
        'postprocess_failed',
        "The downloaded file can't be read: ffprobe gave no answer.",
      )
    })

    it('a download shorter than yt-dlp said is a network failure', async () => {
      await stepError(
        run('mp3', webmAndMp3, undefined, { durationSec: 60 }),
        'network',
        'The download is incomplete. Try again.',
      )
    })

    it('ffmpeg failing, its text without the job dir', async () => {
      const error = await stepError(
        run('mp3', webmAndMp3, (call) =>
          call.bin === BINS.ffmpeg && call.argv.at(-1)?.endsWith('out.mp3')
            ? {
                exitCode: 234,
                stderr: `[out#0/mp3 @ 0x6000] Error opening output ${call.argv.at(-1)}: Permission denied\n[opus @ 0x1] Error parsing Opus packet header.\n`,
              }
            : undefined,
        ),
        'postprocess_failed',
        /^Converting the audio failed: Error opening output …\/finalize\/out\.mp3: Permission denied$/,
      )
      expect(error.message).not.toContain('jobs/')
    })

    it('ffmpeg taking too long', async () => {
      await stepError(
        run('mp3', webmAndMp3, (call) =>
          call.bin === BINS.ffmpeg && call.argv.at(-1)?.endsWith('out.mp3')
            ? { timedOut: true, exitCode: 255, write: false }
            : undefined,
        ),
        'postprocess_failed',
        'Converting the audio took too long.',
      )
    })

    it('ffmpeg exiting 0 with a truncated output (verification)', async () => {
      await stepError(
        run('mp3', { ...webmOnly, 'out.mp3': 'out-mp3-encode-truncated' }),
        'postprocess_failed',
        'The converted file is incomplete: the download may be damaged. Try again.',
      )
    })

    it('ffmpeg missing at its located path: postprocess_failed, never engine_missing', async () => {
      await stepError(
        run('mp3', webmAndMp3, (call) =>
          call.bin === BINS.ffmpeg ? { spawnError: 'ENOENT' } : undefined,
        ),
        'postprocess_failed',
        "ffmpeg couldn't be started (ENOENT). Reinstall ffmpeg (brew reinstall ffmpeg), then retry.",
      )
    })

    it("an original yt-dlp's codec can't be kept in", async () => {
      await stepError(
        run('original', webmOnly, (call) =>
          call.bin === BINS.ffprobe
            ? {
                stdout: JSON.stringify({
                  streams: [{ index: 0, codec_type: 'audio', codec_name: 'alac' }],
                  format: { format_name: 'mov,mp4,m4a', duration: '19.0' },
                }),
              }
            : undefined,
        ),
        'postprocess_failed',
        /^DJ Scraper can't keep this audio \(alac\) as the original/,
      )
    })

    it.each([
      ['outside the job dir', () => ({ filepath: '/etc/hosts' })],
      ['relative', () => ({ filepath: 'jNQXAC9IVRw.webm' })],
      ['missing', () => ({ filepath: '/nonexistent/x.webm' })],
    ])('a DONE file path %s', async (_label, overrides) => {
      await stepError(
        run('mp3', webmAndMp3, undefined, overrides()),
        'unknown',
        "yt-dlp reported a file that isn't in the download's folder.",
      )
    })

    it('a DONE file path that is a directory or a symlink out of the job dir', async () => {
      const jobDir = await jobWith({})
      await mkdir(path.join(jobDir, 'dir.webm'))
      const outside = path.join(root, `outside-${randomUUID()}.webm`)
      await writeFile(outside, FAKE_AUDIO)
      await symlink(outside, path.join(jobDir, 'link.webm'))
      const finalize = createFinalize({ run: fakeEngine({}).run, log: silentLog() })
      for (const name of ['dir.webm', 'link.webm']) {
        await stepError(
          finalize(
            input(jobDir, 'mp3', youtubeDone(jobDir, { filepath: path.join(jobDir, name) })),
          ),
          'unknown',
        )
      }
    })

    it('a full disk while writing the tagged MP3', async () => {
      await stepError(
        run(
          'mp3',
          webmAndMp3,
          undefined,
          {},
          {
            writeWithHead: () => Promise.reject(Object.assign(new Error('/x'), { code: 'ENOSPC' })),
          },
        ),
        'disk_full',
        "The drive with DJ Scraper's data is full.",
      )
    })

    it('a malformed AIFF from ffmpeg', async () => {
      await stepError(
        run('aiff', { ...webmOnly, 'out.aiff': 'out-aiff' }, (call) =>
          call.bin === BINS.ffmpeg && call.argv.at(-1)?.endsWith('out.aiff')
            ? { write: FAKE_AUDIO }
            : undefined,
        ),
        'postprocess_failed',
        "ffmpeg's AIFF file is malformed.",
      )
    })

    it('a work folder that already exists (finalize must start clean)', async () => {
      const jobDir = await jobWith(youtubeFiles())
      await mkdir(path.join(jobDir, FINALIZE_DIR))
      const finalize = createFinalize({ run: fakeEngine(webmAndMp3).run, log: silentLog() })
      await stepError(
        finalize(input(jobDir, 'mp3', youtubeDone(jobDir))),
        'unknown',
        'Preparing the file failed (EEXIST).',
      )
    })

    it('a job dir that is gone', async () => {
      const finalize = createFinalize({ run: fakeEngine({}).run, log: silentLog() })
      const jobDir = path.join(root, 'jobs', randomUUID())
      await stepError(
        finalize(input(jobDir, 'mp3', youtubeDone(jobDir))),
        'unknown',
        "The download's work folder is gone (ENOENT).",
      )
    })
  })
})

describe('an MP3 whose duration ffprobe estimated (no Xing header)', () => {
  const SECRET_DONE = (jobDir: string, overrides: Partial<DoneInfo> = {}): DoneInfo => ({
    id: '123998367',
    filepath: path.join(jobDir, '123998367.mp3'),
    ext: 'mp3',
    durationSec: 600,
    title: 'Mix',
    uploader: 'jaimeMF',
    ...overrides,
  })
  /** The recorded src-mp3-vbr-noxing (probed as 2,413.4 s) whose real length is 600.03 s. */
  const vbr = (respond?: (call: Call) => Reply | undefined) =>
    fakeEngine({ '123998367.mp3': 'src-mp3-vbr-noxing', 'out.m4a': 'out-m4a-encode' }, (call) => {
      const custom = respond?.(call)
      if (custom !== undefined) return custom
      if (isMeasuring(call)) return { stdout: progressReport(600.032653) }
      // ffmpeg writes a Xing header (or a container's own length): the output probes exactly.
      if (call.bin === BINS.ffprobe && call.argv.at(-1)?.endsWith('out.m4a')) {
        return { stdout: probeJson('out-m4a-encode', 600.0464) }
      }
      return undefined
    })
  const start = (jobDir: string, engine: ReturnType<typeof fakeEngine>, done: DoneInfo) =>
    createFinalize({ run: engine.run, log: silentLog() })(
      input(jobDir, 'm4a', done, { url: SOUNDCLOUD }),
    )

  it('converts it, checking every duration against the measured one', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    const engine = vbr()
    const result = await start(jobDir, engine, SECRET_DONE(jobDir))
    expect(result.output).toMatchObject({ codec: 'aac', encoded: true })
    expect(measureCalls(engine.calls)).toHaveLength(1)
    // The audio pass's timeout follows the real length, not the 2,413 s estimate.
    expect(ffmpegCalls(engine.calls)[0]?.options.timeoutMs).toBe(audioTimeoutMs(600.032653))
  })

  it('converts it without a reported duration (the output against the measured length)', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    const done = SECRET_DONE(jobDir)
    delete done.durationSec
    const result = await start(jobDir, vbr(), done)
    expect(result.output).toMatchObject({ codec: 'aac' })
  })

  it('still catches a truncated CBR MP3 (a lost HLS fragment): the measured length is short', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    const engine = vbr((call) => (isMeasuring(call) ? { stdout: progressReport(300) } : undefined))
    await stepError(
      start(jobDir, engine, SECRET_DONE(jobDir)),
      'network',
      'The download is incomplete. Try again.',
    )
    expect(ffmpegCalls(engine.calls)).toEqual([])
  })

  it('sizes WAV against the measured length: an estimate past 4 GiB is no reason to refuse', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    const engine = fakeEngine(
      { '123998367.mp3': 'src-mp3-vbr-noxing', 'out.wav': 'out-wav' },
      (call) => {
        if (isMeasuring(call)) return { stdout: progressReport(19.005542) }
        // 30,000 s at 44.1 kHz stereo would be 5.3 GB of PCM.
        if (call.bin === BINS.ffprobe && call.argv.at(-1)?.endsWith('123998367.mp3')) {
          return { stdout: probeJson('src-mp3-vbr-noxing', 30_000) }
        }
        return undefined
      },
    )
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = SECRET_DONE(jobDir, { durationSec: 19 })
    const result = await finalize(input(jobDir, 'wav', done, { url: SOUNDCLOUD }))
    expect(result.output).toMatchObject({ codec: 'pcm_s16le' })
  })

  it('fails like an unreadable download when measuring fails, and in time', async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    await stepError(
      start(
        jobDir,
        vbr((call) =>
          isMeasuring(call)
            ? {
                exitCode: 183,
                stderr:
                  '[in#0 @ 0x1] Error opening input: Invalid data found when processing input\n',
              }
            : undefined,
        ),
        SECRET_DONE(jobDir),
      ),
      'postprocess_failed',
      "The downloaded file can't be read: Error opening input: Invalid data found when processing input",
    )
    const again = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    await stepError(
      start(
        again,
        vbr((call) => (isMeasuring(call) ? { timedOut: true, exitCode: 255 } : undefined)),
        SECRET_DONE(again),
      ),
      'postprocess_failed',
      "The downloaded file couldn't be read in time.",
    )
  })

  it("keeps ffprobe's duration, and says so, when the report has none", async () => {
    const jobDir = await jobWith({ '123998367.mp3': FAKE_AUDIO })
    const engine = fakeEngine(
      { '123998367.mp3': 'src-soundcloud-mp3', 'out.m4a': 'out-m4a-encode' },
      (call) => (isMeasuring(call) ? { stdout: 'progress=continue\n' } : undefined),
    )
    const log = silentLog()
    const finalize = createFinalize({ run: engine.run, log })
    const done = SECRET_DONE(jobDir, { durationSec: 9.927 })
    await finalize(input(jobDir, 'm4a', done, { url: SOUNDCLOUD }))
    expect(log.lines()).toEqual([
      `finalize ${path.basename(jobDir).slice(0, 8)}: no measured duration, keeping ffprobe's`,
    ])
  })
})

describe('createFinalize: what ffmpeg says', () => {
  it('a full data drive during the audio pass is disk_full (recorded ffmpeg 8 stderr)', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({ 'jNQXAC9IVRw.webm': 'src-youtube-251-webm' }, (call) =>
      call.bin === BINS.ffmpeg && call.argv.at(-1)?.endsWith('out.wav')
        ? { exitCode: 228, stderr: DISK_FULL_WAV, write: false }
        : undefined,
    )
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    await stepError(
      finalize(input(jobDir, 'wav', youtubeDone(jobDir))),
      'disk_full',
      "The drive with DJ Scraper's data is full.",
    )
  })

  it("quotes the line that says why, without ffmpeg 8's nested [name @ 0x…] prefixes", async () => {
    const jobDir = await jobWith(youtubeFiles())
    const stderr = [
      '[aist#0:0/opus @ 0x73cc40300] [dec:opus @ 0x73d0383c0] Error submitting packet to decoder: Invalid data found when processing input',
      '[aist#0:0/opus @ 0x73cc40300] [dec:opus @ 0x73d0383c0] Task finished with error code: -1094995529 (Invalid data found when processing input)',
      '[aist#0:0/opus @ 0x73cc40300] [dec:opus @ 0x73d0383c0] Terminating thread with return code -1094995529 (Invalid data found when processing input)',
      '',
    ].join('\n')
    const engine = fakeEngine({ 'jNQXAC9IVRw.webm': 'src-youtube-251-webm' }, (call) =>
      call.bin === BINS.ffmpeg && call.argv.at(-1)?.endsWith('out.m4a')
        ? { exitCode: 183, stderr, write: false }
        : undefined,
    )
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const error = await stepError(
      finalize(input(jobDir, 'm4a', youtubeDone(jobDir))),
      'postprocess_failed',
      'Converting the audio failed: Error submitting packet to decoder: Invalid data found when processing input',
    )
    expect(error.message).not.toContain('0x')
  })
})

describe('createFinalize: the name fits the folder', () => {
  it('cuts a CJK title to the bytes the folder path leaves', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.mp3': 'out-mp3-encode',
    })
    const finalize = createFinalize({ run: engine.run, log: silentLog() })
    const done = youtubeDone(jobDir, { title: `東京 - ${'夜'.repeat(200)}` })
    // A 603-byte folder leaves 419 bytes; 180 units of CJK would be 526.
    const result = await finalize(input(jobDir, 'mp3', done, { nameMaxBytes: 419 }))
    expect(Buffer.byteLength(result.name)).toBeLessThanOrEqual(419)
    expect(result.name).toBe(`東京 - ${'夜'.repeat(135)}.mp3`)
  })
})

describe('audioTimeoutMs', () => {
  it('is 60 s plus twice the duration, an hour when unknown, within setTimeout', () => {
    expect(audioTimeoutMs(19)).toBe(98_000)
    expect(audioTimeoutMs(undefined)).toBe(60_000 + 7_200_000)
    expect(audioTimeoutMs(0)).toBe(60_000 + 7_200_000)
    expect(audioTimeoutMs(10 ** 9)).toBe(2 ** 31 - 1)
  })
})

describe('the AIFF chunk on a real FORM', () => {
  it('keeps the file a valid AIFF', async () => {
    const jobDir = await jobWith(youtubeFiles())
    const engine = fakeEngine({
      'jNQXAC9IVRw.webm': 'src-youtube-251-webm',
      'out.aiff': 'out-aiff',
    })
    const done = await createFinalize({ run: engine.run, log: silentLog() })(
      input(jobDir, 'aiff', youtubeDone(jobDir)),
    )
    const bytes = new Uint8Array(await readFile(done.file))
    expect(() => readAiff(bytes)).not.toThrow()
    expect(bytes.length % 2).toBe(0)
  })
})

function fail(): never {
  throw new Error('missing')
}

/** A recorded ffprobe JSON with another duration. */
function probeJson(fixture: string, durationSec: number): string {
  const json = JSON.parse(readFileSync(path.join(FFPROBE_DIR, `${fixture}.json`), 'utf8'))
  json.format.duration = durationSec.toFixed(6)
  return JSON.stringify(json)
}

/** ffmpeg 8.0's stderr (recorded 2026-10-03), the WAV pass onto a full 2 MB HFS+ image: exit 228. */
const DISK_FULL_WAV = [
  '[aost#0:0/pcm_s16le @ 0x9a5094000] Error submitting a packet to the muxer: No space left on device',
  '    Last message repeated 1 times',
  '[out#0/wav @ 0x9a508c180] Error muxing a packet',
  '[out#0/wav @ 0x9a508c180] Task finished with error code: -28 (No space left on device)',
  '[out#0/wav @ 0x9a508c180] Terminating thread with return code -28 (No space left on device)',
  '[out#0/wav @ 0x9a508c180] Error writing trailer: No space left on device',
  '[out#0/wav @ 0x9a508c180] Error closing file: No space left on device',
  '',
].join('\n')
