import {
  type DownloadFormat,
  DownloadFormatSchema,
  type Platform,
  PlatformSchema,
} from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  baseArgs,
  DONE_FIELDS,
  DONE_PRINT,
  type DownloadArgsOptions,
  downloadArgs,
  downloadSelector,
  entryArgs,
  resolveArgs,
  START_FIELDS,
  START_PRINT,
} from './ytdlp-args.ts'

const NODE = '/opt/homebrew/bin/node'
const BASE = [
  '--ignore-config',
  '--no-update',
  '--color',
  'never',
  '--encoding',
  'utf-8',
  '--js-runtimes',
  `node:${NODE}`,
]

describe('baseArgs', () => {
  it('ignores user config, never self-updates, prints plain UTF-8 and offers our Node for JS', () => {
    expect(baseArgs(NODE)).toEqual(BASE)
  })
})

describe('resolveArgs', () => {
  const url = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'

  it('lists flat and asks for one row more than the cap, so a longer list shows as truncated', () => {
    expect(resolveArgs({ url, limit: 5000, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '-I',
      '1:5001',
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })

  it.each([
    ['yes', '--yes-playlist'],
    ['no', '--no-playlist'],
  ] as const)('adds the playlist flag for playlist: %s', (playlist, flag) => {
    expect(resolveArgs({ url, playlist, limit: 50, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '-I',
      '1:51',
      flag,
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })

  it('keeps a URL that looks like an option after --, as the last argument', () => {
    const argv = resolveArgs({ url: '--exec=touch /tmp/x', limit: 1, jsRuntime: NODE })
    expect(argv.slice(-2)).toEqual(['--', '--exec=touch /tmp/x'])
    expect(argv.indexOf('--')).toBe(argv.length - 2)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the limit %s', (limit) => {
    expect(() => resolveArgs({ url, limit, jsRuntime: NODE })).toThrow(RangeError)
  })
})

describe('entryArgs', () => {
  it('looks up one track in full, never its playlist, and a list only as a flat page', () => {
    const url = 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy'
    expect(entryArgs({ url, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '--no-playlist',
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })
})

describe('download prints', () => {
  it('prints the START and DONE fields of the Phase 2 design (§4) verbatim', () => {
    expect(START_PRINT).toBe(
      'before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j',
    )
    expect(DONE_PRINT).toBe(
      'after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j',
    )
    expect(START_FIELDS).toHaveLength(7)
    expect(DONE_FIELDS).toHaveLength(23)
  })

  it('never asks for our own input URL back (a secret SoundCloud link is a credential)', () => {
    const fields: readonly string[] = DONE_FIELDS
    expect(fields).not.toContain('original_url')
    expect(fields).not.toContain('url')
    expect(fields).not.toContain('thumbnails')
  })
})

describe('downloadSelector', () => {
  const formats = DownloadFormatSchema.options
  const others = formats.filter((format) => format !== 'm4a')

  it.each(others)('takes the best audio stream on YouTube for %s', (format) => {
    expect(downloadSelector('youtube', format)).toBe('ba')
  })

  it.each(others)('skips Opus on SoundCloud unless nothing else exists, for %s', (format) => {
    expect(downloadSelector('soundcloud', format)).toBe('ba[acodec!=opus]/ba')
  })

  it.each(others)('falls back to a muxed format elsewhere, for %s', (format) => {
    expect(downloadSelector('other', format)).toBe('ba/b')
  })

  it('prefers an M4A (AAC) stream it can copy for M4A, on every platform', () => {
    expect(downloadSelector('youtube', 'm4a')).toBe('ba[ext=m4a]/ba')
    expect(downloadSelector('soundcloud', 'm4a')).toBe('ba[ext=m4a]/ba[acodec!=opus]/ba')
    expect(downloadSelector('other', 'm4a')).toBe('ba[ext=m4a]/ba/b')
  })
})

describe('downloadArgs', () => {
  const JOB_DIR =
    '/Users/dj/Library/Application Support/DJ Scraper/jobs/0b7c1a52-8f0e-4c1e-9d38-2a3a6c1f5e11'
  const FFMPEG = '/opt/homebrew/bin/ffmpeg'
  const URLS: Record<Platform, string> = {
    youtube: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    soundcloud: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
    other: 'https://example.com/live/stream.m3u8',
  }
  const options = (overrides: Partial<DownloadArgsOptions> = {}): DownloadArgsOptions => ({
    url: URLS.youtube,
    platform: 'youtube',
    format: 'mp3',
    jobDir: JOB_DIR,
    writeThumbnail: true,
    jsRuntime: NODE,
    ...overrides,
  })

  /** Everything between the selector and `-P`, which only the platform and the options change. */
  const RETRIES = [
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--retry-sleep',
    'fragment:exp=1:8',
    '--abort-on-unavailable-fragments',
    '--max-filesize',
    '2G',
  ]
  const OUTPUT = [
    '-P',
    JOB_DIR,
    '-o',
    '%(id)s.%(ext)s',
    '--newline',
    '--progress',
    '--progress-delta',
    '0.5',
    '--progress-template',
    'download:DL %(progress)j',
    '--progress-template',
    'postprocess:PP %(progress.postprocessor)s %(progress.status)s',
    '--print',
    'before_dl:START %(.{format_id,acodec,abr,asr,protocol,available_at,playlist_id})j',
    '--print',
    'after_move:DONE %(.{id,filepath,ext,format_id,acodec,abr,asr,duration,title,track,artist,artists,uploader,channel,album,album_artist,release_year,release_date,webpage_url,extractor_key,availability,thumbnails.-1.filepath,thumbnails.-1.url})j',
  ]

  it('downloads a YouTube track as is, with its thumbnail, into the job dir', () => {
    expect(downloadArgs(options())).toEqual([
      ...BASE,
      '--no-playlist',
      '-f',
      'ba',
      ...RETRIES,
      '--write-thumbnail',
      ...OUTPUT,
      '--',
      URLS.youtube,
    ])
  })

  it('asks YouTube for the AAC stream for M4A, without a thumbnail when not wanted', () => {
    expect(downloadArgs(options({ format: 'm4a', writeThumbnail: false }))).toEqual([
      ...BASE,
      '--no-playlist',
      '-f',
      'ba[ext=m4a]/ba',
      ...RETRIES,
      ...OUTPUT,
      '--',
      URLS.youtube,
    ])
  })

  it('makes SoundCloud fail fast on a 429 and stop silently at a Go+ preview', () => {
    const url = URLS.soundcloud
    expect(downloadArgs(options({ url, platform: 'soundcloud', format: 'wav' }))).toEqual([
      ...BASE,
      '--no-playlist',
      '-f',
      'ba[acodec!=opus]/ba',
      ...RETRIES,
      '--write-thumbnail',
      '--extractor-retries',
      '0',
      '--break-match-filters',
      'format_id!*=preview',
      ...OUTPUT,
      '--',
      url,
    ])
  })

  it('skips Opus on SoundCloud for M4A too', () => {
    const url = URLS.soundcloud
    const argv = downloadArgs(options({ url, platform: 'soundcloud', format: 'm4a' }))
    expect(argv[argv.indexOf('-f') + 1]).toBe('ba[ext=m4a]/ba[acodec!=opus]/ba')
  })

  it('refuses live streams on other sites and takes a muxed format when there is no audio-only one', () => {
    const url = URLS.other
    expect(
      downloadArgs(options({ url, platform: 'other', format: 'original', writeThumbnail: false })),
    ).toEqual([
      ...BASE,
      '--no-playlist',
      '-f',
      'ba/b',
      ...RETRIES,
      '--match-filters',
      '!is_live',
      ...OUTPUT,
      '--',
      url,
    ])
  })

  it('points yt-dlp at ffmpeg only when FFMPEG_PATH is set', () => {
    expect(downloadArgs(options({ ffmpegLocation: FFMPEG }))).toEqual([
      ...BASE,
      '--no-playlist',
      '-f',
      'ba',
      ...RETRIES,
      '--write-thumbnail',
      '--ffmpeg-location',
      FFMPEG,
      ...OUTPUT,
      '--',
      URLS.youtube,
    ])
    expect(downloadArgs(options({ ffmpegLocation: '' }))).not.toContain('--ffmpeg-location')
    expect(downloadArgs(options())).not.toContain('--ffmpeg-location')
  })

  it('places SoundCloud flags after --ffmpeg-location, as the design orders them', () => {
    const argv = downloadArgs(
      options({ url: URLS.soundcloud, platform: 'soundcloud', ffmpegLocation: FFMPEG }),
    )
    expect(argv.indexOf('--ffmpeg-location')).toBeLessThan(argv.indexOf('--extractor-retries'))
    expect(argv.indexOf('--write-thumbnail')).toBeLessThan(argv.indexOf('--ffmpeg-location'))
  })

  it('refuses a relative job dir, which would let yt-dlp write next to the server', () => {
    expect(() => downloadArgs(options({ jobDir: 'jobs/abc' }))).toThrow(RangeError)
    expect(() => downloadArgs(options({ jobDir: '' }))).toThrow(RangeError)
  })

  describe('for every platform × format', () => {
    const combos = PlatformSchema.options.flatMap((platform) =>
      DownloadFormatSchema.options.flatMap((format: DownloadFormat) =>
        [true, false].flatMap((writeThumbnail) =>
          [undefined, FFMPEG].map((ffmpegLocation) => ({
            platform,
            format,
            writeThumbnail,
            ffmpegLocation,
          })),
        ),
      ),
    )
    /** Every argument a download may carry, apart from the URL and the caller's paths. */
    const VOCABULARY = new Set([
      ...BASE,
      ...RETRIES,
      ...OUTPUT,
      '--no-playlist',
      '-f',
      ...PlatformSchema.options.flatMap((platform) =>
        DownloadFormatSchema.options.map((format) => downloadSelector(platform, format)),
      ),
      '--write-thumbnail',
      '--ffmpeg-location',
      FFMPEG,
      '--extractor-retries',
      '0',
      '--break-match-filters',
      'format_id!*=preview',
      '--match-filters',
      '!is_live',
      '--',
    ])

    const label = (combo: (typeof combos)[number]) => JSON.stringify(combo)

    it('puts the URL only at the end, after --, and nothing else from the request', () => {
      const url = '--exec=touch /tmp/pwned;{title}%(title)s'
      for (const combo of combos) {
        const argv = downloadArgs(options({ ...combo, url }))
        expect(argv.slice(-2), label(combo)).toEqual(['--', url])
        expect(argv.indexOf('--'), label(combo)).toBe(argv.length - 2)
        expect(argv.slice(0, BASE.length), label(combo)).toEqual(BASE)
        for (const arg of argv.slice(0, -1)) expect(VOCABULARY, label(combo)).toContain(arg)
      }
    })

    it('adds the thumbnail, ffmpeg and platform flags exactly when they apply', () => {
      for (const combo of combos) {
        const argv = downloadArgs(options(combo))
        const has = (flag: string) => argv.includes(flag)
        expect(has('--write-thumbnail'), label(combo)).toBe(combo.writeThumbnail)
        expect(has('--ffmpeg-location'), label(combo)).toBe(combo.ffmpegLocation !== undefined)
        expect(has('--break-match-filters'), label(combo)).toBe(combo.platform === 'soundcloud')
        expect(has('--extractor-retries'), label(combo)).toBe(combo.platform === 'soundcloud')
        expect(has('--match-filters'), label(combo)).toBe(combo.platform === 'other')
        expect(argv[argv.indexOf('-f') + 1]).toBe(downloadSelector(combo.platform, combo.format))
        // yt-dlp only downloads: finalize converts, tags and adds the cover (D1).
        for (const flag of ['-x', '--audio-format', '--embed-thumbnail', '--embed-metadata']) {
          expect(argv, label(combo)).not.toContain(flag)
        }
      }
    })
  })
})
