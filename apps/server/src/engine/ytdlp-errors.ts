import { type ErrorCode, type ErrorInfo, urlRejectionMessage } from '@dj-scraper/shared'
import { POSTPROCESS_LINE } from './ytdlp-progress.ts'

/**
 * Pure: a failed yt-dlp run → a typed `ErrorInfo` with a message written for humans
 * ("Private video.", "Not available in your country.", …). Every pattern is backed by a fixture in
 * test/fixtures/errors/ or test/fixtures/downloads/ (see their READMEs for which ones are recorded
 * and which are synthetic).
 *
 * How stderr is read:
 * - Exit code 2 is an option error: yt-dlp rejected our argv before doing anything. That is a bug
 *   on our side, or a yt-dlp too old to know a flag we pass.
 * - Only `ERROR:` lines decide. yt-dlp puts the reason on the ERROR line itself; the lines after it
 *   (geo's "This video is available in …", "You might want to use a VPN …") only add advice.
 *   One exception: a download that gives up retrying prints `ERROR: \r[download] Got error: …`, and
 *   the `\r` splits the line, so an empty ERROR line takes the `[download] …` line after it as its
 *   reason. Such a transfer error is read with `TRANSFER_PATTERNS` first: the track was found, so a
 *   4xx on its media is a refused request, never "removed".
 * - With several ERROR lines, the LAST one that maps to a specific code wins. yt-dlp prints the
 *   failure that ended the run last, and a trailing generic ERROR mustn't hide an earlier reason.
 *   `FALLBACK_PATTERNS` (e.g. "fragment 3 not found, unable to continue", which follows the real
 *   transfer error) count only when no ERROR line is specific.
 * - WARNING lines decide only through `WARNING_HINTS`, and only when the ERROR itself is generic
 *   (it maps to `unknown`). Each hint has a fixture where yt-dlp reports the real reason as a
 *   warning only; e.g. SoundCloud's 401 for original files is a WARNING plus "Requested format is
 *   not available".
 * - `preview_only` never comes from stderr. yt-dlp doesn't treat a Go+ preview as an error: a
 *   `--match-filters` rejection is silent in quiet mode (preview-filter.log is stdout under
 *   `--no-quiet`), and an excluding `-f` gives the generic "Requested format is not available"
 *   (preview-format-unavailable.log). Resolve detects previews from the formats; a download's
 *   `--break-match-filters` exits 101 silently, which `mapDownloadExit` reads.
 * - `PP …` lines (a download's postprocessor progress, on stderr in quiet mode) are never quoted.
 * - Messages never hold paths: the job dir (when given) and any quoted absolute path, as Python's
 *   `OSError` prints one (`[Errno 13] Permission denied: '/…'`), are cut out of stderr first.
 * - The text is assumed free of ANSI codes, because `baseArgs` always passes `--color never`.
 */

export type YtdlpFailure = {
  stderr: string
  exitCode: number | null
  /** The download's job dir: cut out of any text a message quotes. */
  jobDir?: string
}

/** One table row. `match` runs on yt-dlp's reason text: no `ERROR:`, `[extractor] <id>: ` or bug-report tail. */
export type ErrorPattern = {
  readonly code: ErrorCode
  readonly match: RegExp
  readonly message: string
}

/** The most of yt-dlp's own text a message quotes, in code points. */
export const MAX_QUOTED_LENGTH = 300

const UPDATE_HINT = 'Updating yt-dlp may help.'
/** The words for a full data-dir drive, as the attempt and finalize use them. */
/** A full drive under the app data dir, wherever it shows up (yt-dlp, ffmpeg, our own writes). */
export const DATA_DISK_FULL = "The drive with DJ Scraper's data is full."

/**
 * Checked in order; the first match wins, so the more specific rows come first:
 * - The URL is the only user-controlled text that can appear in a reason, so its row is first.
 * - Rate limits go before `unavailable`: YouTube's start with "Video unavailable."
 * - The age and bot checks go before the login catch-all: all three say "Sign in" and "cookies".
 * - `private` goes before login: "Private video. Sign in if you've been granted access …".
 * - `geo_blocked` goes before `unavailable`: "This video is not available from your location", and
 *   YouTube's "Video unavailable. … who has blocked it in your country on copyright grounds."
 * - `engine_missing` goes before `postprocess_failed`: "Postprocessing: ffprobe and ffmpeg not found".
 * - `disk_full` goes before `postprocess_failed` and `network`: a fixup's "Postprocessing: … No space
 *   left on device", and the fragment downloader's "Unable to download video: [Errno 28] …".
 * - `network` comes last, because the specific HTTP codes above also say "Unable to download …".
 * Rows with code `unknown` only give a common failure a readable message.
 */
