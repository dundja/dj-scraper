import * as z from 'zod'
import { type ErrorCode, ErrorCodeSchema, ErrorInfoSchema } from './errors.ts'
import { FolderPathSchema, isControl } from './folder.ts'
import { PlatformSchema } from './platform.ts'
import { MAX_COLLECTION_ENTRIES } from './resolve.ts'
import {
  AudioSourceSchema,
  AvailabilitySchema,
  MAX_ID_LENGTH,
  UnavailableReasonSchema,
} from './track.ts'
import { HttpUrlSchema, MAX_URL_LENGTH } from './url.ts'

/**
 * The file a download ends as. `original` keeps the downloaded stream (no DJ app plays Opus/WebM).
 * The other formats copy the stream when it already has the target codec and encode it otherwise,
 * so a Job's `output` says what was actually written (an MP3 source stays at its own bitrate).
 */
export const DownloadFormatSchema = z.enum(['mp3', 'm4a', 'aiff', 'wav', 'flac', 'original'])
export type DownloadFormat = z.infer<typeof DownloadFormatSchema>

/** What a filename template may name: `{artist} - {title}`. */
export const FILENAME_PLACEHOLDERS = [
  'artist',
  'title',
  'album',
  'year',
  'uploader',
  'id',
  'platform',
] as const
export type FilenamePlaceholder = (typeof FILENAME_PLACEHOLDERS)[number]

export const DEFAULT_FILENAME_TEMPLATE = '{artist} - {title}'
export const MAX_FILENAME_TEMPLATE_LENGTH = 200

/** The `{name}` tokens of a template, in order, unknown names included. */
export function templatePlaceholders(template: string): string[] {
  return Array.from(template.matchAll(/\{([^{}]*)\}/g), (match) => match[1] ?? '')
}

/**
 * Why a template can't be used, or undefined when it can. It must name the track (`{title}` or
 * `{id}`), use only known placeholders with balanced braces, and contain no path separators or
 * control characters: the server renders it into one file name and sanitizes the result.
 */
export function filenameTemplateProblem(template: string): string | undefined {
  for (let i = 0; i < template.length; i++) {
    if (isControl(template.charCodeAt(i))) return 'The template contains a control character'
  }
  if (template.includes('/') || template.includes('\\')) {
    return 'The template names a file, not a folder: remove / and \\'
  }
  if (template.replace(/\{[^{}]*\}/g, '').match(/[{}]/))
    return 'The template has an unmatched brace'
  const names = templatePlaceholders(template)
  const known: readonly string[] = FILENAME_PLACEHOLDERS
  const unknown = names.find((name) => !known.includes(name))
  if (unknown !== undefined) return `Unknown placeholder {${unknown}}`
  if (!names.includes('title') && !names.includes('id')) {
    return 'The template must contain {title} or {id}'
  }
  return undefined
}

export const FilenameTemplateSchema = z
  .string()
  .min(1)
  .max(MAX_FILENAME_TEMPLATE_LENGTH)
  .superRefine((template, ctx) => {
    const problem = filenameTemplateProblem(template)
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem })
  })

/** The longest title, artist or uploader a TrackRef may carry. */
export const MAX_TRACK_TEXT_LENGTH = 1000
const TrackText = z.string().min(1).max(MAX_TRACK_TEXT_LENGTH)

/**
 * A track to download: a full Track or a partial collection row (only platform, id and url are
 * required). The server classifies `url` itself and takes every platform decision from that, so
 * `platform` and the text fields are for display. A ref marked `unavailable` fails without a download.
 */
export const TrackRefSchema = z.object({
  platform: PlatformSchema,
  id: z.string().min(1).max(MAX_ID_LENGTH),
  url: HttpUrlSchema.max(MAX_URL_LENGTH),
  title: TrackText.optional(),
  artist: TrackText.optional(),
  uploader: TrackText.optional(),
  durationSec: z.number().nonnegative().optional(),
  thumbnailUrl: HttpUrlSchema.max(MAX_URL_LENGTH).optional(),
  availability: AvailabilitySchema.optional(),
  unavailableReason: UnavailableReasonSchema.optional(),
})
export type TrackRef = z.infer<typeof TrackRefSchema>

export const MAX_SUBFOLDER_LENGTH = 200

export const DownloadOptionsSchema = z.object({
  format: DownloadFormatSchema,
  filenameTemplate: FilenameTemplateSchema,
  embedArtwork: z.boolean(),
  /** Write the track's public page URL into the comment tag (never a secret or unlisted link). */
  sourceUrlComment: z.boolean(),
  /** A folder inside `folder`, e.g. the playlist title. The server makes one safe folder name of it. */
  subfolder: z.string().trim().min(1).max(MAX_SUBFOLDER_LENGTH).optional(),
})
export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>

