import {
  type AudioSource,
  type ErrorCode,
  type ErrorInfo,
  isTerminalStatus,
  type Job,
  type JobOutput,
  type JobProgress,
  type Platform,
} from '@dj-scraper/shared'
import { errorHint } from '@/lib/error-text.ts'
import { folderName, formatBytes, formatClock, formatEta, formatSpeed } from '@/lib/format.ts'

// Words for a download job: its names, its status, its progress, and what its file really is.
// Honest audio: the output is read back from the file, and it is always shown next to the stream it
// came from, so a "320 kbps" MP3 made from a 128 kbps stream says so.

/** What a track without a title is called, before its platform id. */
const UNTITLED: Record<Platform, string> = {
  youtube: 'YouTube video',
  soundcloud: 'SoundCloud track',
  other: 'Track',
}

/**
 * The job's title, else what it is and its platform id ("SoundCloud track 1234567893"): a set row
 * downloaded before anyone looked it up has no title, and a bare number says nothing.
 */
export function jobTitle(job: Job): string {
  const { title, platform, id } = job.track
  return title ?? `${UNTITLED[platform]} ${id}`
}

/**
 * The artist, else the uploader: a YouTube video without artist metadata has no `artist`, while its
 * file name and tags use the uploader.
 */
export function jobArtist(job: Job): string | undefined {
  return job.track.artist ?? job.track.uploader
}

/** Codec names as yt-dlp (`acodec`) and ffprobe (`codec_name`) report them. */
const CODEC_LABELS: ReadonlyMap<string, string> = new Map([
  ['mp3', 'MP3'],
  ['aac', 'AAC'],
  ['mp4a.40.2', 'AAC'],
  ['mp4a.40.5', 'HE-AAC'],
  ['mp4a.40.29', 'HE-AAC v2'],
  ['opus', 'Opus'],
  ['vorbis', 'Vorbis'],
  ['flac', 'FLAC'],
  ['alac', 'ALAC'],
  ['ac3', 'AC-3'],
  ['ac-3', 'AC-3'],
  ['eac3', 'E-AC-3'],
  ['ec-3', 'E-AC-3'],
])

/** A codec as people know it: `mp4a.40.2` → "AAC", `opus` → "Opus", `pcm_s16be` → "PCM". */
export function codecLabel(codec: string): string {
  const name = codec.toLowerCase()
  const label = CODEC_LABELS.get(name)
  if (label !== undefined) return label
  if (name.startsWith('mp4a.')) return 'AAC'
  if (name.startsWith('pcm_')) return 'PCM'
  return codec.toUpperCase()
}

/** Bitrates encoders target. A measured rate is a little above its nominal one (overhead). */
const NOMINAL_KBPS = [32, 48, 64, 96, 112, 128, 160, 192, 224, 256, 320] as const
const NOMINAL_SLACK = 1.03

/**
 * "128 kbps". A rate up to 3 % above a nominal bitrate shows as that bitrate: YouTube's AAC stream
 * (format 140) measures 129.553 kbps for its nominal 128. Never rounded up to a nominal rate, so a
 * file is never shown better than it measured.
 */
export function formatKbps(kbps: number): string {
  const nominal = NOMINAL_KBPS.find((rate) => kbps >= rate && kbps < rate * NOMINAL_SLACK)
  return `${nominal ?? Math.round(kbps)} kbps`
}

/** The stream a track downloads from: "AAC 128 kbps", "Opus 136 kbps", "MP3", "128 kbps". */
export function sourceText(source: AudioSource): string {
  const parts: string[] = []
  if (source.codec !== undefined) parts.push(codecLabel(source.codec))
  if (source.bitrateKbps !== undefined) parts.push(formatKbps(source.bitrateKbps))
  return parts.join(' ')
}

/** File extensions as people know them; the rest are shown in capitals. */
const FORMAT_LABELS: ReadonlyMap<string, string> = new Map([
  ['m4a', 'M4A'],
  ['aif', 'AIFF'],
  ['webm', 'WebM'],
  ['ogg', 'Ogg'],
  ['opus', 'Opus'],
])

const LOSSLESS_CODECS: ReadonlySet<string> = new Set(['flac', 'alac'])

