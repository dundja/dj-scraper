import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AudioSource, ErrorInfo, ValidUrl } from '@dj-scraper/shared'
import { JOBS_DIR } from '../data-dir.ts'
import { spawnFailure } from '../engine/binaries.ts'
import { canHoldCover } from '../engine/finalize-plan.ts'
import { type RunResult, run, SpawnError } from '../engine/run.ts'
import { downloadArgs } from '../engine/ytdlp-args.ts'
import { DATA_DISK_FULL, mapDownloadExit } from '../engine/ytdlp-errors.ts'
import { parseDownloadLine, waitingUntil } from '../engine/ytdlp-progress.ts'
import { checkUrl } from '../resolve/input.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { failureName } from '../util/errno.ts'
import {
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptUpdate,
  type DoneInfo,
  type EngineBins,
  type Finalize,
  type Publish,
  type RunAttempt,
  type StartInfo,
  StepError,
} from './types.ts'

/**
 * One attempt of one job (Phase 2 design §5, D5, D6): a job dir of its own, yt-dlp downloading
 * the stream into it, then finalize (convert, tag, cover) and publish (into the user's folder,
 * never overwriting). It reports progress as it goes and settles once, with an outcome: never a
 * rejection for anything it expects. The job dir is removed at the end, whatever happened, once
 * every process it started is gone.
 */

/** SIGINT, then SIGKILL after this long: well inside the shutdown deadline (8 s). */
export const KILL_GRACE_MS = 3000
/** Only stderr's tail matters (ERROR lines come last); the lines are read as they arrive. */
const MAX_OUTPUT_BYTES = 1024 * 1024
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const LIST_URL: ErrorInfo = {
  code: 'invalid_request',
  message: 'This link is a list: open it to pick tracks.',
}
export const NO_FILE: ErrorInfo = {
  code: 'unknown',
  message: 'yt-dlp finished without a file (it may be live, or over 2 GB).',
}
const URL_CHANGED: ErrorInfo = {
  code: 'invalid_request',
  message: "This download's link doesn't match its track. Add the track again.",
}
const BAD_ATTEMPT: ErrorInfo = {
  code: 'unknown',
  message: 'The download stopped unexpectedly. Retry to try again.',
}
const FOLDER_TOO_DEEP: ErrorInfo = {
  code: 'invalid_request',
  message:
    'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
}
/** macOS's PATH_MAX (1024) counts the terminating NUL: a path is at most 1023 bytes. */
const MAX_PATH_BYTES = 1023
/** The longest name publish puts beside the file: `._.djs-<uuid>.part` (macOS's sidecar on FAT). */
const PART_NAME_BYTES = '._.djs-.part'.length + 36
const CANCELED: AttemptOutcome = { kind: 'canceled' }

/** The filesystem calls an attempt makes itself; tests replace them to script failures. */
export type AttemptFs = {
  mkdir: (dir: string, options: { recursive: true; mode: number }) => Promise<unknown>
  rm: (dir: string, options: { recursive: true; force: true }) => Promise<void>
}

export type AttemptDeps = {
  /** The app data dir's real path; job dirs are `<dataDir>/jobs/<attemptId>`. */
  dataDir: string
  /** Finds yt-dlp, ffmpeg and ffprobe for this attempt; throws StepError('engine_missing'). */
  locate: () => Promise<EngineBins>
  finalize: Finalize
  publish: Publish
  run?: typeof run
  /** Our Node for `--js-runtimes`: `process.execPath`, never user input. */
  jsRuntime?: string
  /** `FFMPEG_PATH`, only when it is set. */
  ffmpegLocation?: string
  /** Wall-clock ms, for `progress.waitingUntil`. Default Date.now. */
  now?: () => number
  fs?: Partial<AttemptFs>
  log?: Logger
}

const DEFAULT_FS: AttemptFs = {
  mkdir: (dir, options) => mkdir(dir, options),
  rm: (dir, options) => rm(dir, options),
}

export function createRunAttempt(deps: AttemptDeps): RunAttempt {
  const context: Context = {
    ...deps,
    run: deps.run ?? run,
    jsRuntime: deps.jsRuntime ?? process.execPath,
    now: deps.now ?? Date.now,
    fs: { ...DEFAULT_FS, ...deps.fs },
    log: deps.log ?? console,
  }
  return (request, signal, onUpdate) => attempt(request, signal, onUpdate, context)
}

type Context = Required<Omit<AttemptDeps, 'ffmpegLocation' | 'fs'>> &
  Pick<AttemptDeps, 'ffmpegLocation'> & { fs: AttemptFs }

