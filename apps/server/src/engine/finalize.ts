import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { classifyUrl, type ErrorCode, HttpUrlSchema, MAX_URL_LENGTH } from '@dj-scraper/shared'
import { insideFolder } from '../fs/folders.ts'
import {
  type Finalize,
  type FinalizeInput,
  type FinalizeResult,
  type FinalTrack,
  StepError,
} from '../jobs/types.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { errnoCode, failureName } from '../util/errno.ts'
import {
  audioArgs,
  coverArgs,
  describeTrack,
  downloadProblem,
  ffmpegDiskFull,
  ffmpegErrorText,
  ffprobeArgs,
  finalFileName,
  isPlaceholderThumbnail,
  measureArgs,
  needsMeasuredDuration,
  outputInfo,
  outputProblem,
  type Probe,
  parseMeasuredDuration,
  parseProbe,
  planAudio,
  sniffImage,
} from './finalize-plan.ts'
import { aiffFormSizeBytes, aiffId3Chunk, type Id3Cover, id3v23Tag, readAiffHeader } from './id3.ts'
import { type RunResult, run, SpawnError } from './run.ts'
import { DATA_DISK_FULL } from './ytdlp-errors.ts'

/**
 * Finalize (design D1-D3, D14, D15): the file yt-dlp downloaded → a tagged file in the target
 * format, ready to publish. probe the download (and measure an MP3's real duration) → (optional)
 * cover pass → audio pass → probe the output and verify it → our ID3 tag for MP3/AIFF. Every
 * decision is in finalize-plan.ts; this module runs ffprobe/ffmpeg (through run.ts, with timeouts)
 * and moves bytes.
 *
 * Everything it writes is in `<jobDir>/finalize/`: fixed names there (`out.<ext>`, `cover.jpg`,
 * `final.mp3`) can't meet a yt-dlp file (`<id>.<ext>`, e.g. a direct link named `out.mp3`).
 * Errors are StepErrors (postprocess_failed, network for an incomplete download, disk_full for a
 * full data drive, also when ffmpeg says so);
 * an abort rejects with the signal's reason, also during the cover pass.
 */

export const PROBE_TIMEOUT_MS = 30_000
export const COVER_TIMEOUT_MS = 30_000
/** Measuring copies packets at ~150 MB/s: a 2 GB file (yt-dlp's cap) takes ~15 s. */
export const MEASURE_TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 3000
/** The work folder inside the job dir. */
export const FINALIZE_DIR = 'finalize'
/** The audio pass's duration when nothing reports one: an hour. */
const UNKNOWN_DURATION_SEC = 3600
/** An APIC frame this large means something went wrong; our covers are ~50-250 KB. */
const MAX_COVER_BYTES = 16 * 1024 * 1024
/** setTimeout's limit. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** 60 s plus twice the track's length (an MP3 encode runs at ~150× real time). */
export function audioTimeoutMs(durationSec: number | undefined): number {
  const seconds = durationSec !== undefined && durationSec > 0 ? durationSec : UNKNOWN_DURATION_SEC
  return Math.min(60_000 + 2 * seconds * 1000, MAX_TIMEOUT_MS)
}

/** The filesystem work finalize does; tests replace some to script failures. */
export type FinalizeFs = {
  /** realpath(3). */
  realpath: (path: string) => Promise<string>
  lstat: (path: string) => Promise<{ isFile(): boolean }>
  mkdir: (path: string, options: { mode: number }) => Promise<unknown>
  /** The first `length` bytes, fewer when the file is shorter. */
  readHead: (path: string, length: number) => Promise<Uint8Array>
  readFile: (path: string) => Promise<Uint8Array>
  /** Writes `head`, then the bytes of `src`, into the new file `dest` (EEXIST if it exists). */
  writeWithHead: (dest: string, head: Uint8Array, src: string, signal: AbortSignal) => Promise<void>
  /** Appends `chunk` to the AIFF `file` and rewrites its FORM size, in place. */
  appendAiffChunk: (file: string, chunk: Uint8Array) => Promise<void>
}

