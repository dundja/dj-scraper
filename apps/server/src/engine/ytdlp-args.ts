import path from 'node:path'
import type { DownloadFormat, Platform } from '@dj-scraper/shared'

/**
 * Pure: options → yt-dlp argv. Every call starts with `baseArgs` (no user config, no self-update,
 * plain UTF-8 output) and ends with `--` and the URL, so a URL can never be read as an option.
 */

/** Per-socket stall limit; the run's own timeout bounds the whole call. */
export const SOCKET_TIMEOUT_SEC = 20

/**
 * Flags for every yt-dlp call. `jsRuntime` is our own Node (`process.execPath`), the fallback for
 * YouTube's JS challenges when deno is missing; it is never user input.
 */
export function baseArgs(jsRuntime: string): string[] {
  return [
    '--ignore-config',
    '--no-update',
    '--color',
    'never',
    '--encoding',
    'utf-8',
    '--js-runtimes',
    `node:${jsRuntime}`,
  ]
}

export type ResolveArgsOptions = {
  url: string
  /** `yes` lists the whole list behind `watch?v=…&list=…`, `no` takes only the track. */
  playlist?: 'yes' | 'no'
  /** The listing cap; one row more is requested, so getting `limit + 1` rows means truncated. */
  limit: number
  jsRuntime: string
}