async function attempt(
  request: AttemptRequest,
  signal: AbortSignal,
  onUpdate: (update: AttemptUpdate) => void,
  context: Context,
): Promise<AttemptOutcome> {
  const { fs, log } = context
  const id = request.jobId.slice(0, 8)
  if (signal.aborted) return CANCELED
  // The queue hands over the classified URL; it is classified again here, and only that result
  // ever reaches yt-dlp (non-negotiable 1: the URL is never the request's own string).
  const checked = checkUrl(request.ref.url)
  if (!checked.ok) return failed(checked.error)
  if (!sameUrl(checked.input, request.input)) return failed(URL_CHANGED)
  if (checked.input.guess === 'collection') return failed(LIST_URL)
  if (!ATTEMPT_ID.test(request.attemptId)) {
    log.error(`[attempt] ${id}: the attempt id is not a UUID`)
    return failed(BAD_ATTEMPT)
  }
  // Enqueue checked the folder for the longest name; this is the room the name really has.
  const nameMaxBytes = nameBytesLeft(request.folder.real)
  if (nameMaxBytes < PART_NAME_BYTES) return failed(FOLDER_TOO_DEEP)

  const jobsDir = path.join(context.dataDir, JOBS_DIR)
  const jobDir = path.join(jobsDir, request.attemptId)
  try {
    await fs.mkdir(jobDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return failed(workDirError(error))
  }
  try {
    const dirs = { jobDir, jobsDir }
    return await download(request, checked.input, dirs, nameMaxBytes, signal, onUpdate, context)
  } finally {
    // Every process of this attempt is gone by now: run() settles only after its group is.
    await fs.rm(jobDir, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn(`[attempt] ${id}: can't remove the job dir (${failureName(error)})`)
    })
  }
}

async function download(
  request: AttemptRequest,
  input: ValidUrl,
  dirs: { jobDir: string; jobsDir: string },
  nameMaxBytes: number,
  signal: AbortSignal,
  onUpdate: (update: AttemptUpdate) => void,
  context: Context,
): Promise<AttemptOutcome> {
  const { log } = context
  const { options } = request
  // The classified URL's platform (equal to the request's, checked above), never ref.platform.
  const { platform } = input
  const id = request.jobId.slice(0, 8)

  let bins: EngineBins
  try {
    bins = await context.locate()
  } catch (error) {
    if (signal.aborted) return CANCELED
    if (error instanceof StepError) return failed(error.info)
    throw error
  }
  if (signal.aborted) return CANCELED

  const report = (update: AttemptUpdate): void => {
    try {
      onUpdate(update)
    } catch (error) {
      // A throw would stop the run (run.ts stops a group whose line callback throws).
      log.error(`[attempt] ${id}: an update listener failed: ${failureName(error)}`)
    }
  }
  const lines = readLines(report, context.now)
  // Stops the run when the URL turns out to be a list: one job is one track.
  const stop = new AbortController()
  const onLine = (raw: string): void => {
    if (lines.onLine(raw) === 'list') stop.abort()
  }

  let result: RunResult
  try {
    result = await context.run(
      bins.ytdlp,
      downloadArgs({
        url: input.url,
        platform,
        format: options.format,
        jobDir: dirs.jobDir,
        // D3: only for a file that can hold a cover (not WAV, not YouTube's WebM original).
        writeThumbnail: options.embedArtwork && canHoldCover(options.format, platform),
        jsRuntime: context.jsRuntime,
        ...(context.ffmpegLocation ? { ffmpegLocation: context.ffmpegLocation } : {}),
      }),
      {
        signal: AbortSignal.any([signal, stop.signal]),
        killGraceMs: KILL_GRACE_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        onStdoutLine: onLine,
        onStderrLine: onLine,
      },
    )
  } catch (error) {
    if (signal.aborted) return CANCELED
    if (error instanceof SpawnError) {
      return failed({ code: 'engine_missing', message: spawnFailure('yt-dlp', error.code) })
    }
    throw error
  }
  if (signal.aborted) return CANCELED
  if (lines.list) {
    log.info(`[attempt] ${id}: the ${platform} link is a list, stopped`)
    return failed(LIST_URL)
  }
  if (result.exitCode !== 0) {
    const error = mapDownloadExit({
      exitCode: result.exitCode,
      stderr: result.stderr,
      breakFilter: platform === 'soundcloud',
      jobDir: dirs.jobDir,
    })
    if (error.code === 'unknown') {
      const how = result.signal === null ? `exit ${result.exitCode}` : `signal ${result.signal}`
      log.warn(`[attempt] ${id}: yt-dlp failed (${how})`)
    }
    return failed(error)
  }
  const done = lines.done
  if (done === undefined) return failed(NO_FILE)

  // Finalize and publish. A file that reached the folder stands even if a cancel came meanwhile.
  if (!lines.processing) report({ status: 'processing' })
  const source = sourceOf(done) ?? lines.source
  try {
    const finished = await context.finalize({
      jobDir: dirs.jobDir,
      bins: { ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe },
      done,
      input,
      platform,
      format: options.format,
      options: {
        filenameTemplate: options.filenameTemplate,
        embedArtwork: options.embedArtwork,
        sourceUrlComment: options.sourceUrlComment,
      },
      nameMaxBytes,
      signal,
    })
    const published = await context.publish({
      src: finished.file,
      folder: request.folder,
      name: finished.name,
      attemptId: request.attemptId,
      jobsDir: dirs.jobsDir,
      signal,
    })
    const common = { outputPath: published.path, track: finished.track }
    const withSource = source === undefined ? {} : { source }
    return published.status === 'moved'
      ? { kind: 'done', ...common, output: finished.output, ...withSource }
      : { kind: 'skipped', ...common, ...withSource }
  } catch (error) {
    if (signal.aborted) return CANCELED
    if (error instanceof StepError) return failed(error.info)
    throw error
  }
}

