import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import {
  type FfmpegHealth,
  FfmpegHealthSchema,
  type FfprobeHealth,
  FfprobeHealthSchema,
  type Health,
  HealthSchema,
  type JsRuntime,
  JsRuntimeSchema,
  type ToolSource,
  ToolSourceSchema,
  type YtdlpHealth,
  YtdlpHealthSchema,
} from './health.ts'
import {
  brewDeno,
  brewFfmpeg,
  brewFfprobe,
  brewNode,
  brewYtdlp,
  healthy,
  issuePaths,
  type OptionalKeys,
  without,
} from './test-helpers.ts'

// The shapes the server reported for real installs on 2026-10-02 (the healthy Homebrew ones are
// in test-helpers.ts).
const nightlyYtdlp = {
  status: 'ok',
  path: '/Users/dj/bin/yt-dlp_macos/yt-dlp_macos',
  source: 'env',
  version: '2026.09.27.232945',
  releaseDate: '2026-09-27',
  ageDays: 5,
  stale: false,
  meetsMinimum: true,
} satisfies YtdlpHealth

const tooOldYtdlp = {
  ...brewYtdlp,
  version: '2025.10.22',
  releaseDate: '2025-10-22',
  ageDays: 345,
  stale: true,
  meetsMinimum: false,
} satisfies YtdlpHealth

const missingYtdlp = {
  status: 'missing',
  message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
} satisfies YtdlpHealth

const brokenYtdlp = {
  status: 'error',
  path: '/opt/homebrew/bin/yt-dlp',
  source: 'path',
  message: "yt-dlp can't start: the interpreter in its #! line is missing. Reinstall yt-dlp.",
} satisfies YtdlpHealth

const snapshotFfmpeg = {
  status: 'ok',
  path: '/Users/dj/ffmpeg/ffmpeg',
  source: 'env',
  version: 'N-127085-g0eb6a369c69-tessus',
  major: 9,
  meetsMinimum: true,
  mp3: true,
} satisfies FfmpegHealth

/** A build whose version string and libavformat both failed to parse. */
const unknownMajorFfmpeg = {
  status: 'ok',
  path: '/usr/local/bin/ffmpeg',
  source: 'path',
  version: 'custom-build',
  meetsMinimum: false,
  mp3: false,
} satisfies FfmpegHealth

/** A dyld failure (missing dylib) kills ffmpeg with SIGABRT. */
const brokenFfmpeg = {
  status: 'error',
  path: '/opt/homebrew/bin/ffmpeg',
  source: 'path',
  message: 'ffmpeg was killed by SIGABRT: dyld: Library not loaded: libx265.215.dylib',
} satisfies FfmpegHealth

const missingFfmpeg = {
  status: 'missing',
  message: 'ffmpeg is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
} satisfies FfmpegHealth

const unknownMajorFfprobe = {
  status: 'ok',
  path: '/usr/local/bin/ffprobe',
  source: 'path',
  version: 'custom-build',
  meetsMinimum: false,
} satisfies FfprobeHealth

/** FFMPEG_PATH names the binary, and there is no ffprobe beside it. */
const brokenFfprobe = {
  status: 'error',
  path: '/Users/dj/ffmpeg/ffprobe',
  source: 'env',
  message: 'FFMPEG_PATH: /Users/dj/ffmpeg/ffprobe does not exist.',
} satisfies FfprobeHealth

const nothingInstalled = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: missingYtdlp,
  ffmpeg: missingFfmpeg,
  ffprobe: {
    status: 'missing',
    message: 'ffprobe is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
  },
  jsRuntimes: [brewNode],
} satisfies Health

describe('ToolSourceSchema', () => {
  it('rejects a package manager name in place of env or path', () => {
    expect(ToolSourceSchema.safeParse('brew').success).toBe(false)
  })

  it('is exactly env or path', () => {
    expectTypeOf<ToolSource>().toEqualTypeOf<'env' | 'path'>()
  })
})