/** The sample format of a PCM codec: `pcm_s16be` → "16-bit", `pcm_f32le` → "32-bit float". */
function pcmDepth(codec: string): string | undefined {
  const match = /^pcm_([suf])(\d+)/.exec(codec.toLowerCase())
  if (match?.[2] === undefined) return undefined
  return match[1] === 'f' ? `${match[2]}-bit float` : `${match[2]}-bit`
}

/**
 * What a finished file is, read back from it, and where it came from:
 * - "MP3 · 128 kbps · copied": the stream was kept as it was (an MP3 source keeps its bitrate);
 * - "MP3 · 320 kbps · re-encoded from Opus 136 kbps": a lossy file made from another lossy one;
 * - "M4A · AAC 128 kbps · copied", "WebM · Opus 136 kbps · copied": the codec when the container
 *   doesn't name it;
 * - "AIFF · 16-bit · from AAC 128 kbps": a lossless file holds the source's quality, no more.
 * Only the fields that exist are shown, and "mono" when the file has one channel.
 */
export function outputText(output: JobOutput, source: AudioSource | undefined): string {
  const format = FORMAT_LABELS.get(output.ext) ?? output.ext.toUpperCase()
  const codec = codecLabel(output.codec)
  const depth = pcmDepth(output.codec)
  const lossless = depth !== undefined || LOSSLESS_CODECS.has(output.codec.toLowerCase())

  // PCM goes without saying in AIFF and WAV, and an MP3 or FLAC file names its codec.
  const quality: string[] = []
  if (depth === undefined && codec !== format) quality.push(codec)
  if (output.bitrateKbps !== undefined) quality.push(formatKbps(output.bitrateKbps))

  const parts = [format]
  if (quality.length > 0) parts.push(quality.join(' '))
  if (depth !== undefined) parts.push(depth)
  if (output.channels === 1) parts.push('mono')
  parts.push(originText(output.encoded, lossless, source))
  return parts.join(' · ')
}

function originText(encoded: boolean, lossless: boolean, source: AudioSource | undefined): string {
  if (!encoded) return 'copied'
  const from = source === undefined ? undefined : sourceText(source)
  if (lossless) return from === undefined ? 'converted' : `from ${from}`
  return from === undefined ? 're-encoded' : `re-encoded from ${from}`
}

/** "1.2 MB/s"-style numbers exist: yt-dlp reported more than a wait. */
function hasNumbers(progress: JobProgress | undefined): boolean {
  return progressText(progress) !== ''
}

/**
 * "42 % · 1.2 MB/s · 0:12 left", with whatever yt-dlp knows: the downloaded size ("1.7 MB of
 * 4.0 MB") when there is no percent. The percent rounds down, so it never says 100 % too early.
 * Empty when there are no numbers (yet).
 */
export function progressText(progress: JobProgress | undefined): string {
  if (progress === undefined) return ''
  const { percent, downloadedBytes, totalBytes, speedBps, etaSec } = progress
  const parts: string[] = []
  if (percent !== undefined) {
    parts.push(`${Math.floor(percent)} %`)
  } else if (downloadedBytes !== undefined) {
    const done = formatBytes(downloadedBytes)
    parts.push(totalBytes === undefined ? done : `${done} of ${formatBytes(totalBytes)}`)
  }
  if (speedBps !== undefined && speedBps > 0) parts.push(formatSpeed(speedBps))
  if (etaSec !== undefined) parts.push(formatEta(etaSec))
  return parts.filter((part) => part !== '').join(' · ')
}

const PLATFORM_NAMES: Record<Platform, string | undefined> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  other: undefined,
}

/** "Waiting until 09:05 (YouTube)": the site makes yt-dlp wait before it serves the file. */
export function waitingText(iso: string, platform?: Platform): string {
  const clock = formatClock(iso)
  const text = clock === '' ? 'Waiting' : `Waiting until ${clock}`
  const site = platform === undefined ? undefined : PLATFORM_NAMES[platform]
  return site === undefined ? text : `${text} (${site})`
}

/** A downloading job's `waitingUntil`, whether or not it has passed: when to look again. */
export function waitingUntil(job: Job): string | undefined {
  return job.status === 'downloading' ? job.progress?.waitingUntil : undefined
}

/** The job's `waitingUntil` while it is still ahead of `now` (ms). */
function activeWait(job: Job, now: number): string | undefined {
  const until = waitingUntil(job)
  return until !== undefined && Date.parse(until) > now ? until : undefined
}

