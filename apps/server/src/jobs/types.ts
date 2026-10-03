import type {
  AudioSource,
  DownloadFormat,
  DownloadOptions,
  ErrorCode,
  ErrorInfo,
  JobOutput,
  JobProgress,
  Platform,
  TrackRef,
  ValidUrl,
} from '@dj-scraper/shared'

/**
 * The seams between the download modules (docs: Phase 2 design). The queue runs attempts, an attempt
 * runs yt-dlp and then calls finalize and publish; each is injected so it can be tested alone.
 */

/** The parsed `before_dl:START {…}` line (engine/ytdlp-progress.ts). */
export type StartInfo = {
  formatId?: string
  acodec?: string
  abrKbps?: number
  asrHz?: number
  protocol?: string
  /** Epoch seconds before which the site won't serve the file (YouTube's enforced wait). */
  availableAt?: number
  /** Set when the URL turned out to be an entry of a list: one job must be one track. */
  playlistId?: string
}

/**
 * The parsed `after_move:DONE {…}` line. Paths are as yt-dlp printed them: check that they are
 * regular files inside the job dir before using them.
 */
export type DoneInfo = {
  id: string
  filepath: string
  ext?: string
  formatId?: string
  acodec?: string
  abrKbps?: number
  asrHz?: number
  durationSec?: number
  title?: string
  track?: string
  artist?: string
  artists?: string[]
  uploader?: string
  channel?: string
  album?: string
  albumArtist?: string
  releaseYear?: number
  releaseDate?: string
  webpageUrl?: string
  extractorKey?: string
  /** yt-dlp's availability: public, unlisted, private, needs_auth, … */
  availability?: string
  thumbnailPath?: string
  thumbnailUrl?: string
}

/** A download folder resolved at enqueue (fs/folders.ts). */
export type TargetFolder = {
  /** The folder as given, plus the sanitized subfolder: resolved again right before publishing. */
  given: string
  /** Its real path at enqueue. Publishing requires the folder to still resolve to it. */
  real: string
}

/** What the queue hands one attempt. */
export type AttemptRequest = {
  jobId: string
  /** A fresh UUID per attempt: the job dir is `<dataDir>/jobs/<attemptId>`. */
  attemptId: string
  ref: TrackRef
  /**
   * `classifyUrl(ref.url)`, re-checked by the attempt: yt-dlp gets `input.url`, never `ref.url`, and
   * every platform decision (argv, pacing, logs) uses `input.platform`, never `ref.platform`.
   */
  input: ValidUrl
  folder: TargetFolder
  options: DownloadOptions
}

/** A change an attempt reports while it runs. */
export type AttemptUpdate = {
  status?: 'downloading' | 'processing'
  /** `null` clears it. */
  progress?: JobProgress | null
  /** The stream being downloaded. */
  source?: AudioSource
}

/** The display values a finished attempt knows for sure (from yt-dlp's DONE line). */
export type FinalTrack = Partial<Pick<TrackRef, 'title' | 'artist' | 'url' | 'thumbnailUrl'>>

export type AttemptOutcome =
  | { kind: 'done'; outputPath: string; output: JobOutput; track: FinalTrack; source?: AudioSource }
  | { kind: 'skipped'; outputPath: string; track: FinalTrack; source?: AudioSource }
  | { kind: 'failed'; error: ErrorInfo }
  /** The signal aborted (cancel or shutdown); the queue knows which. */
  | { kind: 'canceled' }

/** Why the queue aborts an attempt; passed as the AbortController reason. */
export type AbortReason = { kind: 'cancel' } | { kind: 'shutdown' }

export type RunAttempt = (
  request: AttemptRequest,
  signal: AbortSignal,
  onUpdate: (update: AttemptUpdate) => void,
) => Promise<AttemptOutcome>

/** Engine binaries located for one attempt (installing ffmpeg mid-session needs no restart). */
export type EngineBins = {
  ytdlp: string
  ffmpeg: string
  ffprobe: string
}

export type FinalizeInput = {
  /** The attempt's job dir; every file finalize reads or writes is inside it. */
  jobDir: string
  bins: Pick<EngineBins, 'ffmpeg' | 'ffprobe'>
  done: DoneInfo
  input: ValidUrl
  platform: Platform
  format: DownloadFormat
  options: Pick<DownloadOptions, 'filenameTemplate' | 'embedArtwork' | 'sourceUrlComment'>
  /**
   * The most UTF-8 bytes the file name may take: what the target folder's real path leaves of
   * macOS's path limit (`nameBytesLeft` in attempt.ts).
   */
  nameMaxBytes: number
  signal: AbortSignal
}

export type FinalizeResult = {
  /** The finished file inside the job dir, tagged and ready to publish. */
  file: string
  /** The sanitized file name to publish it as, extension included. */
  name: string
  output: JobOutput
  track: FinalTrack
}

/** Throws `StepError` for failures with a code of their own; an abort rejects with the signal's reason. */
export type Finalize = (input: FinalizeInput) => Promise<FinalizeResult>

export type PublishRequest = {
  /** The finished file in the job dir. */
  src: string
  folder: TargetFolder
  /** A sanitized single file name. */
  name: string
  attemptId: string
  /** `<dataDir>/jobs`, where the cross-volume part record goes. */
  jobsDir: string
  signal: AbortSignal
}

/** `exists`: a file of that name was already there (case- and normalization-insensitively). */
export type PublishResult = { status: 'moved' | 'exists'; path: string }

/**
 * `<dataDir>/jobs/<attemptId>.part.json` (D10): what a cross-volume publish may have left in the
 * user's folder. Publish (fs/move.ts) writes it before it copies and removes it once nothing of
 * its own is left; the startup sweep (data-dir.ts) removes what a crashed server's records name.
 */
export type PartRecord = {
  /** `<folder>/.djs-<attemptId>.part`, absolute. */
  partPath: string
  /** The final name, reserved as an empty file on a volume without hard links (FAT/exFAT, SMB). */
  placeholderPath?: string
}

/** Throws `StepError` (disk_full, folder_unavailable, …); an abort rejects with the signal's reason. */
export type Publish = (request: PublishRequest) => Promise<PublishResult>

/** A failure of a download step with a message written for the user. Never carries paths or titles. */
export class StepError extends Error {
  override name = 'StepError'
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }

  get info(): ErrorInfo {
    return { code: this.code, message: this.message }
  }
}