export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    code: 'unsupported_url',
    match: /\bUnsupported URL\b|\bwebsite is (?:no longer |not )supported\b/i,
    message: "This link isn't supported. Paste a YouTube or SoundCloud link.",
  },
  {
    code: 'invalid_url',
    match: /\bis not a valid URL\b/i,
    message: urlRejectionMessage('not_a_url'),
  },
  {
    code: 'unsupported_url',
    // KnownDRMIE ("known to use DRM protection") and report_drm ("This video is DRM protected").
    match: /\bDRM\b/,
    message: "This is DRM-protected, so DJ Scraper can't download it.",
  },
  {
    code: 'unsupported_url',
    // A mix opened as playlist?list=RD… (only watch?v=…&list=RD… lists), or WL/LL without a login.
    match: /\bplaylist type is unviewable\b/i,
    message: "YouTube can't list this kind of playlist. Open a mix from one of its videos.",
  },
  {
    code: 'engine_missing',
    match: /\b(?:ffmpeg|ffprobe) not found\b|\bffmpeg is not installed\b/i,
    message: 'ffmpeg or ffprobe is missing. Run `brew install ffmpeg`.',
  },
  {
    code: 'canceled',
    match: /\binterrupted by user\b/i,
    message: 'Canceled.',
  },
  {
    code: 'disk_full',
    // ENOSPC and macOS's EDQUOT (69, "Disc quota exceeded"): yt-dlp writes only into the job dir,
    // which is in the data dir (local-enospc-write, local-enospc-open, local-enospc-hls).
    match: /\[Errno (?:28|69)\]|\bNo space left on device\b|\bDis[ck] quota exceeded\b/i,
    message: DATA_DISK_FULL,
  },
  {
    code: 'rate_limited',
    // ASCII apostrophe in yt-dlp's check; the curly one too in case YouTube's text changes.
    match: /\bisn['’]t available, try again later\b/i,
    message: 'YouTube is limiting requests for up to an hour. Try again later.',
  },
  {
    code: 'rate_limited',
    match: /\bHTTP Error 429\b|\btoo many requests\b|\brate[- ]limit/i,
    message: 'Too many requests: the platform is limiting downloads. Try again later.',
  },
  {
    code: 'age_restricted',
    match: /\bconfirm your age\b|\bage[- ]restricted\b|\binappropriate for some users\b/i,
    message: 'Age-restricted: needs browser cookies.',
  },
  {
    code: 'bot_check',
    match: /\bnot a bot\b|\bcaptcha\b/i,
    message: "YouTube wants to check that you're not a bot. Try again later.",
  },
  {
    code: 'bot_check',
    // "This content isn’t available." without "try again later" is YouTube blocking the session or
    // account, not the hourly limit (yt-dlp issues #10085, #13583).
    match: /\bcontent isn['’]t available\b|\bIP is likely being blocked\b/i,
    message: 'YouTube is blocking requests from this connection. Try again later.',
  },
  {
    code: 'private',
    match: /\bprivate video\b/i,
    message: 'Private video.',
  },
  {
    code: 'private',
    match: /\bis private\b/i,
    message: 'Private: only its owner can see it.',
  },
  {
    code: 'login_required',
    match: /\bmembers[- ]only\b|\bchannel['’]s members\b/i,
    message: 'Members-only: needs a channel membership.',
  },
  {
    code: 'login_required',
    // raise_login_required's default text and the two login hints yt-dlp appends to it.
    match:
      /\bregistered users\b|\bprovide account credentials\b|\bfor the authentication\b|\bHTTP Error 401\b/i,
    message: 'Needs a login.',
  },
  {
    code: 'geo_blocked',
    // "blocked it in your country" is a label's copyright block, which YouTube words as a subreason
    // of "Video unavailable." (youtube-copyright-geo.log). Blocked everywhere stays `unavailable`.
    match:
      /\bavailable in your country\b|\bgeo[- ]?restrict|\bfrom your location\b|\bblocked it in your country\b/i,
    message: 'Not available in your country.',
  },
  {
    code: 'unavailable',
    match:
      /\bvideo unavailable\b|\b(?:video|track|content) is (?:unavailable|no longer available|not available)\b|\bhas been (?:removed|terminated)\b/i,
    message: 'Unavailable: removed or never existed.',
  },
  {
    code: 'unavailable',
    // SoundCloud answers 404 for deleted and private tracks alike.
    match: /\bdoes not exist\b|\bHTTP Error (?:404|410)\b/i,
    message: 'Not found: deleted, private, or a wrong link.',
  },
  {
    code: 'unknown',
    match: /\bHTTP Error 403\b/i,
    message: 'The platform refused the request (HTTP 403). Updating yt-dlp usually fixes this.',
  },
  {
    code: 'unknown',
    match: /\bRequested format is not available\b/i,
    message: `No downloadable audio format was found. ${UPDATE_HINT}`,
  },
  {
    code: 'postprocess_failed',
    match: /^Postprocessing:|\bconversion failed\b/i,
    message: 'Converting or tagging the audio failed.',
  },
  {
    code: 'network',
    match: /\bHTTP Error 5\d\d\b/i,
    message: 'The site had a temporary problem. Try again later.',
  },
  {
    code: 'network',
    // A transfer cut short: IncompleteRead's text without its class name (local-cut, often as a
    // transfer error), ContentTooShortError and its report, and an empty body (local-no-data).
    match:
      /\bbytes read, \d+ more expected\b|\bDownloaded \d+ bytes, expected \d+ bytes\b|\bcontent too short\b|\bDid not get any data blocks\b/i,
    message: 'The connection dropped during the download. Try again.',
  },
  {
    code: 'network',
    match:
      /\bunable to download\b|\btimed out\b|\bconnection (?:reset|refused|aborted)\b|\bfailed to (?:resolve|establish a new connection)\b|\bname resolution\b|\bnetwork is unreachable\b|\bremote end closed connection\b|\bTransportError\b|\bIncompleteRead\b|\bcertificate verify failed\b/i,
    message: "Couldn't connect. Check your internet connection and try again.",
  },
]

/** Consulted only when the ERROR lines map to `unknown`; same matching rules, on WARNING lines. */
export const WARNING_HINTS: readonly ErrorPattern[] = [
  {
    code: 'login_required',
    // soundcloud-401.log: the original-file 401 is only this warning, then a generic ERROR.
    match: /\bOriginal download format is only available for registered users\b/i,
    message: 'The original file needs a SoundCloud login.',
  },
]

const PART_FAILED = "Part of the file couldn't be downloaded. Try again."

/**
 * Checked before `ERROR_PATTERNS` for a transfer error: `[download] Got error: …` (a fragment that
 * failed all its retries, local-hls-404 and local-hls-429, or a plain download that gave up on a
 * 5xx), or `unable to download video data: …` (a plain download whose request was refused,
 * local-progressive-429). The track was found and its stream picked, so any other 4xx is a refused
 * or expired media request: worth a retry, never `unavailable` or a login.
 */
export const TRANSFER_PATTERNS: readonly ErrorPattern[] = [
  {
    code: 'rate_limited',
    match: /\bHTTP Error 429\b/i,
    message: 'Too many requests: the platform is limiting downloads. Try again later.',
  },
  {
    code: 'network',
    match: /^unable to download video data: HTTP Error (?:4\d\d|5\d\d)\b/i,
    message: 'The platform refused the download. Try again; if it keeps failing, update yt-dlp.',
  },
  {
    code: 'network',
    match: /\bHTTP Error (?:4\d\d|5\d\d)\b/i,
    message: PART_FAILED,
  },
]

/** Consulted only when no ERROR line maps to a specific code; same matching rules. */
export const FALLBACK_PATTERNS: readonly ErrorPattern[] = [
  {
    code: 'network',
    // The trailer after a fragment's transfer error, which says why.
    match: /\bfragment \d+ not found\b/i,
    message: PART_FAILED,
  },
]

/** Maps a non-zero yt-dlp exit to an error. Unknown failures become `unknown`, keeping yt-dlp's last ERROR line. */
export function mapYtdlpError({ stderr, exitCode, jobDir }: YtdlpFailure): ErrorInfo {
  const lines = splitLines(withoutPaths(stderr, jobDir))
  if (exitCode === 2) return optionsRejected(lines)

  const errors = errorReasons(lines)
  const last = errors.at(-1)
  if (last === undefined) return noErrorLine(lines, exitCode)

  const mapped = errors.map(
    (reason) =>
      (reason.transfer ? lookUp(reason, TRANSFER_PATTERNS) : undefined) ??
      lookUp(reason, ERROR_PATTERNS),
  )
  const specific = mapped.findLast((info) => info !== undefined && info.code !== 'unknown')
  if (specific) return specific
  const fallback = errors
    .map((reason) => lookUp(reason, FALLBACK_PATTERNS))
    .findLast((info) => info !== undefined)
  if (fallback) return fallback
  const hint = reasonsAfter(lines, 'WARNING:')
    .map((reason) => lookUp(reason, WARNING_HINTS))
    .findLast((info) => info !== undefined)
  if (hint) return hint
  return mapped.at(-1) ?? unknownFrom(last)
}

/** A SoundCloud Go+ track without a subscription (resolve marks it, the break filter stops it). */
export const PREVIEW_ONLY: ErrorInfo = {
  code: 'preview_only',
  message: 'Only a 30-second preview is available: the full track needs SoundCloud Go+.',
}

/** yt-dlp's exit code when `--max-downloads` or a `--break-*` option stopped the run. */
export const EXIT_STOPPED_EARLY = 101

export type DownloadFailure = YtdlpFailure & {
  /** The run passed `--break-match-filters` with the preview filter (SoundCloud downloads). */
  breakFilter: boolean
}

/**
 * Maps a failed download run (`downloadArgs`). The preview break filter stops a Go+ track silently
 * with exit 101: no ERROR line, nothing written (soundcloud-preview-break). Any other 101 is
 * unexpected, since downloads pass no other `--break-*` or `--max-downloads` option. A list URL
 * that got through can end the same way (soundcloud-list-break); the attempt tells it apart by
 * START's `playlist_id` before it maps the exit.
 */
export function mapDownloadExit({
  exitCode,
  stderr,
  breakFilter,
  jobDir,
}: DownloadFailure): ErrorInfo {
  if (exitCode !== EXIT_STOPPED_EARLY) return mapYtdlpError({ stderr, exitCode, jobDir })
  const hasError = splitLines(stderr).some((line) => line.startsWith('ERROR:'))
  if (breakFilter && !hasError) return PREVIEW_ONLY
  return {
    code: 'unknown',
    message: `yt-dlp stopped early without downloading the track (exit code ${EXIT_STOPPED_EARLY}).`,
  }
}

type Reason = {
  /** yt-dlp's message with whitespace collapsed and without its prefixes or bug-report tail. */
  text: string
  /** yt-dlp asked for a bug report, which usually means the extractor is out of date. */
  reportBug: boolean
  /**
   * A download's transfer error (`[download] Got error: …`, `unable to download video data: …`),
   * read with `TRANSFER_PATTERNS` first.
   */
  transfer?: boolean
}

/**
 * `FileDownloader.report_retry` gives up with `report_error('\r[download] Got error: …')`, so the
 * reason arrives as the line after an empty `ERROR: ` (yt_dlp/downloader/common.py, 2026.08.19).
 */
const TRANSFER_CONTINUATION = /^\[download\] Got error:\s*/
/**
 * `YoutubeDL.dl` reports a plain (non-fragment) download that failed outright as `unable to
 * download video data: <error>`: the media request, after a successful extraction.
 */
const MEDIA_DATA_FAILED = /^unable to download video data:/i

/**
 * `[youtube] jNQXAC9IVRw: `, `[soundcloud:user] some-user: `, `[DRM] `. Noise for humans, and an id
 * (e.g. `x-DRM-yz123`) must not match a pattern.
 */
const EXTRACTOR_PREFIX = /^\[[^\]]+\]\s*(?:[^\s:]+:\s+)?/
/** bug_reports_message(): "; please report this issue on  https://github.com/yt-dlp/…". */
const BUG_REPORT_TAIL = /;?\s*please report this issue on\b/i
/** optparse's last line on exit 2: "yt-dlp: error: no such option: --foo". */
const OPTION_ERROR = /^\S+: error: (.+)$/

function splitLines(stderr: string): string[] {
  return stderr.split(/\r\n|\r|\n/).map((line) => line.trimEnd())
}

/**
 * A quoted absolute path within one line, as Python's `OSError` prints it: `'/…'`, or `"/…"` when
 * the path holds a `'` (backslash escapes allowed).
 */
const QUOTED_PATH = /(['"])\/(?:\\.|(?!\1)[^\\\r\n])*\1/g

/** stderr without the job dir (`…/x.part`) and without quoted absolute paths (`'…'`). */
function withoutPaths(stderr: string, jobDir: string | undefined): string {
  const cut = jobDir === undefined || jobDir === '' ? stderr : stderr.split(jobDir).join('…')
  return cut.replace(QUOTED_PATH, (_path, quote: string) => `${quote}…${quote}`)
}

function reasonsAfter(lines: readonly string[], prefix: 'ERROR:' | 'WARNING:'): Reason[] {
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => reasonOf(line.slice(prefix.length)))
}

/**
 * The ERROR lines' reasons, an empty ERROR glued to the transfer error that follows it (or on the
 * same line, should the `\r` ever be gone).
 */
function errorReasons(lines: readonly string[]): Reason[] {
  return lines.flatMap((line, index) => {
    if (!line.startsWith('ERROR:')) return []
    const raw = line.slice('ERROR:'.length).trim()
    const next = lines[index + 1]
    const transfer =
      raw === '' && next !== undefined && TRANSFER_CONTINUATION.test(next) ? next : raw
    if (!TRANSFER_CONTINUATION.test(transfer)) {
      const reason = reasonOf(raw)
      return [MEDIA_DATA_FAILED.test(reason.text) ? { ...reason, transfer: true } : reason]
    }
    return [{ ...reasonOf(transfer.replace(TRANSFER_CONTINUATION, '')), transfer: true }]
  })
}

/** A line worth quoting when there is no ERROR line: not blank, not a download's `PP …` line. */
const quotable = (line: string) => line.trim() !== '' && !POSTPROCESS_LINE.test(line)

function reasonOf(raw: string): Reason {
  let text = raw.trim().replace(EXTRACTOR_PREFIX, '')
  const tail = BUG_REPORT_TAIL.exec(text)
  if (tail) text = text.slice(0, tail.index)
  return { text: text.replace(/\s+/g, ' ').trim(), reportBug: tail !== null }
}

function lookUp(reason: Reason, table: readonly ErrorPattern[]): ErrorInfo | undefined {
  const row = table.find((pattern) => pattern.match.test(reason.text))
  return row && { code: row.code, message: row.message }
}

function unknownFrom({ text, reportBug }: Reason): ErrorInfo {
  if (text === '') return { code: 'unknown', message: 'yt-dlp reported an error without details.' }
  const quoted = `yt-dlp: ${sentence(quote(text))}`
  return { code: 'unknown', message: reportBug ? `${quoted} ${UPDATE_HINT}` : quoted }
}

/** Killed, crashed (a Python traceback) or exited with warnings only: say so, with its last words. */
function noErrorLine(lines: readonly string[], exitCode: number | null): ErrorInfo {
  const lastLine = lines.findLast(quotable)
  const detail = lastLine === undefined ? '' : reasonOf(lastLine.replace(/^WARNING:/, '')).text
  const what =
    exitCode === null
      ? 'yt-dlp was stopped before it finished'
      : `yt-dlp failed (exit code ${exitCode})`
  if (detail !== '') return { code: 'unknown', message: `${what}: ${sentence(quote(detail))}` }
  return {
    code: 'unknown',
    message: exitCode === null ? `${what}.` : `${what} without an error message.`,
  }
}

function optionsRejected(lines: readonly string[]): ErrorInfo {
  const detail =
    lines.map((line) => OPTION_ERROR.exec(line)?.[1]).findLast((text) => text !== undefined) ??
    lines.findLast(quotable)?.trim()
  const why = detail === undefined ? '' : ` (${quote(detail)})`
  return {
    code: 'unknown',
    message: `yt-dlp rejected DJ Scraper's options${why}. Update yt-dlp; if that doesn't help, this is a bug in DJ Scraper.`,
  }
}

function quote(text: string): string {
  const chars = Array.from(text)
  if (chars.length <= MAX_QUOTED_LENGTH) return text
  return `${chars
    .slice(0, MAX_QUOTED_LENGTH - 1)
    .join('')
    .trimEnd()}…`
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`
}