/**
 * Where a job is, finer than its status:
 * - `requeued`: queued again after a platform limited it (`lastError`);
 * - `starting`, `waiting`, `downloading`: downloading without numbers yet, held by the site until
 *   `waitingUntil`, or with progress numbers;
 * - `canceling`: a cancel was asked and the job hasn't stopped yet (`cancelRequested`).
 */
export type JobPhase =
  | 'queued'
  | 'requeued'
  | 'starting'
  | 'waiting'
  | 'downloading'
  | 'processing'
  | 'canceling'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'canceled'

/** The job's phase at `now` (ms), which decides when a wait is over. */
export function jobPhase(job: Job, now: number): JobPhase {
  if (job.cancelRequested === true && !isTerminalStatus(job.status)) return 'canceling'
  switch (job.status) {
    case 'queued':
      return job.lastError === undefined ? 'queued' : 'requeued'
    case 'downloading':
      if (activeWait(job, now) !== undefined) return 'waiting'
      return hasNumbers(job.progress) ? 'downloading' : 'starting'
    default:
      return job.status
  }
}

function requeuedLabel(error: ErrorInfo): string {
  switch (error.code) {
    case 'rate_limited':
      return 'Rate-limited, retrying soon'
    case 'bot_check':
      return 'Bot check, retrying soon'
    default:
      return 'Retrying soon'
  }
}

/**
 * The job's status in a few words, as the track card's headline and its live region say it:
 * "Queued", "Waiting until 09:05 (YouTube)", "Downloading", "Converting and tagging…", "Done".
 */
export function statusLabel(job: Job, now: number): string {
  if (jobPhase(job, now) === 'canceling') return 'Canceling…'
  switch (job.status) {
    case 'queued':
      return job.lastError === undefined ? 'Queued' : requeuedLabel(job.lastError)
    case 'downloading': {
      const until = activeWait(job, now)
      if (until !== undefined) return waitingText(until, job.track.platform)
      return hasNumbers(job.progress) ? 'Downloading' : 'Starting…'
    }
    case 'processing':
      // "Original" converts nothing: the stream is only put into its file.
      return job.format === 'original' ? 'Finishing…' : 'Converting and tagging…'
    case 'done':
      return 'Done'
    case 'skipped':
      return 'Already in the folder'
    case 'failed':
      return 'Failed'
    case 'canceled':
      return 'Canceled'
  }
}

/**
 * What the label leaves out, for the states that have more to say (progress numbers aside): why a
 * job went back to the queue, what the file is, which file was kept, why it failed.
 */
export function statusDetail(job: Job): string | undefined {
  switch (job.status) {
    case 'queued':
      return job.lastError?.message
    case 'done':
      return outputText(job.output, job.source)
    case 'skipped':
      return `Kept the file that was there: ${folderName(job.outputPath)}`
    case 'failed':
      return job.error.message
    default:
      return undefined
  }
}

/**
 * The job's one status line in the downloads list: the progress numbers while downloading, the
 * output once done, the error's message once failed, else the label ("Rate-limited, retrying
 * soon: <why>" for a requeued job).
 */
export function statusText(job: Job, now: number): string {
  const label = statusLabel(job, now)
  switch (jobPhase(job, now)) {
    case 'requeued':
      return `${label}: ${statusDetail(job)}`
    case 'downloading':
      return job.status === 'downloading' ? progressText(job.progress) : label
    case 'done':
    case 'failed':
      return statusDetail(job) ?? label
    default:
      return label
  }
}

/**
 * A failed job's next step. Retry runs the job again into its own folder and format, so where the
 * hint for a refused download (`errorHint`) points at another folder or format, a job says what
 * Retry needs instead. `downloadAgain`: the track card also offers "Download again", which uses
 * the folder in the header, so a lost folder names that way out too.
 */
export function jobErrorHint(code: ErrorCode, downloadAgain = false): string | undefined {
  switch (code) {
    case 'folder_unavailable':
      return downloadAgain
        ? 'Reconnect the drive or put the folder back, then retry. Or pick another folder in the header and download again.'
        : 'Reconnect the drive or put the folder back, then retry.'
    case 'postprocess_failed':
      return 'Retry; if it keeps failing, update ffmpeg: `brew upgrade ffmpeg`.'
    default:
      return errorHint(code)
  }
}
