import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type ErrorCode, ErrorInfoSchema } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { baseArgs } from './ytdlp-args.ts'
import {
  type DownloadFailure,
  ERROR_PATTERNS,
  FALLBACK_PATTERNS,
  MAX_QUOTED_LENGTH,
  mapDownloadExit,
  mapYtdlpError,
  TRANSFER_PATTERNS,
  WARNING_HINTS,
  type YtdlpFailure,
} from './ytdlp-errors.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/errors')
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')
const downloadsDir = path.resolve(import.meta.dirname, '../../test/fixtures/downloads')
const downloadStderr = (name: string) =>
  readFileSync(path.join(downloadsDir, `${name}.stderr.log`), 'utf8')

/** Maps, and checks the result against the contract every caller relies on. */
const map = (failure: YtdlpFailure) => ErrorInfoSchema.parse(mapYtdlpError(failure))
const mapStderr = (stderr: string, exitCode: number | null = 1) => map({ stderr, exitCode })
const mapDownload = (failure: DownloadFailure) => ErrorInfoSchema.parse(mapDownloadExit(failure))

/** Every errors/*.log with the exit code it was recorded with (README) and the code it must map to. */
const FIXTURES: Record<string, { exitCode: number; code: ErrorCode }> = {
  'bad-option.log': { exitCode: 2, code: 'unknown' },
  'connection-refused.log': { exitCode: 1, code: 'network' },
  'dns.log': { exitCode: 1, code: 'network' },
  'drm.log': { exitCode: 1, code: 'unsupported_url' },
  'ffmpeg-missing.log': { exitCode: 1, code: 'engine_missing' },
  'interrupted.log': { exitCode: 1, code: 'canceled' },
  'invalid-url.log': { exitCode: 1, code: 'invalid_url' },
  'local-cut.log': { exitCode: 1, code: 'network' },
  'local-enospc-hls.log': { exitCode: 1, code: 'disk_full' },
  'local-enospc-open.log': { exitCode: 1, code: 'disk_full' },
  'local-enospc-write.log': { exitCode: 1, code: 'disk_full' },
  'local-no-data.log': { exitCode: 1, code: 'network' },
  'network-timeout.log': { exitCode: 1, code: 'network' },
  'postprocess-conversion.log': { exitCode: 1, code: 'postprocess_failed' },
  'postprocess-no-codec.log': { exitCode: 1, code: 'postprocess_failed' },
  // stdout under --no-quiet, exit 0: the real (quiet) argv prints nothing, so no stderr signal.
  'preview-filter.log': { exitCode: 0, code: 'unknown' },
  'preview-format-unavailable.log': { exitCode: 1, code: 'unknown' },
  'soundcloud-401.log': { exitCode: 1, code: 'login_required' },
  'soundcloud-404.log': { exitCode: 1, code: 'unavailable' },
  'soundcloud-429-info.log': { exitCode: 1, code: 'rate_limited' },
  'soundcloud-429.log': { exitCode: 1, code: 'rate_limited' },
  'soundcloud-geo-blocked.log': { exitCode: 1, code: 'geo_blocked' },
  'soundcloud-metadata-only.log': { exitCode: 0, code: 'unknown' },
  'soundcloud-no-formats.log': { exitCode: 1, code: 'unknown' },
  'soundcloud-user-missing.log': { exitCode: 1, code: 'unavailable' },
  'unknown.log': { exitCode: 1, code: 'unknown' },
  'unsupported.log': { exitCode: 1, code: 'unsupported_url' },
  'youtube-age-restricted.log': { exitCode: 1, code: 'age_restricted' },
  'youtube-bot-check.log': { exitCode: 1, code: 'bot_check' },
  'youtube-content-unavailable.log': { exitCode: 1, code: 'bot_check' },
  'youtube-copyright-geo.log': { exitCode: 1, code: 'geo_blocked' },
  'youtube-geo-blocked.log': { exitCode: 1, code: 'geo_blocked' },
  'youtube-members-only-level.log': { exitCode: 1, code: 'login_required' },
  'youtube-members-only.log': { exitCode: 1, code: 'login_required' },
  'youtube-mix-playlist-url.log': { exitCode: 1, code: 'unsupported_url' },
  'youtube-mix-unrecognized.log': { exitCode: 0, code: 'unknown' },
  'youtube-playlist-missing.log': { exitCode: 1, code: 'unavailable' },
  'youtube-private.log': { exitCode: 1, code: 'private' },
  'youtube-rate-limited.log': { exitCode: 1, code: 'rate_limited' },
  'youtube-removed.log': { exitCode: 1, code: 'unavailable' },
  'youtube-unavailable.log': { exitCode: 1, code: 'unavailable' },
}

