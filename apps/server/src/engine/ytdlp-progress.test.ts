import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { JobProgressSchema } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import type { DoneInfo, StartInfo } from '../jobs/types.ts'
import { type DownloadLine, parseDownloadLine, waitingUntil } from './ytdlp-progress.ts'

const downloadsDir = path.resolve(import.meta.dirname, '../../test/fixtures/downloads')
const JOB_DIR =
  '/Users/dj/Library/Application Support/DJ Scraper/jobs/0b7c1a52-8f0e-4c1e-9d38-2a3a6c1f5e11'
/** What `{NOW+<n>}` becomes, as the fake yt-dlp does at replay (README: Placeholders). */
const NOW_SEC = 1_790_980_000

/** A fixture's lines with its placeholders filled in, as yt-dlp would have printed them. */
function fixtureLines(file: string): string[] {
  return readFileSync(path.join(downloadsDir, file), 'utf8')
    .replaceAll('{JOBDIR}', JOB_DIR)
    .replace(/\{NOW\+(\d+)\}/g, (_, seconds: string) => String(NOW_SEC + Number(seconds)))
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
}

type Stream = 'stdout' | 'stderr'
const parsedLines = (name: string, stream: Stream) =>
  fixtureLines(`${name}.${stream}.log`).map((line) => ({ line, parsed: parseDownloadLine(line) }))

type Summary = {
  dl: number
  pp: number
  start: number
  done: number
  /** Non-empty lines that aren't download lines (ERROR lines; `[…]` screen output under --no-quiet). */
  ignored: number
  lastStatus?: 'downloading' | 'finished'
  doneFields?: (keyof DoneInfo)[]
}

function summarize(name: string): Summary {
  const summary: Summary = { dl: 0, pp: 0, start: 0, done: 0, ignored: 0 }
  for (const stream of ['stdout', 'stderr'] as const) {
    for (const { parsed } of parsedLines(name, stream)) {
      if (parsed === undefined) {
        summary.ignored++
        continue
      }
      summary[parsed.kind]++
      if (parsed.kind === 'dl') summary.lastStatus = parsed.status
      if (parsed.kind === 'done')
        summary.doneFields = Object.keys(parsed.info) as (keyof DoneInfo)[]
    }
  }
  return summary
}

const YOUTUBE_DONE: (keyof DoneInfo)[] = [
  'id',
  'filepath',
  'ext',
  'formatId',
  'acodec',
  'abrKbps',
  'asrHz',
  'durationSec',
  'title',
  'uploader',
  'channel',
  'webpageUrl',
  'extractorKey',
  'availability',
  'thumbnailPath',
  'thumbnailUrl',
]
const SOUNDCLOUD_DONE: (keyof DoneInfo)[] = [
  'id',
  'filepath',
  'ext',
  'formatId',
  'acodec',
  'abrKbps',
  'durationSec',
  'title',
  'track',
  'uploader',
  'webpageUrl',
  'extractorKey',
  'thumbnailPath',
  'thumbnailUrl',
]
/** The older `-x` runs: their DONE asked for fewer fields, and the local server has no thumbnail. */
const LOCAL_DONE: (keyof DoneInfo)[] = [
  'id',
  'filepath',
  'ext',
  'formatId',
  'acodec',
  'abrKbps',
  'durationSec',
  'title',
  'webpageUrl',
  'extractorKey',
]