describe('YtdlpHealthSchema', () => {
  it.each([
    ['a Homebrew yt-dlp found on PATH', brewYtdlp],
    ['a nightly build set with YTDLP_PATH', nightlyYtdlp],
    ['a stale yt-dlp below the minimum release', tooOldYtdlp],
    ['a missing yt-dlp', missingYtdlp],
    ['a yt-dlp that cannot start', brokenYtdlp],
  ])('parses %s unchanged', (_label, input) => {
    expect(YtdlpHealthSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['an unknown status', { ...brewYtdlp, status: 'stale' }],
    ['a capitalised status', { ...brewYtdlp, status: 'OK' }],
    ['a missing status', without(brewYtdlp, 'status')],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(YtdlpHealthSchema, input)).toEqual([['status']])
  })

  it.each(['path', 'source', 'version', 'releaseDate', 'ageDays', 'stale', 'meetsMinimum'])(
    'requires %s when yt-dlp is ok',
    (field) => {
      expect(issuePaths(YtdlpHealthSchema, without(brewYtdlp, field))).toEqual([[field]])
    },
  )

  it.each([
    ['an impossible day', '2026-02-30'],
    ['yt-dlp’s dotted version format', '2026.08.19'],
    ['a timestamp', '2026-08-19T00:00:00Z'],
    ['an empty string', ''],
  ])('rejects a releaseDate that is %s', (_label, releaseDate) => {
    expect(issuePaths(YtdlpHealthSchema, { ...brewYtdlp, releaseDate })).toEqual([['releaseDate']])
  })

  it.each([
    ['negative', -1],
    ['fractional', 44.5],
    ['NaN', Number.NaN],
    ['a numeric string', '44'],
  ])('rejects an ageDays that is %s', (_label, ageDays) => {
    expect(issuePaths(YtdlpHealthSchema, { ...brewYtdlp, ageDays })).toEqual([['ageDays']])
  })

  it.each([
    ['source', 'brew'],
    ['path', ''],
    ['version', ''],
    ['stale', 'no'],
  ])('rejects an ok yt-dlp with %s %j', (field, value) => {
    expect(issuePaths(YtdlpHealthSchema, { ...brewYtdlp, [field]: value })).toEqual([[field]])
  })

  it.each([
    ['missing without a message', without(missingYtdlp, 'message'), 'message'],
    ['missing with an empty message', { ...missingYtdlp, message: '' }, 'message'],
    ['error without a message', without(brokenYtdlp, 'message'), 'message'],
    ['error without the path it found', without(brokenYtdlp, 'path'), 'path'],
    ['error without a source', without(brokenYtdlp, 'source'), 'source'],
  ])('rejects %s', (_label, input, field) => {
    expect(issuePaths(YtdlpHealthSchema, input)).toEqual([[field]])
  })

  it('strips the version fields from a missing yt-dlp instead of rejecting them', () => {
    expect(YtdlpHealthSchema.parse({ ...missingYtdlp, version: '2026.08.19' })).toStrictEqual(
      missingYtdlp,
    )
  })

  it('types each status with exactly its own fields', () => {
    expectTypeOf<YtdlpHealth['status']>().toEqualTypeOf<'ok' | 'missing' | 'error'>()
    expectTypeOf<Extract<YtdlpHealth, { status: 'ok' }>>().toEqualTypeOf<{
      status: 'ok'
      path: string
      source: ToolSource
      version: string
      releaseDate: string
      ageDays: number
      stale: boolean
      meetsMinimum: boolean
    }>()
    expectTypeOf<Extract<YtdlpHealth, { status: 'missing' }>>().toEqualTypeOf<{
      status: 'missing'
      message: string
    }>()
    expectTypeOf<Extract<YtdlpHealth, { status: 'error' }>>().toEqualTypeOf<{
      status: 'error'
      path: string
      source: ToolSource
      message: string
    }>()
  })
})