describe('mapYtdlpError on recorded and synthetic stderr', () => {
  it('has an expectation for every fixture in test/fixtures/errors', () => {
    const logs = readdirSync(fixturesDir).filter((name) => name.endsWith('.log'))
    expect(Object.keys(FIXTURES).sort()).toEqual(logs.sort())
  })

  it.each(Object.entries(FIXTURES))('%s → %o', (name, { exitCode, code }) => {
    expect(map({ stderr: fixture(name), exitCode }).code).toBe(code)
  })

  it('also maps every fixture the same way with CRLF line endings', () => {
    for (const [name, { exitCode, code }] of Object.entries(FIXTURES)) {
      const stderr = fixture(name).replaceAll('\n', '\r\n')
      expect(map({ stderr, exitCode }).code, name).toBe(code)
    }
  })

  it('uses the wording the product asks for', () => {
    const message = (name: string) => mapStderr(fixture(name)).message
    expect(message('youtube-private.log')).toBe('Private video.')
    expect(message('youtube-geo-blocked.log')).toBe('Not available in your country.')
    expect(message('youtube-copyright-geo.log')).toBe('Not available in your country.')
    expect(message('soundcloud-geo-blocked.log')).toBe('Not available in your country.')
    expect(message('youtube-age-restricted.log')).toBe('Age-restricted: needs browser cookies.')
  })

  it('never echoes the URL of an unsupported link', () => {
    expect(mapStderr(fixture('unsupported.log')).message).not.toContain('example.com')
  })

  it('tells the hourly YouTube limit apart from a blocked session and a generic 429', () => {
    const limited = mapStderr(fixture('youtube-rate-limited.log'))
    const blocked = mapStderr(fixture('youtube-content-unavailable.log'))
    const http429 = mapStderr(fixture('soundcloud-429.log'))
    expect(limited).toMatchObject({ code: 'rate_limited', message: expect.stringMatching(/hour/) })
    expect(blocked).toMatchObject({ code: 'bot_check', message: expect.stringMatching(/blocking/) })
    expect(http429.message).not.toBe(limited.message)
  })

  it('names the SoundCloud login when the original file needs one', () => {
    expect(mapStderr(fixture('soundcloud-401.log')).message).toBe(
      'The original file needs a SoundCloud login.',
    )
  })

  it('quotes an unknown ERROR without its prefixes or bug-report tail, and suggests an update', () => {
    expect(mapStderr(fixture('unknown.log')).message).toBe(
      'yt-dlp: Failed to extract any player response. Updating yt-dlp may help.',
    )
    expect(mapStderr(fixture('soundcloud-no-formats.log')).message).toBe(
      'yt-dlp: No video formats found! Updating yt-dlp may help.',
    )
  })

  it('gives a generic format miss a readable message instead of --list-formats advice', () => {
    const { message } = mapStderr(fixture('preview-format-unavailable.log'))
    expect(message).not.toContain('--list-formats')
    expect(message).toMatch(/audio format/)
  })
})

/**
 * Every failed run in test/fixtures/downloads (its .stderr.log), with the exit code it was recorded
 * with (README), whether the run passed the preview break filter (SoundCloud), and the code
 * `mapDownloadExit` must give it.
 */
const DOWNLOAD_FAILURES: Record<
  string,
  { exitCode: number; breakFilter: boolean; code: ErrorCode }