/** Every case in test/fixtures/downloads (a .stdout.log + .stderr.log pair), as the README describes it. */
const DOWNLOAD_FIXTURES: Record<string, Summary> = {
  // ERROR: + its `\r[download] Got error: …` continuation + the fragment trailer, on stderr.
  'local-hls-404': { dl: 1, pp: 0, start: 1, done: 0, ignored: 3, lastStatus: 'downloading' },
  'local-hls-429': { dl: 1, pp: 0, start: 1, done: 0, ignored: 3, lastStatus: 'downloading' },
  'local-hls-429-abort-r1': {
    dl: 1,
    pp: 0,
    start: 0,
    done: 0,
    ignored: 3,
    lastStatus: 'downloading',
  },
  'local-hls-missing': {
    dl: 2,
    pp: 6,
    start: 0,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: LOCAL_DONE,
  },
  'local-hls-missing-abort': {
    dl: 1,
    pp: 0,
    start: 0,
    done: 0,
    ignored: 3,
    lastStatus: 'downloading',
  },
  // --no-quiet: everything on stdout, with 14 screen lines among the download lines.
  'local-hls-missing-noquiet': {
    dl: 2,
    pp: 6,
    start: 0,
    done: 1,
    ignored: 14,
    lastStatus: 'finished',
    doneFields: LOCAL_DONE,
  },
  'local-http-429': { dl: 0, pp: 0, start: 0, done: 0, ignored: 1 },
  'local-progressive-429': { dl: 0, pp: 0, start: 1, done: 0, ignored: 1 },
  'soundcloud-ba': {
    dl: 2,
    pp: 2,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: SOUNDCLOUD_DONE,
  },
  'soundcloud-hls': {
    dl: 3,
    pp: 4,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: SOUNDCLOUD_DONE,
  },
  'soundcloud-hls-aac': {
    dl: 7,
    pp: 6,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: SOUNDCLOUD_DONE,
  },
  // Two STARTs with playlist_id and nothing downloaded (--skip-download).
  'soundcloud-list': { dl: 0, pp: 6, start: 2, done: 0, ignored: 0 },
  'soundcloud-list-break': { dl: 0, pp: 2, start: 1, done: 0, ignored: 0 },
  'soundcloud-preview-break': { dl: 0, pp: 0, start: 0, done: 0, ignored: 0 },
  'youtube-ba': {
    dl: 2,
    pp: 2,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: YOUTUBE_DONE,
  },
  'youtube-ba-nothumb': {
    dl: 2,
    pp: 2,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: YOUTUBE_DONE.filter((field) => field !== 'thumbnailPath'),
  },
  'youtube-ba-wait': {
    dl: 2,
    pp: 2,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: YOUTUBE_DONE,
  },
  // `ERROR: Interrupted by user` after an empty line.
  'youtube-cancel-download': {
    dl: 2,
    pp: 0,
    start: 1,
    done: 0,
    ignored: 1,
    lastStatus: 'downloading',
  },
  'youtube-cancel-fixup': { dl: 2, pp: 1, start: 1, done: 0, ignored: 1, lastStatus: 'finished' },
  'youtube-m4a': {
    dl: 2,
    pp: 4,
    start: 1,
    done: 1,
    ignored: 0,
    lastStatus: 'finished',
    doneFields: YOUTUBE_DONE,
  },
}

/** JSON paths whose value is `undefined`: optional fields must be omitted instead. */
function undefinedPaths(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, field]) =>
    field === undefined ? [`${at}.${key}`] : undefinedPaths(field, `${at}.${key}`),
  )
}

/** Checks what every caller relies on, then returns the line. */
function checked(parsed: DownloadLine | undefined): DownloadLine | undefined {
  if (parsed === undefined) return undefined
  expect(undefinedPaths(parsed)).toEqual([])
  if (parsed.kind === 'dl')
    expect(JobProgressSchema.parse(parsed.progress)).toStrictEqual(parsed.progress)
  return parsed
}

const parse = (line: string) => checked(parseDownloadLine(line))

function parseAs<K extends DownloadLine['kind']>(
  line: string,
  kind: K,
): Extract<DownloadLine, { kind: K }> {
  const parsed = parse(line)
  if (parsed?.kind !== kind) throw new Error(`expected a ${kind} line, got ${parsed?.kind}`)
  return parsed as Extract<DownloadLine, { kind: K }>
}

const dl = (fields: Record<string, unknown>) => parseAs(`DL ${JSON.stringify(fields)}`, 'dl')
const start = (fields: Record<string, unknown>) =>
  parseAs(`START ${JSON.stringify(fields)}`, 'start').info
const done = (fields: Record<string, unknown>) => {
  const parsed = parse(
    `DONE ${JSON.stringify({ id: 'x1', filepath: `${JOB_DIR}/x1.webm`, ...fields })}`,
  )
  return parsed?.kind === 'done' ? parsed.info : undefined
}