/** `-J --flat-playlist`: one JSON document for a track or a whole listing, without per-row lookups. */
export function resolveArgs({ url, playlist, limit, jsRuntime }: ResolveArgsOptions): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`)
  }
  return [
    ...baseArgs(jsRuntime),
    '-J',
    '--flat-playlist',
    '-I',
    `1:${limit + 1}`,
    ...(playlist === undefined ? [] : [playlist === 'yes' ? '--yes-playlist' : '--no-playlist']),
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--',
    url,
  ]
}

/**
 * A full single-track lookup, to fill in a partial collection row. A track is extracted in full
 * either way; `--flat-playlist` only matters if the URL turns out to be a list (a short link, an
 * unknown site), which then comes back as one cheap flat page instead of a full extraction of every
 * row. The track fixtures were recorded with it (see the READMEs under test/fixtures).
 */
export function entryArgs({ url, jsRuntime }: { url: string; jsRuntime: string }): string[] {
  return [
    ...baseArgs(jsRuntime),
    '-J',
    '--flat-playlist',
    '--no-playlist',
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--',
    url,
  ]
}

/** What a download line starts with; `engine/ytdlp-progress.ts` reads them back. */
export const LINE_PREFIX = { dl: 'DL ', pp: 'PP ', start: 'START ', done: 'DONE ' } as const

/** The stream yt-dlp picked, printed before the download (and before any wait the site forces). */
export const START_FIELDS = [
  'format_id',
  'acodec',
  'abr',
  'asr',
  'protocol',
  'available_at',
  'playlist_id',
] as const

/**
 * The finished file and the metadata finalize needs. No `thumbnails` list (4 KB on YouTube) and no
 * `original_url` (our own input, a credential for a secret SoundCloud link).
 */
export const DONE_FIELDS = [
  'id',
  'filepath',
  'ext',
  'format_id',
  'acodec',
  'abr',
  'asr',
  'duration',
  'title',
  'track',
  'artist',
  'artists',
  'uploader',
  'channel',
  'album',
  'album_artist',
  'release_year',
  'release_date',
  'webpage_url',
  'extractor_key',
  'availability',
  'thumbnails.-1.filepath',
  'thumbnails.-1.url',
] as const

/** `%(.{…})j` prints only the fields that exist, as one JSON object. */
export const START_PRINT = `before_dl:${LINE_PREFIX.start}%(.{${START_FIELDS.join(',')}})j`
export const DONE_PRINT = `after_move:${LINE_PREFIX.done}%(.{${DONE_FIELDS.join(',')}})j`
export const DL_PROGRESS_TEMPLATE = `download:${LINE_PREFIX.dl}%(progress)j`
export const PP_PROGRESS_TEMPLATE = `postprocess:${LINE_PREFIX.pp}%(progress.postprocessor)s %(progress.status)s`

/** yt-dlp names the file `<id>.<ext>` inside `-P`; finalize renames it. */
export const DOWNLOAD_OUTPUT_TEMPLATE = '%(id)s.%(ext)s'

/**
 * SoundCloud Go+ tracks only serve 30 s previews without a subscription. The break filter makes
 * yt-dlp exit 101 silently instead of downloading one (`mapDownloadExit` reads that as preview_only).
 */
export const PREVIEW_BREAK_FILTER = 'format_id!*=preview'

export type DownloadArgsOptions = {
  /** `checkUrl(ref.url).input.url`: the classified URL, never the request's own string. */
  url: string
  /** The classified platform. */
  platform: Platform
  format: DownloadFormat
  /** Absolute (a real path): yt-dlp writes nothing outside it. */
  jobDir: string
  /** D3: the cover for finalize (`embedArtwork` and a format that can hold one). */
  writeThumbnail: boolean
  /** `process.execPath`. */
  jsRuntime: string
  /** `FFMPEG_PATH`, only when it is set. */
  ffmpegLocation?: string
}

/**
 * The best audio-only stream (yt-dlp ranks formats; `ba` takes the top one). M4A prefers an AAC
 * stream it can copy. SoundCloud skips its 64k Opus, which DJ apps can't play and the MP3/AAC
 * streams beat; `audioSource` in ytdlp-parse.ts skips it too, so resolve shows the same stream.
 * Other sites may only have muxed formats, hence `/b`.
 */
export function downloadSelector(platform: Platform, format: DownloadFormat): string {
  const m4a = format === 'm4a'
  switch (platform) {
    case 'youtube':
      return m4a ? 'ba[ext=m4a]/ba' : 'ba'
    case 'soundcloud':
      return m4a ? 'ba[ext=m4a]/ba[acodec!=opus]/ba' : 'ba[acodec!=opus]/ba'
    case 'other':
      return m4a ? 'ba[ext=m4a]/ba/b' : 'ba/b'
  }
}

/**
 * Downloads one track's stream as is into `jobDir` (no `-x`: finalize converts, tags and adds the
 * cover). Quiet output (`--print` implies it) with `--progress`: DL lines and START/DONE on stdout,
 * PP lines and errors on stderr.
 * - A failed fragment aborts the run instead of being skipped silently (a shorter file).
 * - `--max-filesize` is enforced by the plain HTTP downloader only; HLS ignores it.
 * - No `--sleep-*` flags: the queue paces downloads. SoundCloud gets no extractor retries, so a
 *   429 fails at once and the queue's cooldown takes over.
 */
export function downloadArgs(options: DownloadArgsOptions): string[] {
  const { url, platform, format, jobDir, writeThumbnail, jsRuntime, ffmpegLocation } = options
  if (!path.isAbsolute(jobDir)) throw new RangeError('jobDir must be an absolute path')
  return [
    ...baseArgs(jsRuntime),
    '--no-playlist',
    '-f',
    downloadSelector(platform, format),
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--retry-sleep',
    'fragment:exp=1:8',
    '--abort-on-unavailable-fragments',
    '--max-filesize',
    '2G',
    ...(writeThumbnail ? ['--write-thumbnail'] : []),
    ...(ffmpegLocation ? ['--ffmpeg-location', ffmpegLocation] : []),
    ...(platform === 'soundcloud'
      ? ['--extractor-retries', '0', '--break-match-filters', PREVIEW_BREAK_FILTER]
      : []),
    ...(platform === 'other' ? ['--match-filters', '!is_live'] : []),
    '-P',
    jobDir,
    '-o',
    DOWNLOAD_OUTPUT_TEMPLATE,
    '--newline',
    '--progress',
    '--progress-delta',
    '0.5',
    '--progress-template',
    DL_PROGRESS_TEMPLATE,
    '--progress-template',
    PP_PROGRESS_TEMPLATE,
    '--print',
    START_PRINT,
    '--print',
    DONE_PRINT,
    '--',
    url,
  ]
}