> = {
  'local-hls-404': { exitCode: 1, breakFilter: false, code: 'network' },
  'local-hls-429': { exitCode: 1, breakFilter: false, code: 'rate_limited' },
  'local-hls-429-abort-r1': { exitCode: 1, breakFilter: false, code: 'rate_limited' },
  'local-hls-missing-abort': { exitCode: 1, breakFilter: false, code: 'network' },
  'local-http-429': { exitCode: 1, breakFilter: false, code: 'rate_limited' },
  'local-progressive-429': { exitCode: 1, breakFilter: false, code: 'rate_limited' },
  'soundcloud-preview-break': { exitCode: 101, breakFilter: true, code: 'preview_only' },
  // A preview row ends a list run the same way; the attempt reads START's playlist_id first.
  'soundcloud-list-break': { exitCode: 101, breakFilter: true, code: 'preview_only' },
  'youtube-cancel-download': { exitCode: 1, breakFilter: false, code: 'canceled' },
  'youtube-cancel-fixup': { exitCode: 1, breakFilter: false, code: 'canceled' },
}
/** The download cases that exited 0: an attempt never maps their stderr. */
const DOWNLOAD_SUCCESSES = [
  'local-hls-missing',
  'local-hls-missing-noquiet',
  'soundcloud-ba',
  'soundcloud-hls',
  'soundcloud-hls-aac',
  'soundcloud-list',
  'youtube-ba',
  'youtube-ba-nothumb',
  'youtube-ba-wait',
  'youtube-m4a',
]

describe('mapDownloadExit on the recorded downloads', () => {
  it('knows every case in test/fixtures/downloads as a failure to map or a success', () => {
    const cases = new Set(
      readdirSync(downloadsDir)
        .filter((name) => name.endsWith('.stderr.log'))
        .map((name) => name.slice(0, -'.stderr.log'.length)),
    )
    const known = [...Object.keys(DOWNLOAD_FAILURES), ...DOWNLOAD_SUCCESSES]
    expect(known.toSorted()).toEqual([...cases].toSorted())
    expect(new Set(known).size).toBe(known.length)
  })

  it.each(Object.entries(DOWNLOAD_FAILURES))('%s → %o', (name, { exitCode, breakFilter, code }) => {
    expect(mapDownload({ stderr: downloadStderr(name), exitCode, breakFilter }).code).toBe(code)
  })

  it('maps them the same way with CRLF line endings, and as run.ts lines joined with \\n', () => {
    for (const [name, { exitCode, breakFilter, code }] of Object.entries(DOWNLOAD_FAILURES)) {
      const raw = downloadStderr(name)
      const crlf = raw.replaceAll('\n', '\r\n')
      const joined = raw.split(/\r\n|\r|\n/).join('\n')
      for (const stderr of [crlf, joined]) {
        expect(mapDownload({ stderr, exitCode, breakFilter }).code, name).toBe(code)
      }
    }
  })

  it('maps the non-101 failures exactly like mapYtdlpError', () => {
    for (const [name, { exitCode, breakFilter }] of Object.entries(DOWNLOAD_FAILURES)) {
      if (exitCode === 101) continue
      const stderr = downloadStderr(name)
      expect(mapDownload({ stderr, exitCode, breakFilter }), name).toEqual(
        map({ stderr, exitCode }),
      )
    }
  })

  it('says a fragment failed, not that the track is gone, on an HLS 404 (local-hls-404)', () => {
    const stderr = downloadStderr('local-hls-404')
    expect(mapDownload({ stderr, exitCode: 1, breakFilter: false })).toEqual({
      code: 'network',
      message: "Part of the file couldn't be downloaded. Try again.",
    })
  })

  it('reads an HLS 429 as the platform limiting downloads (local-hls-429)', () => {
    const stderr = downloadStderr('local-hls-429')
    expect(mapDownload({ stderr, exitCode: 1, breakFilter: false })).toEqual({
      code: 'rate_limited',
      message: 'Too many requests: the platform is limiting downloads. Try again later.',
    })
  })

  it('names the Go+ preview when the break filter stopped the run (soundcloud-preview-break)', () => {
    expect(mapDownload({ stderr: '', exitCode: 101, breakFilter: true })).toEqual({
      code: 'preview_only',
      message: 'Only a 30-second preview is available: the full track needs SoundCloud Go+.',
    })
  })
})