describe('parseDownloadLine on the recorded downloads', () => {
  const cases = [
    ...new Set(
      readdirSync(downloadsDir)
        .filter((file) => file.endsWith('.log'))
        .map((file) => file.replace(/\.(?:stdout|stderr)\.log$/, '')),
    ),
  ]

  it('has a summary for every case in test/fixtures/downloads, each a stdout + stderr pair', () => {
    expect(cases.toSorted()).toEqual(Object.keys(DOWNLOAD_FIXTURES).toSorted())
    const files = readdirSync(downloadsDir).filter((file) => file.endsWith('.log'))
    for (const name of cases) {
      expect(files, name).toContain(`${name}.stdout.log`)
      expect(files, name).toContain(`${name}.stderr.log`)
    }
  })

  it.each(Object.entries(DOWNLOAD_FIXTURES))('%s', (name, expected) => {
    expect(summarize(name)).toStrictEqual(expected)
  })

  it.each(Object.keys(DOWNLOAD_FIXTURES))(
    '%s: every line is contract-valid, paths in the job dir',
    (name) => {
      for (const stream of ['stdout', 'stderr'] as const) {
        for (const { line, parsed } of parsedLines(name, stream)) {
          checked(parsed)
          if (parsed === undefined) {
            // Only screen output (--no-quiet) and errors are not download lines.
            if (!name.endsWith('-noquiet')) {
              expect(line, name).toMatch(/^(?:ERROR: |\[download\] Got error: )/)
            }
          } else if (parsed.kind === 'done') {
            expect(parsed.info.filepath.startsWith(`${JOB_DIR}/`)).toBe(true)
            if (parsed.info.thumbnailPath !== undefined) {
              expect(parsed.info.thumbnailPath.startsWith(`${JOB_DIR}/`)).toBe(true)
            }
          }
        }
      }
    },
  )

  it('puts DL, START and DONE on stdout and PP on stderr in quiet mode', () => {
    for (const name of Object.keys(DOWNLOAD_FIXTURES).filter((n) => !n.endsWith('-noquiet'))) {
      const kinds = (stream: Stream) =>
        parsedLines(name, stream).flatMap(({ parsed }) => parsed?.kind ?? [])
      expect(kinds('stdout'), name).not.toContain('pp')
      expect(
        kinds('stderr').filter((kind) => kind !== 'pp'),
        name,
      ).toEqual([])
    }
  })

  it('reads a YouTube START and DONE (youtube-ba)', () => {
    const lines = parsedLines('youtube-ba', 'stdout').map(({ parsed }) => parsed)
    expect(lines[0]).toStrictEqual({
      kind: 'start',
      info: {
        formatId: '251',
        acodec: 'opus',
        abrKbps: 106.064,
        asrHz: 48000,
        protocol: 'https',
        availableAt: 1790973562,
      },
    })
    expect(lines.at(-1)).toStrictEqual({
      kind: 'done',
      info: {
        id: 'jNQXAC9IVRw',
        filepath: `${JOB_DIR}/jNQXAC9IVRw.webm`,
        ext: 'webm',
        formatId: '251',
        acodec: 'opus',
        abrKbps: 106.064,
        asrHz: 48000,
        durationSec: 19,
        title: 'Me at the zoo',
        uploader: 'jawed',
        channel: 'jawed',
        webpageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        extractorKey: 'Youtube',
        availability: 'public',
        thumbnailPath: `${JOB_DIR}/jNQXAC9IVRw.webp`,
        thumbnailUrl: 'https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp',
      },
    })
  })

  it('reads a SoundCloud START without asr or available_at, and its escaped title (soundcloud-ba)', () => {
    const lines = parsedLines('soundcloud-ba', 'stdout').map(({ parsed }) => parsed)
    expect(lines[0]).toStrictEqual({
      kind: 'start',
      info: { formatId: 'http_mp3_0_0', acodec: 'mp3', abrKbps: 128, protocol: 'http' },
    })
    const last = lines.at(-1)
    // As yt-dlp sent it (A + U+0308, decomposed): NFC is finalize's job.
    expect(last?.kind === 'done' && last.info.title).toBe(
      "Youtube - Dl Test Video '' A\u0308\u21ad",
    )
  })

  it('reads the progress of a plain download (soundcloud-ba)', () => {
    const progress = parsedLines('soundcloud-ba', 'stdout').flatMap(({ parsed }) =>
      parsed?.kind === 'dl' ? [parsed] : [],
    )
    expect(progress).toStrictEqual([
      {
        kind: 'dl',
        status: 'downloading',
        progress: {
          percent: (1024 / 158823) * 100,
          downloadedBytes: 1024,
          totalBytes: 158823,
          speedBps: 245328.5712000914,
          etaSec: 0,
        },
      },
      {
        kind: 'dl',
        status: 'finished',
        progress: {
          percent: 100,
          downloadedBytes: 158823,
          totalBytes: 158823,
          speedBps: 1550192.7855497275,
        },
      },
    ])
  })

  it('omits a null speed and eta (youtube-ba)', () => {
    const [first] = parsedLines('youtube-ba', 'stdout').flatMap(({ parsed }) =>
      parsed?.kind === 'dl' ? [parsed.progress] : [],
    )
    expect(first).toStrictEqual({
      percent: (1024 / 252182) * 100,
      downloadedBytes: 1024,
      totalBytes: 252182,
    })
  })

  it('counts HLS progress by fragments, which only goes forward (soundcloud-hls-aac)', () => {
    const lines = parsedLines('soundcloud-hls-aac', 'stdout').flatMap(({ line, parsed }) =>
      parsed?.kind === 'dl' ? [{ line, progress: parsed.progress }] : [],
    )
    expect(lines.map(({ progress }) => progress.percent)).toStrictEqual([
      0,
      (1 / 23) * 100,
      (7 / 23) * 100,
      (13 / 23) * 100,
      (17 / 23) * 100,
      (21 / 23) * 100,
      100,
    ])
    // yt-dlp's own _percent (bytes over a jumping estimate) goes backwards: 4.3 % → 0.08 %.
    const ownPercent = lines.map(
      ({ line }) => (JSON.parse(line.slice(3)) as { _percent: number })._percent,
    )
    expect(ownPercent[1]).toBeLessThan(ownPercent[0] ?? 0)
    // The estimate is never shown as the total; only the finished line knows it.
    expect(lines.map(({ progress }) => progress.totalBytes)).toStrictEqual([
      ...Array<undefined>(6).fill(undefined),
      4481339,
    ])
  })

  it('lists the postprocessors in order (soundcloud-hls-aac)', () => {
    const pp = parsedLines('soundcloud-hls-aac', 'stderr').map(({ parsed }) => parsed)
    expect(pp).toStrictEqual(
      ['FixupM4a', 'FixupM3u8', 'MoveFiles'].flatMap((postprocessor) => [
        { kind: 'pp', postprocessor, status: 'started' },
        { kind: 'pp', postprocessor, status: 'finished' },
      ]),
    )
  })

  it('reads the playlist id of each list entry (soundcloud-list)', () => {
    const starts = parsedLines('soundcloud-list', 'stdout').map(({ parsed }) => parsed)
    expect(starts).toStrictEqual([
      {
        kind: 'start',
        info: {
          formatId: 'hls_aac_160k',
          acodec: 'mp4a.40.2',
          abrKbps: 160,
          protocol: 'm3u8_native',
          playlistId: '2284613',
        },
      },
      expect.objectContaining({ kind: 'start' }),
    ])
  })
})