export const MAX_DOWNLOAD_ITEMS = MAX_COLLECTION_ENTRIES
export const MAX_BATCH_LABEL_LENGTH = 200
const BatchLabel = z.string().trim().min(1).max(MAX_BATCH_LABEL_LENGTH)

/** `POST /api/downloads`: one job per distinct track, all into `folder` (plus the subfolder). */
export const DownloadRequestSchema = z.object({
  items: z.array(TrackRefSchema).min(1).max(MAX_DOWNLOAD_ITEMS),
  folder: FolderPathSchema,
  options: DownloadOptionsSchema,
  /** What the downloads panel calls this batch, e.g. the playlist title. */
  label: BatchLabel.optional(),
})
export type DownloadRequest = z.infer<typeof DownloadRequestSchema>

/**
 * `jobIds` has one id per request item, in order: an item that repeats another (within the request,
 * or a job still queued or running for the same track, folder and format) maps to that job.
 * `batchId` is absent when every item was a duplicate.
 */
export const CreateDownloadsResponseSchema = z.object({
  batchId: z.uuid().optional(),
  jobIds: z.array(z.uuid()),
  duplicates: z.int().nonnegative(),
})
export type CreateDownloadsResponse = z.infer<typeof CreateDownloadsResponseSchema>

export const JobStatusSchema = z.enum([
  'queued',
  'downloading',
  'processing',
  'done',
  'failed',
  'canceled',
  'skipped',
])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const TERMINAL_JOB_STATUSES = ['done', 'failed', 'canceled', 'skipped'] as const
export const isTerminalStatus = (status: JobStatus): boolean =>
  (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status)

/** The statuses a retry starts again from. */
export const RetryableStatusSchema = JobStatusSchema.extract(['failed', 'canceled'])
export type RetryableStatus = z.infer<typeof RetryableStatusSchema>

/** Failures that may go away by trying again; the rest (private, geo-blocked, preview…) won't. */
const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'network',
  'rate_limited',
  'bot_check',
  'unknown',
  'postprocess_failed',
  'engine_missing',
  'disk_full',
  'folder_unavailable',
])
/** Whether "Retry failed" should try a job that failed with `code` again. */
export const isRetryableError = (code: ErrorCode): boolean => RETRYABLE_ERROR_CODES.has(code)

/** Live numbers while downloading. Every field is optional: yt-dlp doesn't always know them. */
export const JobProgressSchema = z.object({
  percent: z.number().min(0).max(100).optional(),
  downloadedBytes: z.number().nonnegative().optional(),
  totalBytes: z.number().positive().optional(),
  speedBps: z.number().nonnegative().optional(),
  etaSec: z.number().nonnegative().optional(),
  /** The site makes yt-dlp wait until then before it serves the file (show "waiting"). */
  waitingUntil: z.iso.datetime().optional(),
})
export type JobProgress = z.infer<typeof JobProgressSchema>

/** The file actually written, read back from it: never inferred from the requested format. */
export const JobOutputSchema = z.object({
  /** The file extension, e.g. `mp3`, `m4a`, `aiff`, `webm`. */
  ext: z.string().regex(/^[a-z0-9]{1,5}$/),
  /** ffprobe's codec name, e.g. `mp3`, `aac`, `flac`, `pcm_s16be`, `opus`. */
  codec: z.string().min(1),
  /** For lossy codecs. */
  bitrateKbps: z.number().positive().optional(),
  sampleRateHz: z.int().positive().optional(),
  channels: z.int().positive().optional(),
  /** False when the downloaded stream was copied as is; true when it was converted. */
  encoded: z.boolean(),
})
export type JobOutput = z.infer<typeof JobOutputSchema>

const JobBaseSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  /** The request's ref; title, artist, url and artwork become the final values once known. */
  track: TrackRefSchema,
  format: DownloadFormatSchema,
  /** The resolved folder the file goes into (subfolder included). */
  folder: FolderPathSchema,
  /** 1 for the first try, +1 per retry. */
  attempt: z.int().positive(),
  createdAt: z.iso.datetime(),
  /** When the current attempt started. */
  startedAt: z.iso.datetime().optional(),
  /** The stream being or last downloaded (codec and bitrate from yt-dlp). */
  source: AudioSourceSchema.optional(),
  /** Cancel was asked while the job ran; it may still end done or skipped if the file was already in place. */
  cancelRequested: z.literal(true).optional(),
})
const FinishedAt = z.iso.datetime()

