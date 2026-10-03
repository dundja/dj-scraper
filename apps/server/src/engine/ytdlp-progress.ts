import { HttpUrlSchema, type JobProgress, MAX_URL_LENGTH } from '@dj-scraper/shared'
import * as z from 'zod'
import type { DoneInfo, StartInfo } from '../jobs/types.ts'
import { lenient, omitUndefined } from '../util/fields.ts'
import { LINE_PREFIX } from './ytdlp-args.ts'

/**
 * Pure: one line of a download run (see `downloadArgs`) → what it says, or undefined.
 * - `DL {…}` (stdout): yt-dlp's progress dict, ~1 KB, two absolute paths in it: never forward it.
 * - `PP <postprocessor> <status>` (stderr: `--print` makes yt-dlp quiet, and quiet screen output
 *   goes to stderr).
 * - `START {…}` (stdout, `before_dl`): the stream yt-dlp picked, before any wait the site forces.
 * - `DONE {…}` (stdout, `after_move`): the downloaded file and its metadata.
 * The JSON is distrusted like the `-J` output in ytdlp-parse.ts: a missing, null or wrongly typed
 * field is just absent, and a line that isn't one of these (garbage, `[youtube] …` under
 * `--no-quiet`, `ERROR:`) is undefined. Nothing here throws.
 */

export type DownloadLine =
  | { kind: 'dl'; status: 'downloading' | 'finished'; progress: JobProgress }
  | { kind: 'pp'; postprocessor: string; status: string }
  | { kind: 'start'; info: StartInfo }
  | { kind: 'done'; info: DoneInfo }

/** `PP MoveFiles finished`: the postprocessor's key and its status (started, processing, finished). */
export const POSTPROCESS_LINE = /^PP ([A-Za-z]\w{0,63}) ([a-z_]{1,32})$/

/** The last instant `JobProgress.waitingUntil` can show (an ISO year has 4 digits): 9999-12-31. */
const MAX_EPOCH_SEC = Date.UTC(9999, 11, 31, 23, 59, 59) / 1000

/** Trimmed, non-empty text. */
const Text = lenient(z.string().trim().min(1))
/** A codec, where yt-dlp's `none` (no audio) counts as unknown. */
const Codec = lenient(
  z
    .string()
    .trim()
    .min(1)
    .refine((codec) => codec !== 'none'),
)
const Id = lenient(z.union([z.string().trim().min(1), z.int().nonnegative().transform(String)]))
/** Only http(s): a `javascript:` or `file:` URL must never reach the UI or a tag. */
const Url = lenient(HttpUrlSchema.max(MAX_URL_LENGTH))
const Count = lenient(z.number().nonnegative())
const Positive = lenient(z.number().positive())
const Hz = lenient(z.int().positive())
const Epoch = lenient(z.number().nonnegative().max(MAX_EPOCH_SEC))

/** yt-dlp's progress dict (`%(progress)j`); `_percent` is unused: it can be `false`, and HLS estimates jump. */
const DlSchema = z.looseObject({
  status: lenient(z.enum(['downloading', 'finished'])),
  downloaded_bytes: Count,
  total_bytes: Positive,
  total_bytes_estimate: Positive,
  fragment_index: lenient(z.int().nonnegative()),
  fragment_count: lenient(z.int().positive()),
  speed: Count,
  eta: Count,
})
type Dl = z.output<typeof DlSchema>

const StartSchema = z.looseObject({
  format_id: Text,
  acodec: Codec,
  abr: Positive,
  asr: Hz,
  protocol: Text,
  available_at: Epoch,
  playlist_id: Id,
})

const DoneSchema = z.looseObject({
  id: Id,
  filepath: Text,
  ext: Text,
  format_id: Text,
  acodec: Codec,
  abr: Positive,
  asr: Hz,
  duration: Count,
  title: Text,
  track: Text,
  artist: Text,
  artists: lenient(z.array(Text)),
  uploader: Text,
  channel: Text,
  album: Text,
  album_artist: Text,
  release_year: lenient(z.int().min(1).max(9999)),
  /** yt-dlp normalizes dates to YYYYMMDD. */
  release_date: lenient(z.string().regex(/^\d{8}$/)),
  webpage_url: Url,
  extractor_key: Text,
  availability: Text,
  'thumbnails.-1.filepath': Text,
  'thumbnails.-1.url': Url,
})