describe('parseDownloadLine: DL', () => {
  it('reads yt-dlp’s `_percent: false` (no total yet) without using it', () => {
    expect(dl({ status: 'downloading', downloaded_bytes: 4096, _percent: false })).toStrictEqual({
      kind: 'dl',
      status: 'downloading',
      progress: { downloadedBytes: 4096 },
    })
  })

  it('falls back to the estimate for the percent when there are no fragments', () => {
    expect(
      dl({ status: 'downloading', downloaded_bytes: 250, total_bytes_estimate: 1000 }).progress,
    ).toStrictEqual({ percent: 25, downloadedBytes: 250 })
  })

  it('prefers fragments over bytes, and bytes over the total over the estimate', () => {
    const fields = { status: 'downloading', downloaded_bytes: 500, total_bytes_estimate: 1000 }
    expect(dl({ ...fields, fragment_index: 1, fragment_count: 4 }).progress.percent).toBe(25)
    expect(dl({ ...fields, total_bytes: 2000 }).progress.percent).toBe(25)
  })

  it.each([
    ['more bytes than the total', { downloaded_bytes: 3000, total_bytes: 1000 }, 100],
    ['a fragment index past the count', { fragment_index: 9, fragment_count: 4 }, 100],
  ])('clamps %s to 100', (_label, fields, percent) => {
    expect(dl({ status: 'downloading', ...fields }).progress.percent).toBe(percent)
  })

  it('reports 100 when finished, even without totals', () => {
    expect(dl({ status: 'finished' }).progress).toStrictEqual({ percent: 100 })
  })

  it.each([
    ['negative', -1],
    ['a string', '12'],
    ['null', null],
    ['a boolean', true],
  ])('drops %s numbers instead of failing the line', (_label, value) => {
    expect(
      dl({
        status: 'downloading',
        downloaded_bytes: value,
        total_bytes: value,
        total_bytes_estimate: value,
        speed: value,
        eta: value,
        fragment_index: value,
        fragment_count: value,
      }).progress,
    ).toStrictEqual({})
  })

  it('ignores a zero fragment count and a zero total (no division by zero)', () => {
    expect(
      dl({
        status: 'downloading',
        fragment_index: 0,
        fragment_count: 0,
        downloaded_bytes: 10,
        total_bytes: 0,
      }).progress,
    ).toStrictEqual({ downloadedBytes: 10 })
  })

  it.each([
    ['an error status', { status: 'error' }],
    ['no status', { downloaded_bytes: 1 }],
  ])('skips a line with %s', (_label, fields) => {
    expect(parseDownloadLine(`DL ${JSON.stringify(fields)}`)).toBeUndefined()
  })

  it('never carries the job dir paths of the progress dict', () => {
    const line = parsedLines('youtube-ba', 'stdout').find(({ parsed }) => parsed?.kind === 'dl')
    expect(JSON.stringify(line?.parsed)).not.toContain(JOB_DIR)
  })
})