/** What the lines of a run said so far. `onLine` returns 'list' when the run must stop. */
type Lines = {
  readonly list: boolean
  /** A DL `finished` (or a PP line after a DL) came: the job is processing. */
  readonly processing: boolean
  readonly done: DoneInfo | undefined
  readonly source: AudioSource | undefined
  onLine(raw: string): 'list' | undefined
}

/**
 * Reads the run's lines (both streams) into updates (D5):
 * - START: the stream yt-dlp picked (source), and when the site makes it wait, `waitingUntil`.
 * - DL: downloading, with the line's progress as parsed (the queue keeps the percent from going
 *   back); the first one ends the wait.
 * - DL `finished`, or a PP line after any DL: processing (yt-dlp's own fixups, then ours).
 * - DONE: the file and its metadata.
 * A START with a `playlist_id`, a second START or a second DONE means the URL is a list.
 */
function readLines(report: (update: AttemptUpdate) => void, now: () => number): Lines {
  let list = false
  let start: StartInfo | undefined
  let done: DoneInfo | undefined
  let downloading = false
  let processing = false

  const asList = (): 'list' => {
    list = true
    return 'list'
  }

  return {
    get list() {
      return list
    },
    get processing() {
      return processing
    },
    get done() {
      return done
    },
    get source() {
      return start === undefined ? undefined : sourceOf(start)
    },
    onLine(raw) {
      if (list) return undefined
      const line = parseDownloadLine(raw)
      switch (line?.kind) {
        case undefined:
          return undefined
        case 'start': {
          if (line.info.playlistId !== undefined || start !== undefined) return asList()
          start = line.info
          const source = sourceOf(line.info)
          const until = waitingUntil(line.info, now())
          const update: AttemptUpdate = {
            ...(source === undefined ? {} : { source }),
            ...(until === undefined ? {} : { progress: { waitingUntil: until } }),
          }
          if (Object.keys(update).length > 0) report(update)
          return undefined
        }
        case 'done':
          if (done !== undefined) return asList()
          done = line.info
          return undefined
        case 'dl': {
          if (processing) return undefined
          downloading = true
          if (line.status === 'finished') {
            processing = true
            report({ status: 'processing' })
            return undefined
          }
          // A new progress object: the first one also clears the wait START announced.
          report({ status: 'downloading', progress: line.progress })
          return undefined
        }
        case 'pp':
          if (downloading && !processing) {
            processing = true
            report({ status: 'processing' })
          }
          return undefined
      }
    },
  }
}

/** The stream as yt-dlp reported it (acodec as reported, e.g. `mp4a.40.2`), if anything is known. */
function sourceOf(info: { acodec?: string; abrKbps?: number }): AudioSource | undefined {
  if (info.acodec === undefined && info.abrKbps === undefined) return undefined
  return {
    ...(info.acodec === undefined ? {} : { codec: info.acodec }),
    ...(info.abrKbps === undefined ? {} : { bitrateKbps: info.abrKbps }),
  }
}

const failed = (error: ErrorInfo): AttemptOutcome => ({ kind: 'failed', error })

/**
 * The UTF-8 bytes a file name may take in `folderReal` (a real, absolute path): the whole path
 * `<folder>/<name>` must fit in macOS's 1023 bytes. A CJK character takes 3 bytes, so 180 units of
 * name can be 540 bytes.
 */
export function nameBytesLeft(folderReal: string): number {
  const prefix = Buffer.byteLength(path.join(folderReal, 'x')) - 1
  return MAX_PATH_BYTES - prefix
}

function sameUrl(a: ValidUrl, b: ValidUrl): boolean {
  return a.url === b.url && a.platform === b.platform && a.kind === b.kind
}

/** The job dir is in the data dir: a full disk there is disk_full, the rest `unknown`. */
function workDirError(error: unknown): ErrorInfo {
  const code = failureName(error)
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return { code: 'disk_full', message: DATA_DISK_FULL }
  }
  return { code: 'unknown', message: `The download's work folder can't be created (${code}).` }
}
