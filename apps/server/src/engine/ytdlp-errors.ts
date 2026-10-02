import { type ErrorCode, type ErrorInfo, urlRejectionMessage } from '@dj-scraper/shared'

/**
 * Pure: a failed yt-dlp run → a typed `ErrorInfo` with a message written for humans
 * ("Private video.", "Not available in your country.", …). Every pattern is backed by a fixture in
 * test/fixtures/errors/ (see its README for which ones are recorded and which are synthetic).
 *
 * How stderr is read:
 * - Exit code 2 is an option error: yt-dlp rejected our argv before doing anything. That is a bug
 *   on our side, or a yt-dlp too old to know a flag we pass.
 * - Only `ERROR:` lines decide. yt-dlp puts the reason on the ERROR line itself; the lines after it
 *   (geo's "This video is available in …", "You might want to use a VPN …") only add advice.
 * - With several ERROR lines, the LAST one that maps to a specific code wins. yt-dlp prints the
 *   failure that ended the run last, and a trailing generic ERROR mustn't hide an earlier reason.
 * - WARNING lines decide only through `WARNING_HINTS`, and only when the ERROR itself is generic
 *   (it maps to `unknown`). Each hint has a fixture where yt-dlp reports the real reason as a
 *   warning only; e.g. SoundCloud's 401 for original files is a WARNING plus "Requested format is
 *   not available".
 * - `preview_only` never comes from stderr. yt-dlp doesn't treat a Go+ preview as an error: a
 *   `--match-filters` rejection is silent in quiet mode (preview-filter.log is stdout under
 *   `--no-quiet`), and an excluding `-f` gives the generic "Requested format is not available"
 *   (preview-format-unavailable.log). Detect previews from the formats instead.
 * - The text is assumed free of ANSI codes, because `baseArgs` always passes `--color never`.
 */

export type YtdlpFailure = {
  stderr: string
  exitCode: number | null
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

/**
 * Checked in order; the first match wins, so the more specific rows come first:
 * - The URL is the only user-controlled text that can appear in a reason, so its row is first.
 * - Rate limits go before `unavailable`: YouTube's start with "Video unavailable."
 * - The age and bot checks go before the login catch-all: all three say "Sign in" and "cookies".
 * - `private` goes before login: "Private video. Sign in if you've been granted access …".
 * - `geo_blocked` goes before `unavailable`: "This video is not available from your location", and
 *   YouTube's "Video unavailable. … who has blocked it in your country on copyright grounds."
 * - `engine_missing` goes before `postprocess_failed`: "Postprocessing: ffprobe and ffmpeg not found".
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

/** Maps a non-zero yt-dlp exit to an error. Unknown failures become `unknown`, keeping yt-dlp's last ERROR line. */
export function mapYtdlpError({ stderr, exitCode }: YtdlpFailure): ErrorInfo {
  const lines = stderr.split(/\r\n|\r|\n/).map((line) => line.trimEnd())
  if (exitCode === 2) return optionsRejected(lines)

  const errors = reasonsAfter(lines, 'ERROR:')
  const last = errors.at(-1)
  if (last === undefined) return noErrorLine(lines, exitCode)

  const mapped = errors.map((reason) => lookUp(reason, ERROR_PATTERNS))
  const specific = mapped.findLast((info) => info !== undefined && info.code !== 'unknown')
  if (specific) return specific
  const hint = reasonsAfter(lines, 'WARNING:')
    .map((reason) => lookUp(reason, WARNING_HINTS))
    .findLast((info) => info !== undefined)
  if (hint) return hint
  return mapped.at(-1) ?? unknownFrom(last)
}

type Reason = {
  /** yt-dlp's message with whitespace collapsed and without its prefixes or bug-report tail. */
  text: string
  /** yt-dlp asked for a bug report, which usually means the extractor is out of date. */
  reportBug: boolean
}

/**
 * `[youtube] jNQXAC9IVRw: `, `[soundcloud:user] some-user: `, `[DRM] `. Noise for humans, and an id
 * (e.g. `x-DRM-yz123`) must not match a pattern.
 */
const EXTRACTOR_PREFIX = /^\[[^\]]+\]\s*(?:[^\s:]+:\s+)?/
/** bug_reports_message(): "; please report this issue on  https://github.com/yt-dlp/…". */
const BUG_REPORT_TAIL = /;?\s*please report this issue on\b/i
/** optparse's last line on exit 2: "yt-dlp: error: no such option: --foo". */
const OPTION_ERROR = /^\S+: error: (.+)$/

function reasonsAfter(lines: readonly string[], prefix: 'ERROR:' | 'WARNING:'): Reason[] {
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => reasonOf(line.slice(prefix.length)))
}

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
  const lastLine = lines.findLast((line) => line.trim() !== '')
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
    lines.findLast((line) => line.trim() !== '')?.trim()
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
