import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type ErrorCode, ErrorInfoSchema } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { baseArgs } from './ytdlp-args.ts'
import {
  ERROR_PATTERNS,
  MAX_QUOTED_LENGTH,
  mapYtdlpError,
  WARNING_HINTS,
  type YtdlpFailure,
} from './ytdlp-errors.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/errors')
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')

/** Maps, and checks the result against the contract every caller relies on. */
const map = (failure: YtdlpFailure) => ErrorInfoSchema.parse(mapYtdlpError(failure))
const mapStderr = (stderr: string, exitCode: number | null = 1) => map({ stderr, exitCode })

/** Every errors/*.log with the exit code it was recorded with (README) and the code it must map to. */
const FIXTURES: Record<string, { exitCode: number; code: ErrorCode }> = {
  'bad-option.log': { exitCode: 2, code: 'unknown' },
  'connection-refused.log': { exitCode: 1, code: 'network' },
  'dns.log': { exitCode: 1, code: 'network' },
  'drm.log': { exitCode: 1, code: 'unsupported_url' },
  'ffmpeg-missing.log': { exitCode: 1, code: 'engine_missing' },
  'interrupted.log': { exitCode: 1, code: 'canceled' },
  'invalid-url.log': { exitCode: 1, code: 'invalid_url' },
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
  const rows = [...ERROR_PATTERNS, ...WARNING_HINTS]

  it('has a non-empty message on every row', () => {
    for (const row of rows) expect(ErrorInfoSchema.parse(row).message.length).toBeGreaterThan(0)
  })

  it('uses no global or sticky regexes, whose lastIndex would make test() stateful', () => {
    for (const row of rows) expect(row.match.flags).not.toMatch(/[gy]/)
  })

  it('covers every engine error code except preview_only, which stderr never carries', () => {
    const covered = new Set(rows.map((row) => row.code))
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
    ]
    for (const code of expected) expect(covered, code).toContain(code)
    expect(covered).not.toContain('preview_only')
  })
})