export type FinalizeDeps = {
  /** engine/run.ts by default. */
  run?: typeof run
  fs?: Partial<FinalizeFs>
  log?: Logger
}

const DEFAULT_FS: FinalizeFs = {
  realpath,
  lstat,
  mkdir: (dir, options) => mkdir(dir, options),
  readHead,
  readFile: async (file) => new Uint8Array(await readFile(file)),
  writeWithHead,
  appendAiffChunk,
}

export function createFinalize(deps: FinalizeDeps = {}): Finalize {
  const runProcess = deps.run ?? run
  const fs: FinalizeFs = { ...DEFAULT_FS, ...deps.fs }
  const log = deps.log ?? console
  return (input) => finalize(input, { runProcess, fs, log })
}

type Context = { runProcess: typeof run; fs: FinalizeFs; log: Logger }

async function finalize(input: FinalizeInput, context: Context): Promise<FinalizeResult> {
  const { runProcess, fs, log } = context
  const { bins, done, format, options, platform, signal } = input
  signal.throwIfAborted()

  /** Settles `promise`; an abort wins over its outcome, other failures become `onError`'s. */
  const step = async <T>(promise: Promise<T>, onError: (error: unknown) => StepError) => {
    let value: T
    try {
      value = await promise
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw onError(error)
    }
    signal.throwIfAborted()
    return value
  }

  const tool = async (name: string, bin: string, argv: string[], timeoutMs: number) => {
    let result: RunResult
    try {
      result = await runProcess(bin, argv, { signal, timeoutMs, killGraceMs: KILL_GRACE_MS })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof SpawnError) {
        throw new StepError(
          'postprocess_failed',
          `${name} couldn't be started (${error.code}). Reinstall ffmpeg (brew reinstall ffmpeg), then retry.`,
        )
      }
      throw error
    }
    if (result.aborted || signal.aborted) throw signal.reason
    return result
  }

  const jobDir = await step(fs.realpath(input.jobDir), (error) =>
    fileError(error, "The download's work folder is gone"),
  )
  const attempt = path.basename(jobDir).slice(0, 8)

  const probe = async (file: string, what: string): Promise<Probe> => {
    const result = await tool('ffprobe', bins.ffprobe, ffprobeArgs(file), PROBE_TIMEOUT_MS)
    if (result.timedOut) {
      throw new StepError('postprocess_failed', `${what} couldn't be read in time.`)
    }
    if (result.exitCode !== 0) {
      const reason = ffmpegErrorText(result.stderr, jobDir) ?? `ffprobe exit ${result.exitCode}`
      throw new StepError('postprocess_failed', `${what} can't be read: ${reason}`)
    }
    const parsed = parseProbe(result.stdout)
    if (parsed === undefined) {
      throw new StepError('postprocess_failed', `${what} can't be read: ffprobe gave no answer.`)
    }
    return parsed
  }

  const source = await jobFile(fs, jobDir, done.filepath)
  if (source === undefined) {
    throw new StepError('unknown', "yt-dlp reported a file that isn't in the download's folder.")
  }
  const workDir = path.join(jobDir, FINALIZE_DIR)
  await step(fs.mkdir(workDir, { mode: 0o700 }), (error) =>
    fileError(error, 'Preparing the file failed'),
  )

  /** An MP3's real duration: ffprobe may have estimated it from the first frame's bitrate. */
  const measured = async (probed: Probe): Promise<Probe> => {
    const result = await tool('ffmpeg', bins.ffmpeg, measureArgs(source), MEASURE_TIMEOUT_MS)
    if (result.timedOut) {
      throw new StepError('postprocess_failed', "The downloaded file couldn't be read in time.")
    }
    if (result.exitCode !== 0) {
      const reason = ffmpegErrorText(result.stderr, jobDir) ?? `ffmpeg exit ${result.exitCode}`
      throw new StepError('postprocess_failed', `The downloaded file can't be read: ${reason}`)
    }
    const durationSec = parseMeasuredDuration(result.stdout)
    if (durationSec !== undefined) return { ...probed, durationSec }
    log.warn(`finalize ${attempt}: no measured duration, keeping ffprobe's`)
    return probed
  }

  // 1. What was downloaded, and what to make of it. Every duration check, the WAV/AIFF size guard
  // and the audio pass's timeout use the measured duration of an MP3.
  const probed = await probe(source, 'The downloaded file')
  const sourceProbe = needsMeasuredDuration(probed) ? await measured(probed) : probed
  const incomplete = downloadProblem(sourceProbe, done.durationSec)
  if (incomplete !== undefined) throw new StepError('network', incomplete)
  const plan = planAudio(format, sourceProbe)
  const text = describeTrack(done, {
    platform,
    input: input.input,
    sourceUrlComment: options.sourceUrlComment,
  })

  // 2. The cover: a failure only costs the artwork, but an abort is still an abort.
  const noArtwork = (reason: string): undefined => {
    log.warn(`finalize ${attempt}: no artwork (${reason})`)
    return undefined
  }
  const makeCover = async (): Promise<string | undefined> => {
    if (done.thumbnailPath === undefined || isPlaceholderThumbnail(done.thumbnailUrl)) {
      return undefined
    }
    try {
      const thumbnail = await jobFile(fs, jobDir, done.thumbnailPath)
      if (thumbnail === undefined) return noArtwork('outside')
      const demuxer = sniffImage(await step(fs.readHead(thumbnail, 12), fsFailure))
      if (demuxer === undefined) return noArtwork('not_an_image')
      const cover = path.join(workDir, 'cover.jpg')
      const result = await tool(
        'ffmpeg',
        bins.ffmpeg,
        coverArgs(thumbnail, demuxer, cover),
        COVER_TIMEOUT_MS,
      )
      if (result.timedOut) return noArtwork('timed_out')
      if (result.exitCode !== 0) return noArtwork(`exit_${result.exitCode}`)
      if (sniffImage(await step(fs.readHead(cover, 12), fsFailure)) !== 'jpeg_pipe') {
        return noArtwork('no_jpeg')
      }
      return cover
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return noArtwork(failureName(error))
    }
  }
  const cover = options.embedArtwork && plan.cover !== 'none' ? await makeCover() : undefined

  // 3. The audio pass.
  const out = path.join(workDir, `out.${plan.ext}`)
  const durationSec = sourceProbe.durationSec ?? done.durationSec
  const result = await tool(
    'ffmpeg',
    bins.ffmpeg,
    audioArgs({ plan, input: source, cover, output: out, tags: text.tags }),
    audioTimeoutMs(durationSec),
  )
  if (result.timedOut) {
    throw new StepError('postprocess_failed', 'Converting the audio took too long.')
  }
  if (result.exitCode !== 0) {
    if (ffmpegDiskFull(result.stderr, jobDir)) throw new StepError('disk_full', DATA_DISK_FULL)
    const reason = ffmpegErrorText(result.stderr, jobDir) ?? `ffmpeg exit ${result.exitCode}`
    throw new StepError('postprocess_failed', `Converting the audio failed: ${reason}`)
  }

  // 4. ffmpeg exits 0 on truncated input and existing outputs: read the result back.
  const outputProbe = await probe(out, 'The converted file')
  const problem = outputProblem(plan, {
    source: sourceProbe,
    output: outputProbe,
    tags: text.tags,
    coverPlanned: cover !== undefined,
  })
  if (problem !== undefined) throw new StepError('postprocess_failed', problem)

  // 5. MP3 and AIFF: our ID3v2.3 tag (ffmpeg can't write COMM).
  let file = out
  if (plan.tags === 'id3') {
    const picture = cover === undefined ? undefined : await readCover(cover)
    const tag = id3v23Tag(text.tags, picture)
    if (plan.muxer === 'aiff') {
      await step(fs.appendAiffChunk(out, aiffId3Chunk(tag)), tagWriteError)
    } else {
      file = path.join(workDir, `final.${plan.ext}`)
      await step(fs.writeWithHead(file, tag, out, signal), tagWriteError)
    }
  }

  return {
    file,
    name: finalFileName(
      options.filenameTemplate,
      text.fields,
      plan.ext,
      { platform, id: done.id },
      input.nameMaxBytes,
    ),
    output: outputInfo(plan, outputProbe),
    track: finalTrack(text.display, done),
  }

  async function readCover(cover: string): Promise<Id3Cover | undefined> {
    try {
      const data = await step(fs.readFile(cover), fsFailure)
      if (data.length > MAX_COVER_BYTES) return noArtwork('too_large')
      return { mime: 'image/jpeg', data }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return noArtwork(failureName(error))
    }
  }
}