/** Reads one line of a download run. Never throws; anything it doesn't recognize is undefined. */
export function parseDownloadLine(line: string): DownloadLine | undefined {
  const text = line.trimEnd()
  if (text.startsWith(LINE_PREFIX.pp)) {
    const match = POSTPROCESS_LINE.exec(text)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    return { kind: 'pp', postprocessor: match[1], status: match[2] }
  }
  if (text.startsWith(LINE_PREFIX.dl)) return dlLine(jsonAfter(text, LINE_PREFIX.dl))
  if (text.startsWith(LINE_PREFIX.start)) return startLine(jsonAfter(text, LINE_PREFIX.start))
  if (text.startsWith(LINE_PREFIX.done)) return doneLine(jsonAfter(text, LINE_PREFIX.done))
  return undefined
}

/**
 * When the site makes yt-dlp wait before it serves the file (YouTube's `available_at`), as an ISO
 * instant; undefined when that moment has passed. yt-dlp waits silently in quiet mode.
 */
export function waitingUntil(start: StartInfo, nowMs: number): string | undefined {
  const { availableAt } = start
  if (availableAt === undefined || !Number.isFinite(availableAt)) return undefined
  if (availableAt < 0 || availableAt > MAX_EPOCH_SEC) return undefined
  const atMs = availableAt * 1000
  return atMs > nowMs ? new Date(atMs).toISOString() : undefined
}

/** The JSON object after the prefix, or undefined. */
function jsonAfter(text: string, prefix: string): object | undefined {
  let value: unknown
  try {
    value = JSON.parse(text.slice(prefix.length))
  } catch {
    return undefined
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function dlLine(json: object | undefined): DownloadLine | undefined {
  const parsed = DlSchema.safeParse(json)
  if (!parsed.success || parsed.data.status === undefined) return undefined
  const dl = parsed.data
  const status = parsed.data.status
  return {
    kind: 'dl',
    status,
    progress: omitUndefined({
      percent: status === 'finished' ? 100 : percentOf(dl),
      downloadedBytes: dl.downloaded_bytes,
      // An estimate (HLS) can jump 100× between lines: it only feeds the percent, as a last resort.
      totalBytes: dl.total_bytes,
      speedBps: dl.speed,
      etaSec: dl.eta,
    }),
  }
}

/**
 * Fragments first: an HLS `total_bytes_estimate` swings (4.3 % → 0.08 % → 29.8 % in
 * soundcloud-hls-aac), while `fragment_index` counts the fragments already done. Else bytes over
 * the total, or the estimate. Clamped to [0, 100].
 */
function percentOf(dl: Dl): number | undefined {
  const { fragment_index: index, fragment_count: count } = dl
  if (index !== undefined && count !== undefined) return clampPercent((index / count) * 100)
  const total = dl.total_bytes ?? dl.total_bytes_estimate
  if (dl.downloaded_bytes === undefined || total === undefined) return undefined
  return clampPercent((dl.downloaded_bytes / total) * 100)
}

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function startLine(json: object | undefined): DownloadLine | undefined {
  const parsed = StartSchema.safeParse(json)
  if (!parsed.success) return undefined
  const start = parsed.data
  return {
    kind: 'start',
    info: omitUndefined({
      formatId: start.format_id,
      acodec: start.acodec,
      abrKbps: start.abr,
      asrHz: start.asr,
      protocol: start.protocol,
      availableAt: start.available_at,
      playlistId: start.playlist_id,
    }),
  }
}

/** A DONE line without an id or a file path is no use to finalize: the run then has no file. */
function doneLine(json: object | undefined): DownloadLine | undefined {
  const parsed = DoneSchema.safeParse(json)
  if (!parsed.success) return undefined
  const done = parsed.data
  if (done.id === undefined || done.filepath === undefined) return undefined
  const artists = done.artists?.filter((name) => name !== undefined)
  return {
    kind: 'done',
    info: {
      id: done.id,
      filepath: done.filepath,
      ...omitUndefined({
        ext: done.ext,
        formatId: done.format_id,
        acodec: done.acodec,
        abrKbps: done.abr,
        asrHz: done.asr,
        durationSec: done.duration,
        title: done.title,
        track: done.track,
        artist: done.artist,
        artists: artists !== undefined && artists.length > 0 ? artists : undefined,
        uploader: done.uploader,
        channel: done.channel,
        album: done.album,
        albumArtist: done.album_artist,
        releaseYear: done.release_year,
        releaseDate: done.release_date,
        webpageUrl: done.webpage_url,
        extractorKey: done.extractor_key,
        availability: done.availability,
        thumbnailPath: done['thumbnails.-1.filepath'],
        thumbnailUrl: done['thumbnails.-1.url'],
      }),
    },
  }
}