describe('parseDownloadLine: PP', () => {
  it('reads a postprocessor and its status', () => {
    expect(parse('PP MoveFiles finished')).toStrictEqual({
      kind: 'pp',
      postprocessor: 'MoveFiles',
      status: 'finished',
    })
    expect(parse('PP FixupM3u8 started\r')).toMatchObject({ postprocessor: 'FixupM3u8' })
  })

  it.each(['PP', 'PP MoveFiles', 'PP Move Files started', 'PP MoveFiles started now', 'PP  x y'])(
    'skips the malformed %j',
    (line) => {
      expect(parseDownloadLine(line)).toBeUndefined()
    },
  )
})

describe('parseDownloadLine: START', () => {
  it('reads a START without fields as a START: a second one means the URL is a list', () => {
    expect(parse('START {}')).toStrictEqual({ kind: 'start', info: {} })
  })

  it('reads a numeric playlist id as a string, and drops a codec of `none`', () => {
    expect(start({ playlist_id: 2284613, acodec: 'none' })).toStrictEqual({ playlistId: '2284613' })
  })

  it('drops values of the wrong type or out of range', () => {
    expect(
      start({
        format_id: '',
        abr: 0,
        asr: 44100.5,
        protocol: 7,
        available_at: -1,
        playlist_id: null,
      }),
    ).toStrictEqual({})
    expect(start({ available_at: 1e15 })).toStrictEqual({})
  })

  it('skips the unreplaced {NOW+n} placeholder, which is not JSON', () => {
    expect(parseDownloadLine('START {"available_at": {NOW+3}}')).toBeUndefined()
  })
})

describe('parseDownloadLine: DONE', () => {
  it('needs an id and a file path', () => {
    expect(parseDownloadLine('DONE {"id": "x1"}')).toBeUndefined()
    expect(parseDownloadLine(`DONE {"filepath": "${JOB_DIR}/x1.mp3"}`)).toBeUndefined()
    expect(parseDownloadLine('DONE {"id": " ", "filepath": "/x"}')).toBeUndefined()
    expect(done({ id: 47127631 })?.id).toBe('47127631')
  })

  it('keeps http(s) URLs only', () => {
    expect(
      done({
        webpage_url: 'javascript:alert(1)',
        'thumbnails.-1.url': 'file:///etc/passwd',
      }),
    ).toStrictEqual({ id: 'x1', filepath: `${JOB_DIR}/x1.webm` })
    expect(
      done({
        webpage_url: 'https://music.youtube.com/watch?v=XNEnEBrHws8',
        'thumbnails.-1.url': 'https://i.ytimg.com/vi/XNEnEBrHws8/maxresdefault.jpg',
      }),
    ).toMatchObject({
      webpageUrl: 'https://music.youtube.com/watch?v=XNEnEBrHws8',
      thumbnailUrl: 'https://i.ytimg.com/vi/XNEnEBrHws8/maxresdefault.jpg',
    })
  })

  it('reads YouTube Music release fields', () => {
    expect(
      done({
        track: 'Song',
        artist: 'Artist',
        artists: ['Artist', '', null, 'Guest'],
        album: 'Album',
        album_artist: 'Artist',
        release_year: 2019,
        release_date: '20190412',
      }),
    ).toStrictEqual({
      id: 'x1',
      filepath: `${JOB_DIR}/x1.webm`,
      track: 'Song',
      artist: 'Artist',
      artists: ['Artist', 'Guest'],
      album: 'Album',
      albumArtist: 'Artist',
      releaseYear: 2019,
      releaseDate: '20190412',
    })
  })

  it('drops numbers and dates that make no sense', () => {
    expect(
      done({
        duration: -3,
        abr: 'high',
        asr: 0,
        release_year: '2019',
        release_date: '2019-04-12',
        artists: [],
      }),
    ).toStrictEqual({ id: 'x1', filepath: `${JOB_DIR}/x1.webm` })
    expect(done({ release_year: 20190 })?.releaseYear).toBeUndefined()
  })
})

