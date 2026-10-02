import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Health } from './health.ts'
import { type HealthProblem, healthProblems, shortVersion } from './health-problems.ts'
import { brewDeno, brewFfmpeg, brewFfprobe, brewYtdlp, healthy } from './test-helpers.ts'

// Messages are spelled out in full: the server prints them at boot and the UI shows them.

const problems = (patch: Partial<Health>) => healthProblems({ ...healthy, ...patch })

describe('healthProblems', () => {
  it('is empty for a healthy engine', () => {
    expect(healthProblems(healthy)).toEqual([])
  })

  it.each([
    [
      'missing',
      {
        status: 'missing',
        message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
      },
    ],
    [
      'broken',
      {
        status: 'error',
        path: '/x/yt-dlp',
        source: 'env',
        message: 'YTDLP_PATH: /x/yt-dlp does not exist.',
      },
    ],
  ] as const)('passes on the message of a %s yt-dlp as an error', (_label, ytdlp) => {
    expect(problems({ ok: false, ytdlp })).toEqual([
      { tool: 'yt-dlp', severity: 'error', message: ytdlp.message },
    ])
  })

  it('tells how to upgrade a yt-dlp below the minimum, without also calling it stale', () => {
    const ytdlp = {
      ...brewYtdlp,
      version: '2025.10.22',
      releaseDate: '2025-10-22',
      ageDays: 345,
      stale: true,
      meetsMinimum: false,
    }
    expect(problems({ ok: false, ytdlp })).toEqual([
      {
        tool: 'yt-dlp',
        severity: 'error',
        message: 'yt-dlp 2025.10.22 is too old: run `brew upgrade yt-dlp`.',
      },
    ])
  })

  it('warns about a stale yt-dlp with its age', () => {
    const ytdlp = { ...brewYtdlp, version: '2026.06.09', ageDays: 115, stale: true }
    expect(problems({ ytdlp })).toEqual([
      {
        tool: 'yt-dlp',
        severity: 'warning',
        message:
          'yt-dlp 2026.06.09 is 115 days old (over 60). If YouTube fails, run `brew upgrade yt-dlp` or point YTDLP_PATH at a nightly build.',
      },
    ])
  })

  it.each([
    ['ffmpeg', { ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' } }],
    ['ffprobe', { ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' } }],
  ] as const)('passes on the message of a missing %s as an error', (tool, patch) => {
    expect(problems({ ok: false, ...patch })).toEqual([
      { tool, severity: 'error', message: `${tool} is not on PATH.` },
    ])
  })

  it('passes on the message of a broken ffprobe as an error', () => {
    const ffprobe = {
      status: 'error',
      path: '/x/ffprobe',
      source: 'env',
      message: 'FFMPEG_PATH: /x/ffprobe does not exist.',
    } as const
    expect(problems({ ok: false, ffprobe })).toEqual([
      { tool: 'ffprobe', severity: 'error', message: 'FFMPEG_PATH: /x/ffprobe does not exist.' },
    ])
  })

  it('says it needs 8 or newer when it cannot tell the ffmpeg or ffprobe major', () => {
    // A git build whose version string and libavformat both failed to parse: no major at all.
    const unknownMajor = {
      status: 'ok',
      path: '/usr/local/bin/ff',
      source: 'path',
      version: 'custom-build',
      meetsMinimum: false,
    } as const
    const ffmpeg = { ...unknownMajor, mp3: true }
    const ffprobe = unknownMajor
    expect(problems({ ok: false, ffmpeg, ffprobe })).toEqual([
      {
        tool: 'ffmpeg',
        severity: 'error',
        message: "ffmpeg custom-build: can't tell its version; DJ Scraper needs 8 or newer.",
      },
      {
        tool: 'ffprobe',
        severity: 'error',
        message: "ffprobe custom-build: can't tell its version; DJ Scraper needs 8 or newer.",
      },
    ])
  })

  it('tells how to upgrade ffmpeg and ffprobe older than 8', () => {
    const ffmpeg = { ...brewFfmpeg, version: '7.1.1', major: 7, meetsMinimum: false }
    const ffprobe = { ...brewFfprobe, version: '7.1.1', major: 7, meetsMinimum: false }
    expect(problems({ ok: false, ffmpeg, ffprobe })).toEqual([
      {
        tool: 'ffmpeg',
        severity: 'error',
        message: 'ffmpeg 7.1.1 is older than 8: run `brew upgrade ffmpeg`.',
      },
      {
        tool: 'ffprobe',
        severity: 'error',
        message: 'ffprobe 7.1.1 is older than 8: run `brew upgrade ffmpeg`.',
      },
    ])
  })

  it('warns that MP3 downloads will fail without libmp3lame', () => {
    expect(problems({ ffmpeg: { ...brewFfmpeg, mp3: false } })).toEqual([
      {
        tool: 'ffmpeg',
        severity: 'warning',
        message: 'ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.',
      },
    ])
  })

  it('does not add an MP3 warning for a missing ffmpeg', () => {
    const ffmpeg = { status: 'missing', message: 'ffmpeg is not on PATH.' } as const
    expect(problems({ ok: false, ffmpeg })).toEqual([
      { tool: 'ffmpeg', severity: 'error', message: 'ffmpeg is not on PATH.' },
    ])
  })

  it.each([
    ['no runtime at all', []],
    [
      'only an old deno and an old node',
      [
        { ...brewDeno, version: '2.2.12', supported: false },
        { name: 'node', path: '/usr/local/bin/node', version: '20.19.0', supported: false },
      ],
    ],
  ] as const)('reports an error when there is %s for YouTube', (_label, jsRuntimes) => {
    expect(problems({ ok: false, jsRuntimes: [...jsRuntimes] })).toEqual([
      {
        tool: 'js-runtime',
        severity: 'error',
        message:
          'No supported JS runtime for YouTube: install deno (`brew install deno`) or use Node 22+.',
      },
    ])
  })

  it('accepts an old deno when our node is supported', () => {
    const jsRuntimes = [
      { ...brewDeno, version: '2.2.12', supported: false },
      { name: 'node', path: '/usr/local/bin/node', version: '24.12.0', supported: true },
    ] as const
    expect(problems({ jsRuntimes: [...jsRuntimes] })).toEqual([])
  })

  it('lists one problem per line, in tool order, the mp3 warning after ffprobe', () => {
    const result = problems({
      ok: false,
      ytdlp: { status: 'missing', message: 'no yt-dlp' },
      ffmpeg: { ...brewFfmpeg, mp3: false },
      ffprobe: { status: 'missing', message: 'no ffprobe' },
      jsRuntimes: [],
    })
    expect(result.map(({ tool, severity }) => `${severity} ${tool}`)).toEqual([
      'error yt-dlp',
      'error ffprobe',
      'warning ffmpeg',
      'error js-runtime',
    ])
    expect(result.map((problem) => problem.message)).toEqual([
      'no yt-dlp',
      'no ffprobe',
      'ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.',
      'No supported JS runtime for YouTube: install deno (`brew install deno`) or use Node 22+.',
    ])
  })

  it('has exactly the documented shape', () => {
    expectTypeOf<HealthProblem>().toEqualTypeOf<{
      tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'js-runtime'
      severity: 'error' | 'warning'
      message: string
    }>()
    expectTypeOf(healthProblems).toEqualTypeOf<(health: Health) => HealthProblem[]>()
  })
})

describe('shortVersion', () => {
  it.each([
    [[22, 0, 0], '22'],
    [[2, 3, 0], '2.3'],
    [[2, 3, 1], '2.3.1'],
    [[2, 0, 1], '2.0.1'],
    [[0, 0, 0], '0'],
  ] as const)('writes %j as %s', (parts, expected) => {
    expect(shortVersion(parts)).toBe(expected)
  })
})