describe('mapDownloadExit', () => {
  it('reads exit 101 as unexpected without the break filter, never as a preview', () => {
    expect(mapDownload({ stderr: '', exitCode: 101, breakFilter: false })).toEqual({
      code: 'unknown',
      message: 'yt-dlp stopped early without downloading the track (exit code 101).',
    })
  })

  it('reads exit 101 with an ERROR line as unexpected, even with the break filter', () => {
    const stderr = 'ERROR: [soundcloud] 123: Something new and strange'
    expect(mapDownload({ stderr, exitCode: 101, breakFilter: true }).code).toBe('unknown')
  })

  it('never reads a silent failure other than 101 as a preview', () => {
    expect(mapDownload({ stderr: '', exitCode: 1, breakFilter: true })).toEqual({
      code: 'unknown',
      message: 'yt-dlp failed (exit code 1) without an error message.',
    })
    expect(mapDownload({ stderr: '', exitCode: null, breakFilter: true }).code).toBe('unknown')
  })

  it('keeps exit 2 an option error', () => {
    expect(
      mapDownload({ stderr: fixture('bad-option.log'), exitCode: 2, breakFilter: true }).message,
    ).toMatch(/rejected DJ Scraper's options/)
  })

  it('never quotes a PP line as the last words of a run without an ERROR line', () => {
    const stderr = downloadStderr('soundcloud-list-break')
    expect(mapDownload({ stderr, exitCode: 1, breakFilter: true })).toEqual({
      code: 'unknown',
      message: 'yt-dlp failed (exit code 1) without an error message.',
    })
    expect(
      mapStderr('WARNING: [soundcloud] something odd\nPP MoveFiles finished', null).message,
    ).toBe('yt-dlp was stopped before it finished: something odd.')
  })
})

describe('mapYtdlpError: download transfer errors', () => {
  /** What a fragment's give-up looks like on stderr (local-hls-404), for any HTTP status. */
  const fragmentFailure = (error: string, retries = 3) =>
    `ERROR: \r[download] Got error: ${error}. Giving up after ${retries} retries\nERROR: fragment 3 not found, unable to continue\n`

  it.each([
    ['HTTP Error 403: Forbidden', 'network'],
    ['HTTP Error 404: Not Found', 'network'],
    ['HTTP Error 410: Gone', 'network'],
    ['HTTP Error 401: Unauthorized', 'network'],
    ['HTTP Error 500: Internal Server Error', 'network'],
    ['HTTP Error 503: Service Unavailable', 'network'],
    ['HTTP Error 429: Too Many Requests', 'rate_limited'],
    ['The read operation timed out', 'network'],
  ] as const)('maps a fragment that failed with %s to %s', (error, code) => {
    expect(mapStderr(fragmentFailure(error)).code).toBe(code)
  })

  it('reads a fragment 404 as a failed part even though a 404 elsewhere means "not found"', () => {
    const fragment = mapStderr(fragmentFailure('HTTP Error 404: Not Found'))
    const page = mapStderr(fixture('soundcloud-404.log'))
    expect(fragment.code).toBe('network')
    expect(page.code).toBe('unavailable')
  })

  it('glues a transfer error without retries (no "Giving up")', () => {
    const stderr = 'ERROR: \r[download] Got error: HTTP Error 429: Too Many Requests\n'
    expect(mapStderr(stderr).code).toBe('rate_limited')
  })

  it('glues a plain download that gave up on a 5xx', () => {
    const stderr =
      'ERROR: \r[download] Got error: HTTP Error 502: Bad Gateway. Giving up after 3 retries\n'
    expect(mapStderr(stderr).code).toBe('network')
  })

  it('quotes an unrecognized transfer error without its [download] prefix', () => {
    const stderr =
      'ERROR: \r[download] Got error: Conflicting range. (start=9 > end=3). Giving up after 3 retries'
    expect(mapStderr(stderr)).toEqual({
      code: 'unknown',
      message: 'yt-dlp: Conflicting range. (start=9 > end=3). Giving up after 3 retries.',
    })
  })

  it('reads the fragment trailer alone as a network failure', () => {
    const stderr = 'ERROR: fragment 3 not found, unable to continue'
    expect(mapStderr(stderr)).toEqual({
      code: 'network',
      message: "Part of the file couldn't be downloaded. Try again.",
    })
  })

  it('lets a specific ERROR win over the generic fragment trailer, wherever it is', () => {
    const before =
      'ERROR: [youtube] abcdefghijk: Private video\nERROR: fragment 3 not found, unable to continue'
    const after =
      'ERROR: fragment 3 not found, unable to continue\nERROR: [youtube] abcdefghijk: Private video'
    expect(mapStderr(before).code).toBe('private')
    expect(mapStderr(after).code).toBe('private')
  })

  it('lets the fragment trailer win over a generic ERROR and a WARNING hint', () => {
    const stderr = [
      'WARNING: [soundcloud] Original download format is only available for registered users.',
      'ERROR: [soundcloud] 1: Something new and strange',
      'ERROR: fragment 3 not found, unable to continue',
    ].join('\n')
    expect(mapStderr(stderr).code).toBe('network')
  })

  it('glues only the [download] Got error line after an empty ERROR', () => {
    expect(mapStderr('ERROR: \n[youtube] abc: HTTP Error 404: Not Found').message).toBe(
      'yt-dlp reported an error without details.',
    )
    expect(mapStderr('ERROR: \nWARNING: [download] Got error: HTTP Error 404').message).toBe(
      'yt-dlp reported an error without details.',
    )
  })

  it('reads a transfer error on the ERROR line itself, should the \\r ever be gone', () => {
    expect(mapStderr('ERROR: [download] Got error: HTTP Error 404: Not Found').code).toBe('network')
  })

  // Synthetic, in the shape of local-progressive-429: a plain (non-fragment) download whose media
  // request failed after the track was found. Only a 429 is a rate limit; the rest is retryable.
  it.each([
    ['HTTP Error 404: Not Found', 'network'],
    ['HTTP Error 410: Gone', 'network'],
    ['HTTP Error 403: Forbidden', 'network'],
    ['HTTP Error 401: Unauthorized', 'network'],
    ['HTTP Error 502: Bad Gateway', 'network'],
    ['HTTP Error 429: Too Many Requests', 'rate_limited'],
  ] as const)('maps a plain download refused with %s to %s, never "removed"', (error, code) => {
    const stderr = `ERROR: unable to download video data: ${error}\n`
    expect(mapStderr(stderr).code).toBe(code)
    expect(mapDownload({ stderr, exitCode: 1, breakFilter: true }).code).toBe(code)
  })

  it('words a refused plain download as worth a retry', () => {
    expect(mapStderr('ERROR: unable to download video data: HTTP Error 404: Not Found')).toEqual({
      code: 'network',
      message: 'The platform refused the download. Try again; if it keeps failing, update yt-dlp.',
    })
  })

  it('keeps a 404 that is no transfer error a missing track', () => {
    const stderr =
      'ERROR: [soundcloud] 1: Unable to download JSON metadata: HTTP Error 404: Not Found'
    expect(mapStderr(stderr).code).toBe('unavailable')
  })
})

describe('mapYtdlpError: a full disk, a cut connection, and paths', () => {
  const JOB =
    '/Users/dj/Library/Application Support/DJ Scraper/jobs/0b7d5c2e-0000-4000-8000-000000000001'
  /** A recording from test/fixtures/errors with its job dir put back. */
  const withJobDir = (name: string) => fixture(name).replaceAll('{JOBDIR}', JOB)
  const DISK_FULL = { code: 'disk_full', message: "The drive with DJ Scraper's data is full." }

  it.each(['local-enospc-write.log', 'local-enospc-open.log', 'local-enospc-hls.log'])(
    'reads %s as the data drive being full, without the path',
    (name) => {
      const stderr = withJobDir(name)
      expect(mapStderr(stderr)).toEqual(DISK_FULL)
      expect(mapDownload({ stderr, exitCode: 1, breakFilter: false, jobDir: JOB })).toEqual(
        DISK_FULL,
      )
    },
  )

  it.each([
    // macOS's EDQUOT (errno 69) and its strerror; Linux spells it "Disk".
    'ERROR: unable to write data: [Errno 69] Disc quota exceeded',
    'ERROR: unable to write data: OSError: Disk quota exceeded',
    // A fixup's ffmpeg on a full disk (ffmpeg 8's last line, as yt-dlp quotes it).
    'ERROR: Postprocessing: Error closing file: No space left on device',
  ])('reads %j as the data drive being full', (stderr) => {
    expect(mapStderr(stderr)).toEqual(DISK_FULL)
  })

  it('reads a cut transfer as a dropped connection (local-cut, local-no-data)', () => {
    const dropped = {
      code: 'network',
      message: 'The connection dropped during the download. Try again.',
    }
    expect(mapStderr(fixture('local-cut.log'))).toEqual(dropped)
    expect(mapStderr(fixture('local-no-data.log'))).toEqual(dropped)
    // ContentTooShortError (utils/_utils.py) through a retry, and YoutubeDL's own report of it.
    expect(
      mapStderr(
        'ERROR: \r[download] Got error: Downloaded 50000 bytes, expected 97009 bytes. Giving up after 3 retries\n',
      ),
    ).toEqual(dropped)
    expect(mapStderr('ERROR: content too short (expected 97009 bytes and served 50000)')).toEqual(
      dropped,
    )
    // With the class name, as a webpage request reports it.
    expect(
      mapStderr(
        'ERROR: [generic] x: Unable to download webpage: IncompleteRead(512 bytes read, 10 more expected)',
      ),
    ).toEqual(dropped)
  })

  it('never quotes the job dir or a quoted absolute path', () => {
    const denied = `ERROR: unable to open for writing: [Errno 13] Permission denied: '${JOB}/big.mp3.part'`
    expect(mapDownload({ stderr: denied, exitCode: 1, breakFilter: false, jobDir: JOB })).toEqual({
      code: 'unknown',
      message:
        "yt-dlp: unable to open for writing: [Errno 13] Permission denied: '…/big.mp3.part'.",
    })
    // Without the job dir, any quoted absolute path goes.
    expect(mapStderr(denied).message).toBe(
      "yt-dlp: unable to open for writing: [Errno 13] Permission denied: '…'.",
    )
    // Python quotes a path holding a ' with double quotes.
    expect(
      mapStderr(`ERROR: unable to rename file: [Errno 2] No such file: "/Users/O'Brien/a b.part"`)
        .message,
    ).toBe('yt-dlp: unable to rename file: [Errno 2] No such file: "…".')
    // Unquoted, the job dir is still cut.
    expect(
      mapDownload({
        stderr: `ERROR: Odd failure in ${JOB}/x.webm.part`,
        exitCode: 1,
        breakFilter: false,
        jobDir: JOB,
      }).message,
    ).toBe('yt-dlp: Odd failure in …/x.webm.part.')
    // The last words of a run without an ERROR line, and an option error.
    const traceback = `Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: '${JOB}/a.part'`
    expect(mapStderr(traceback).message).toBe(
      "yt-dlp failed (exit code 1): PermissionError: [Errno 13] Permission denied: '…'.",
    )
    expect(map({ stderr: `yt-dlp: error: bad path '${JOB}'`, exitCode: 2 }).message).not.toContain(
      'Application Support',
    )
  })

  it('reads the reason, never the path: a folder named like a reason matches nothing', () => {
    const stderr =
      "ERROR: unable to open for writing: [Errno 13] Permission denied: '/Volumes/No space left on device/Private video/a.part'"
    expect(mapStderr(stderr)).toEqual({
      code: 'unknown',
      message: "yt-dlp: unable to open for writing: [Errno 13] Permission denied: '…'.",
    })
  })
})

describe('mapYtdlpError: what decides', () => {
  it('ignores WARNING lines when there is no ERROR line, even ones that name a reason', () => {
    const stderr = [
      'WARNING: [youtube] abc: Private video',
      'WARNING: [soundcloud] Original download format is only available for registered users.',
    ].join('\n')
    expect(mapStderr(stderr)).toEqual({
      code: 'unknown',
      message:
        'yt-dlp failed (exit code 1): Original download format is only available for registered users.',
    })
  })

  it('lets the last specific ERROR decide when there are several', () => {
    const stderr = [
      'ERROR: [youtube] aaaaaaaaaaa: Private video',
      'ERROR: [youtube] bbbbbbbbbbb: This video is unavailable',
    ].join('\n')
    expect(mapStderr(stderr).code).toBe('unavailable')
  })

  it("doesn't let a trailing generic ERROR hide an earlier specific one", () => {
    const stderr = [
      'ERROR: [youtube] aaaaaaaaaaa: Private video',
      'ERROR: [youtube] aaaaaaaaaaa: Requested format is not available. Use --list-formats …',
      'ERROR: [youtube] aaaaaaaaaaa: Something new and strange',
    ].join('\n')
    expect(mapStderr(stderr).code).toBe('private')
  })

  it('quotes the last ERROR when none of them is recognized', () => {
    const stderr = 'ERROR: [youtube] a: First oddity\nERROR: [youtube] b: Second oddity\n'
    expect(mapStderr(stderr).message).toBe('yt-dlp: Second oddity.')
  })

  it('applies a WARNING hint only to refine a generic ERROR', () => {
    const warning =
      'WARNING: [soundcloud] Original download format is only available for registered users.'
    const generic = `${warning}\nERROR: [soundcloud] 1: Requested format is not available.`
    const specific = `${warning}\nERROR: [soundcloud] 1: Unable to download JSON metadata: HTTP Error 404: Not Found`
    expect(mapStderr(generic).code).toBe('login_required')
    expect(mapStderr(specific).code).toBe('unavailable')
  })

  it('reads the reason, not the extractor id, so an id never matches a pattern', () => {
    expect(mapStderr('ERROR: [youtube] x-DRM-yz123: Something new and strange').code).toBe(
      'unknown',
    )
    expect(mapStderr('ERROR: [DRM] The requested site is known to use DRM protection.').code).toBe(
      'unsupported_url',
    )
  })

  it('reads an ERROR line that contains WARNING: as an ERROR', () => {
    expect(mapStderr(fixture('postprocess-no-codec.log')).code).toBe('postprocess_failed')
  })

  it('keeps private ahead of the login catch-all, which the private reason also matches', () => {
    const stderr =
      "ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication."
    expect(mapStderr(stderr)).toEqual({ code: 'private', message: 'Private video.' })
  })

  it('keeps geo ahead of unavailable for a YouTube reason that starts with "Video unavailable."', () => {
    const stderr =
      'ERROR: [youtube] abcdefghijk: Video unavailable. The uploader has not made this video available in your country'
    expect(mapStderr(stderr).code).toBe('geo_blocked')
  })

  it('reads a label blocking a video in your country as geo, and everywhere as unavailable', () => {
    const reason = (where: string) =>
      `ERROR: [youtube] abcdefghijk: Video unavailable. This video contains content from SME, who has blocked it${where} on copyright grounds.`
    expect(mapStderr(reason(' in your country'))).toEqual({
      code: 'geo_blocked',
      message: 'Not available in your country.',
    })
    expect(mapStderr(reason('')).code).toBe('unavailable')
  })

  it('reads a lone CR as a line break too', () => {
    expect(mapStderr('WARNING: something\rERROR: [youtube] abcdefghijk: Private video').code).toBe(
      'private',
    )
  })
})

describe('mapYtdlpError without a usable ERROR line', () => {
  it('blames our options on exit code 2, quoting what yt-dlp rejected', () => {
    const { code, message } = map({ stderr: fixture('bad-option.log'), exitCode: 2 })
    expect(code).toBe('unknown')
    expect(message).toBe(
      "yt-dlp rejected DJ Scraper's options (no such option: --no-such-option). Update yt-dlp; if that doesn't help, this is a bug in DJ Scraper.",
    )
  })

  it('treats exit code 2 as an option error even when stderr looks like something else', () => {
    const { code, message } = map({ stderr: 'ERROR: [youtube] a: Private video', exitCode: 2 })
    expect(code).toBe('unknown')
    expect(message).toMatch(/rejected DJ Scraper's options/)
  })

  it('still explains exit code 2 when stderr is empty', () => {
    expect(map({ stderr: '', exitCode: 2 }).message).toBe(
      "yt-dlp rejected DJ Scraper's options. Update yt-dlp; if that doesn't help, this is a bug in DJ Scraper.",
    )
  })

  it('says the process was stopped when it was killed without output', () => {
    expect(map({ stderr: '', exitCode: null })).toEqual({
      code: 'unknown',
      message: 'yt-dlp was stopped before it finished.',
    })
  })

  it('quotes the last non-empty line when it was killed mid-run', () => {
    const stderr = 'WARNING: [youtube] abcdefghijk: Some formats may be missing\n\n  \n'
    expect(map({ stderr, exitCode: null }).message).toBe(
      'yt-dlp was stopped before it finished: Some formats may be missing.',
    )
  })

  it('still maps an ERROR line when the exit code is null', () => {
    expect(map({ stderr: fixture('youtube-private.log'), exitCode: null }).code).toBe('private')
  })

  it('quotes the last line of a crash (a Python traceback)', () => {
    const stderr = [
      'Traceback (most recent call last):',
      '  File "yt_dlp/__main__.py", line 17, in <module>',
      "KeyError: 'formats'",
    ].join('\n')
    expect(mapStderr(stderr).message).toBe("yt-dlp failed (exit code 1): KeyError: 'formats'.")
  })

  it('says there was no message when stderr is empty', () => {
    expect(mapStderr('')).toEqual({
      code: 'unknown',
      message: 'yt-dlp failed (exit code 1) without an error message.',
    })
    expect(mapStderr('\n\r\n  \n')).toEqual(mapStderr(''))
  })

  it('has a message for an ERROR line without text', () => {
    expect(mapStderr('ERROR: ')).toEqual({
      code: 'unknown',
      message: 'yt-dlp reported an error without details.',
    })
  })

  it(`cuts a long quote to ${MAX_QUOTED_LENGTH} code points without splitting a character`, () => {
    const text = '🎧'.repeat(MAX_QUOTED_LENGTH * 2)
    const { message } = mapStderr(`ERROR: [youtube] abcdefghijk: ${text}`)
    const quoted = message.slice('yt-dlp: '.length)
    expect(Array.from(quoted)).toHaveLength(MAX_QUOTED_LENGTH)
    expect(quoted.endsWith('🎧…')).toBe(true)
    expect(quoted.isWellFormed()).toBe(true)
  })

  it('relies on --color never: a colored ERROR prefix is not read as an ERROR line', () => {
    const args = baseArgs('/usr/local/bin/node')
    expect(args[args.indexOf('--color') + 1]).toBe('never')
    const colored = '\u001b[0;31mERROR:\u001b[0m [youtube] abcdefghijk: Private video'
    expect(mapStderr(colored).code).toBe('unknown')
  })
})

describe('the pattern tables', () => {
  const rows = [...ERROR_PATTERNS, ...WARNING_HINTS, ...TRANSFER_PATTERNS, ...FALLBACK_PATTERNS]

  it('has a non-empty message on every row', () => {
    for (const row of rows) expect(ErrorInfoSchema.parse(row).message.length).toBeGreaterThan(0)
  })

  it('uses no global or sticky regexes, whose lastIndex would make test() stateful', () => {
    for (const row of rows) expect(row.match.flags).not.toMatch(/[gy]/)
  })

  it('covers every engine error code except preview_only, which stderr never carries', () => {
    const covered = new Set(rows.map((row) => row.code))
    // A transfer error is never "removed" or a login: the track was found.
    for (const row of TRANSFER_PATTERNS) {
      expect(['rate_limited', 'network']).toContain(row.code)
    }
    const expected: ErrorCode[] = [
      'unsupported_url',
      'private',
      'unavailable',
      'geo_blocked',
      'age_restricted',
      'bot_check',
      'rate_limited',
      'login_required',
      'engine_missing',
      'postprocess_failed',
      'network',
      'disk_full',
    ]
    for (const code of expected) expect(covered, code).toContain(code)
    expect(covered).not.toContain('preview_only')
  })
})