describe('parseDownloadLine never throws', () => {
  it.each([
    '',
    'DL',
    'DL ',
    'DL null',
    'DL []',
    'DL "downloading"',
    'DL {',
    'DONE 42',
    'START [1, 2]',
    'ERROR: Interrupted by user',
    '[download] Destination: x',
    'WARNING: [youtube] something',
    'dl {"status": "finished"}',
    ' DL {"status": "finished"}',
  ])('reads %j as nothing', (line) => {
    expect(parseDownloadLine(line)).toBeUndefined()
  })

  it('reads __proto__ and constructor keys as plain data', () => {
    const line = 'DL {"status": "downloading", "__proto__": {"eta": 1}, "constructor": 1}'
    expect(parse(line)).toStrictEqual({ kind: 'dl', status: 'downloading', progress: {} })
    expect(({} as Record<string, unknown>).eta).toBeUndefined()
  })

  it('survives random bytes and random JSON after every prefix', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const values: unknown[] = [null, true, 0, -1, 1e308, '', 'x', [], {}, [null], { a: {} }]
    const keys = ['status', 'downloaded_bytes', 'fragment_count', 'id', 'filepath', 'available_at']
    for (let i = 0; i < 2000; i++) {
      const prefix = ['DL ', 'PP ', 'START ', 'DONE ', ''][Math.floor(random() * 5)] ?? ''
      const object = Object.fromEntries(
        keys.map((key) => [key, values[Math.floor(random() * values.length)]]),
      )
      const noise = String.fromCharCode(
        ...Array.from({ length: 12 }, () => Math.floor(random() * 0xffff)),
      )
      expect(() => checked(parseDownloadLine(`${prefix}${JSON.stringify(object)}`))).not.toThrow()
      expect(() => checked(parseDownloadLine(`${prefix}${noise}`))).not.toThrow()
    }
  })
})

describe('waitingUntil', () => {
  const info = (availableAt?: number): StartInfo =>
    availableAt === undefined ? {} : { availableAt }

  it('gives the instant the site serves the file when it is still ahead', () => {
    const at = 1_790_973_562
    const until = waitingUntil(info(at), at * 1000 - 1500)
    expect(until).toBe(new Date(at * 1000).toISOString())
    expect(JobProgressSchema.parse({ waitingUntil: until })).toStrictEqual({ waitingUntil: until })
  })

  it('reads the synthetic wait of youtube-ba-wait at replay time', () => {
    const [first] = parsedLines('youtube-ba-wait', 'stdout')
    const parsed = first?.parsed
    if (parsed?.kind !== 'start') throw new Error('expected START first')
    expect(waitingUntil(parsed.info, NOW_SEC * 1000)).toBe(
      new Date((NOW_SEC + 3) * 1000).toISOString(),
    )
  })

  it('is undefined once the moment has come, or without one', () => {
    const at = 1_790_973_562
    expect(waitingUntil(info(at), at * 1000)).toBeUndefined()
    expect(waitingUntil(info(at), at * 1000 + 1)).toBeUndefined()
    expect(waitingUntil(info(), 0)).toBeUndefined()
  })

  it('treats every recorded START as no wait at replay (they are in the past)', () => {
    const now = Date.parse('2026-10-03T00:00:00Z')
    for (const name of [
      'youtube-ba',
      'youtube-m4a',
      'youtube-ba-nothumb',
      'youtube-cancel-download',
    ]) {
      const [first] = parsedLines(name, 'stdout')
      if (first?.parsed?.kind !== 'start') throw new Error(`${name}: expected START first`)
      expect(waitingUntil(first.parsed.info, now), name).toBeUndefined()
    }
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5, 1e15])('never throws on %d', (at) => {
    expect(waitingUntil({ availableAt: at }, 0)).toBeUndefined()
  })
})