/**
 * A path yt-dlp printed, if it is a regular file inside the job dir (after resolving symlinks);
 * else undefined.
 */
async function jobFile(
  fs: FinalizeFs,
  jobDir: string,
  reported: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(reported)) return undefined
  const real = await fs.realpath(reported).catch(() => undefined)
  if (real === undefined || real === jobDir || !insideFolder(jobDir, real)) return undefined
  const stats = await fs.lstat(real).catch(() => undefined)
  return stats?.isFile() === true ? real : undefined
}

/** What the job shows once it is done: the names, the page, and artwork that exists. */
function finalTrack(display: { title?: string; artist?: string }, done: FinalizeInput['done']) {
  const track: FinalTrack = { ...display }
  if (done.webpageUrl !== undefined) {
    const page = classifyUrl(done.webpageUrl)
    if (page.ok && page.kind !== 'out_of_scope') track.url = page.url
  }
  // Only artwork yt-dlp actually fetched: a never-fetched candidate URL may not exist.
  if (done.thumbnailPath !== undefined && !isPlaceholderThumbnail(done.thumbnailUrl)) {
    const thumbnail = HttpUrlSchema.max(MAX_URL_LENGTH).safeParse(done.thumbnailUrl)
    if (thumbnail.success) track.thumbnailUrl = thumbnail.data
  }
  return track
}