describe('FfmpegHealthSchema', () => {
  it.each([
    ['a Homebrew ffmpeg 8.0', brewFfmpeg],
    ['a git snapshot set with FFMPEG_PATH', snapshotFfmpeg],
    ['a build without a major version or MP3 encoder', unknownMajorFfmpeg],
    ['a missing ffmpeg', missingFfmpeg],
    ['an ffmpeg killed by a signal', brokenFfmpeg],
  ])('parses %s unchanged', (_label, input) => {
    expect(FfmpegHealthSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['null (an unknown major is omitted instead)', null],
    ['negative', -1],
    ['fractional', 8.1],
    ['a numeric string', '8'],
  ])('rejects a major that is %s', (_label, major) => {
    expect(issuePaths(FfmpegHealthSchema, { ...brewFfmpeg, major })).toEqual([['major']])
  })

  it.each(['mp3', 'meetsMinimum', 'version'])('requires %s when ffmpeg is ok', (field) => {
    expect(issuePaths(FfmpegHealthSchema, without(brewFfmpeg, field))).toEqual([[field]])
  })

  it('makes only major optional when ffmpeg is ok', () => {
    expectTypeOf<OptionalKeys<Extract<FfmpegHealth, { status: 'ok' }>>>().toEqualTypeOf<'major'>()
    expectTypeOf<Extract<FfmpegHealth, { status: 'ok' }>['mp3']>().toEqualTypeOf<boolean>()
  })
})

describe('FfprobeHealthSchema', () => {
  it.each([
    ['a Homebrew ffprobe 8.0', brewFfprobe],
    ['a build without a major version', unknownMajorFfprobe],
    ['an ffprobe missing beside FFMPEG_PATH', brokenFfprobe],
  ])('parses %s unchanged', (_label, input) => {
    expect(FfprobeHealthSchema.parse(input)).toStrictEqual(input)
  })

  it('rejects a null major', () => {
    expect(issuePaths(FfprobeHealthSchema, { ...brewFfprobe, major: null })).toEqual([['major']])
  })

  it('strips mp3, which only ffmpeg reports', () => {
    expect(FfprobeHealthSchema.parse({ ...brewFfprobe, mp3: true })).toStrictEqual(brewFfprobe)
  })

  it('has the ffmpeg fields without mp3', () => {
    expectTypeOf<Extract<FfprobeHealth, { status: 'ok' }>>().toEqualTypeOf<
      Omit<Extract<FfmpegHealth, { status: 'ok' }>, 'mp3'>
    >()
    expectTypeOf<Exclude<FfprobeHealth, { status: 'ok' }>>().toEqualTypeOf<
      Exclude<FfmpegHealth, { status: 'ok' }>
    >()
  })
})

describe('JsRuntimeSchema', () => {
  it.each([
    ['deno', brewDeno],
    ['our own node', brewNode],
    ['an unsupported old deno', { ...brewDeno, version: '2.2.12', supported: false }],
  ])('parses %s unchanged', (_label, input) => {
    expect(JsRuntimeSchema.parse(input)).toStrictEqual(input)
  })

  it.each([
    ['a runtime yt-dlp supports but we never report', { ...brewDeno, name: 'bun' }, 'name'],
    ['an empty version', { ...brewDeno, version: '' }, 'version'],
    ['an empty path', { ...brewDeno, path: '' }, 'path'],
    ['no supported flag', without(brewDeno, 'supported'), 'supported'],
  ])('rejects %s', (_label, input, field) => {
    expect(issuePaths(JsRuntimeSchema, input)).toEqual([[field]])
  })

  it('names only deno and node', () => {
    expectTypeOf<JsRuntime['name']>().toEqualTypeOf<'deno' | 'node'>()
  })
})

describe('HealthSchema', () => {
  it.each([
    ['a healthy engine', healthy],
    ['an engine with nothing installed', nothingInstalled],
    [
      'an engine with a too-old yt-dlp and a broken ffprobe',
      { ...healthy, ok: false, ytdlp: tooOldYtdlp, ffprobe: brokenFfprobe },
    ],
    [
      'git builds without a major version',
      { ...healthy, ok: false, ffmpeg: unknownMajorFfmpeg, ffprobe: unknownMajorFfprobe },
    ],
    ['an engine without any JS runtime', { ...healthy, ok: false, jsRuntimes: [] }],
  ])('parses %s unchanged', (_label, input) => {
    expect(HealthSchema.parse(input)).toStrictEqual(input)
  })

  it.each(['ok', 'checkedAt', 'ytdlp', 'ffmpeg', 'ffprobe', 'jsRuntimes'])(
    'requires %s',
    (field) => {
      expect(issuePaths(HealthSchema, without(healthy, field))).toEqual([[field]])
    },
  )

  it.each([
    ['a date without a time', '2026-10-02'],
    ['a local time with an offset (the server always sends UTC)', '2026-10-02T10:00:00+02:00'],
    ['Date.toString() output', 'Fri Oct 02 2026 10:00:00 GMT+0200'],
  ])('rejects a checkedAt that is %s', (_label, checkedAt) => {
    expect(issuePaths(HealthSchema, { ...healthy, checkedAt })).toEqual([['checkedAt']])
  })

  it('accepts what Date.toISOString() produces as checkedAt', () => {
    const checkedAt = new Date('2026-10-02T10:00:00+02:00').toISOString()
    expect(HealthSchema.parse({ ...healthy, checkedAt }).checkedAt).toBe('2026-10-02T08:00:00.000Z')
  })

  it('reports an invalid tool at its nested path', () => {
    const input = {
      ...healthy,
      ytdlp: { ...brokenYtdlp, message: '' },
      ffmpeg: { ...brewFfmpeg, major: null },
      jsRuntimes: [brewDeno, { ...brewNode, name: 'bun' }],
    }
    expect(issuePaths(HealthSchema, input)).toEqual([
      ['ytdlp', 'message'],
      ['ffmpeg', 'major'],
      ['jsRuntimes', 1, 'name'],
    ])
  })

  it('rejects an ok flag that is not a boolean', () => {
    expect(issuePaths(HealthSchema, { ...healthy, ok: 'true' })).toEqual([['ok']])
  })

  it('types every tool with its own schema', () => {
    expectTypeOf<Health>().toEqualTypeOf<{
      ok: boolean
      checkedAt: string
      ytdlp: YtdlpHealth
      ffmpeg: FfmpegHealth
      ffprobe: FfprobeHealth
      jsRuntimes: JsRuntime[]
    }>()
  })

  it('accepts the same shape it outputs (no transforms or defaults)', () => {
    expectTypeOf<z.input<typeof HealthSchema>>().toEqualTypeOf<Health>()
  })
})