/** One track's download. Fields that only make sense in some states live on those states only. */
export const JobSchema = z.discriminatedUnion('status', [
  JobBaseSchema.extend({
    status: z.literal('queued'),
    /** Why it went back to the queue (a platform's rate limit), when it did. */
    lastError: ErrorInfoSchema.optional(),
  }),
  JobBaseSchema.extend({
    status: z.literal('downloading'),
    progress: JobProgressSchema.optional(),
  }),
  JobBaseSchema.extend({ status: z.literal('processing') }),
  JobBaseSchema.extend({
    status: z.literal('done'),
    outputPath: z.string().min(1),
    output: JobOutputSchema,
    finishedAt: FinishedAt,
  }),
  JobBaseSchema.extend({
    status: z.literal('skipped'),
    /** The file that was already there. */
    outputPath: z.string().min(1),
    finishedAt: FinishedAt,
  }),
  JobBaseSchema.extend({
    status: z.literal('failed'),
    error: ErrorInfoSchema,
    finishedAt: FinishedAt,
  }),
  JobBaseSchema.extend({ status: z.literal('canceled'), finishedAt: FinishedAt }),
])
export type Job = z.infer<typeof JobSchema>

/** The jobs of one `POST /api/downloads`. */
export const BatchSchema = z.object({
  id: z.uuid(),
  label: BatchLabel.optional(),
  folder: FolderPathSchema,
  format: DownloadFormatSchema,
  createdAt: z.iso.datetime(),
})
export type Batch = z.infer<typeof BatchSchema>

export const PauseCodeSchema = ErrorCodeSchema.extract(['rate_limited', 'bot_check'])
export type PauseCode = z.infer<typeof PauseCodeSchema>

/** A platform the queue is holding back. Only platforms with something to report are listed. */
export const PlatformQueueStateSchema = z.object({
  platform: PlatformSchema,
  /** The platform is limiting us: its jobs wait until then. */
  pausedUntil: z.iso.datetime().optional(),
  pauseCode: PauseCodeSchema.optional(),
  /** Pacing: the next queued job of this platform starts then. */
  nextStartAt: z.iso.datetime().optional(),
})
export type PlatformQueueState = z.infer<typeof PlatformQueueStateSchema>

export const QueueStateSchema = z.object({ platforms: z.array(PlatformQueueStateSchema) })
export type QueueState = z.infer<typeof QueueStateSchema>

/** Everything the downloads panel shows. `serverId` changes when the server restarts. */
export const DownloadsSnapshotSchema = z.object({
  serverId: z.uuid(),
  /** In creation order. */
  jobs: z.array(JobSchema),
  batches: z.array(BatchSchema),
  queue: QueueStateSchema,
})
export type DownloadsSnapshot = z.infer<typeof DownloadsSnapshotSchema>

/** Which jobs a bulk action applies to. Strict: `{ scope: 'all', ids }` is a client bug, not "all". */
export const JobScopeSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('all') }),
  z.strictObject({ scope: z.literal('batch'), batchId: z.uuid() }),
  z.strictObject({
    scope: z.literal('jobs'),
    ids: z.array(z.uuid()).min(1).max(MAX_DOWNLOAD_ITEMS),
  }),
])
export type JobScope = z.infer<typeof JobScopeSchema>

/** `POST /api/downloads/cancel`: queued and running jobs in scope. */
export const CancelJobsRequestSchema = z.object({ target: JobScopeSchema })
export type CancelJobsRequest = z.infer<typeof CancelJobsRequestSchema>

/** `POST /api/downloads/retry`: jobs in scope with these statuses, skipping failures retrying can't fix. */
export const RetryJobsRequestSchema = z.object({
  target: JobScopeSchema,
  statuses: z.array(RetryableStatusSchema).min(1).default(['failed']),
})
export type RetryJobsRequest = z.infer<typeof RetryJobsRequestSchema>

/** `POST /api/downloads/clear`: removes finished jobs (done, skipped, failed, canceled) in scope. */
export const ClearJobsRequestSchema = z.object({ target: JobScopeSchema })
export type ClearJobsRequest = z.infer<typeof ClearJobsRequestSchema>

/** How many jobs a bulk action changed; the changes themselves arrive as events. */
export const BulkJobsResponseSchema = z.object({ count: z.int().nonnegative() })
export type BulkJobsResponse = z.infer<typeof BulkJobsResponseSchema>