const fsFailure = (error: unknown): StepError => fileError(error, 'Reading a file failed')

/** The job dir is in the data dir: a full disk there is disk_full, the rest `unknown`. */
function fileError(error: unknown, what: string, code: ErrorCode = 'unknown'): StepError {
  if (error instanceof StepError) return error
  const errno = errnoCode(error)
  if (errno === 'ENOSPC' || errno === 'EDQUOT') return new StepError('disk_full', DATA_DISK_FULL)
  return new StepError(code, `${what} (${errno ?? 'error'}).`)
}

function tagWriteError(error: unknown): StepError {
  if (error instanceof RangeError) {
    return new StepError('postprocess_failed', 'This track is too long for AIFF (4 GB at most).')
  }
  return fileError(error, 'Writing the tags failed', 'postprocess_failed')
}

async function readHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function writeWithHead(
  dest: string,
  head: Uint8Array,
  src: string,
  signal: AbortSignal,
): Promise<void> {
  await pipeline(
    async function* () {
      yield head
      yield* createReadStream(src)
    },
    createWriteStream(dest, { flags: 'wx' }),
    { signal },
  )
}

/**
 * Appends the chunk after the last one and rewrites the FORM size (D2). ffmpeg's file must be
 * exactly one FORM of even length, or the chunk would land in the wrong place.
 */
async function appendAiffChunk(file: string, chunk: Uint8Array): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    const { size } = await handle.stat()
    const head = new Uint8Array(12)
    await handle.read(head, 0, 12, 0)
    const header = readAiffHeader(head)
    if (header === undefined || header.formSize !== size - 8 || size % 2 !== 0) {
      throw new StepError('postprocess_failed', "ffmpeg's AIFF file is malformed.")
    }
    const formSize = aiffFormSizeBytes(size + chunk.length)
    await handle.write(chunk, 0, chunk.length, size)
    await handle.write(formSize, 0, formSize.length, 4)
  } finally {
    await handle.close()
  }
}
