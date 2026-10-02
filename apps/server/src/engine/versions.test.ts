import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  daysSince,
  isSupportedNode,
  meetsFfmpegMinimum,
  parseDenoVersion,
  parseFfVersion,
  parseYtdlpVersion,
  ytdlpFreshness,
} from './versions.ts'

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/engine')
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8')

/** `ffmpeg -version` output with a chosen first line, libavformat major and configuration. */
const ffOutput = (firstLine: string, lavfMajor = 62, config = '--enable-gpl') =>
  [
    `${firstLine} Copyright (c) 2000-2026 the FFmpeg developers`,
    'built with Apple clang version 17.0.0',
    `configuration: ${config}`,
    `libavformat    ${lavfMajor}.  3.100 / ${lavfMajor}.  3.100`,
    '',
  ].join('\n')

describe('parseYtdlpVersion', () => {
  it.each([
    ['the recorded Homebrew stable', 'ytdlp-version-2026.08.19.txt', '2026.08.19', '2026-08-19'],
    [
      'the recorded nightly',
      'ytdlp-version-2026.09.27.232945.txt',
      '2026.09.27.232945',
      '2026-09-27',
    ],
  ])('reads %s', (_label, file, version, releaseDate) => {
    expect(parseYtdlpVersion(fixture(file))).toEqual({ version, releaseDate })
  })

  it.each([
    ['a same-day stable re-release', '2026.08.19.1\n', '2026.08.19.1', '2026-08-19'],
    ['a master build', '2026.09.27.220929\n', '2026.09.27.220929', '2026-09-27'],
    ['a PEP 440-normalized version', '2026.8.9\n', '2026.8.9', '2026-08-09'],
    ['CRLF output after a blank line', '\r\n2026.08.19\r\n', '2026.08.19', '2026-08-19'],
    ['output without a trailing newline', '2026.08.19', '2026.08.19', '2026-08-19'],
    ['a leap day', '2024.02.29\n', '2024.02.29', '2024-02-29'],
  ])('accepts %s', (_label, stdout, version, releaseDate) => {
    expect(parseYtdlpVersion(stdout)).toEqual({ version, releaseDate })
  })

  it.each([
    ['empty output', ''],
    ['only blank lines', '\n\r\n'],
    ['another program', 'hello world\n'],
    ['an impossible date', '2026.02.30\n'],
    ['a non-leap February 29', '2025.02.29\n'],
    ['month 13', '2026.13.01\n'],
    ['day 0', '2026.08.00\n'],
    ['a version with a suffix', '2026.08.19-patched\n'],
    ['a prefixed version', 'youtube-dl 2021.12.17\n'],
    ['a warning before the version', 'WARNING: something\n2026.08.19\n'],
  ])('rejects %s', (_label, stdout) => {
    expect(parseYtdlpVersion(stdout)).toBeNull()
  })
})

describe('daysSince', () => {
  it('counts whole UTC days, whatever the local time of day', () => {
    const now = new Date('2026-10-02T10:00:00+02:00')
    expect(daysSince('2026-08-19', now)).toBe(44)
    expect(daysSince('2026-10-02', new Date('2026-10-02T00:00:00Z'))).toBe(0)
    expect(daysSince('2026-10-02', new Date('2026-10-02T23:59:59.999Z'))).toBe(0)
    expect(daysSince('2026-10-01', new Date('2026-10-02T00:00:00Z'))).toBe(1)
  })

  it('is never negative when the build is from the future (clock skew)', () => {
    expect(daysSince('2026-10-03', new Date('2026-10-02T23:00:00Z'))).toBe(0)
  })
})

describe('ytdlpFreshness', () => {
  const now = new Date('2026-10-02T08:00:00Z')

  it('is stale only after more than 60 days', () => {
    expect(ytdlpFreshness('2026-08-03', now)).toMatchObject({ ageDays: 60, stale: false })
    expect(ytdlpFreshness('2026-08-02', now)).toMatchObject({ ageDays: 61, stale: true })
  })

  it('requires 2025-11-12, the first release with --js-runtimes', () => {
    expect(ytdlpFreshness('2025-11-12', now).meetsMinimum).toBe(true)
    expect(ytdlpFreshness('2025-11-11', now).meetsMinimum).toBe(false)
    expect(ytdlpFreshness('2025-10-22', now).meetsMinimum).toBe(false)
  })

  it('reports a stale yt-dlp that still meets the minimum separately', () => {
    expect(ytdlpFreshness('2026-01-01', now)).toEqual({
      ageDays: 274,
      stale: true,
      meetsMinimum: true,
    })
  })
})

describe('parseFfVersion', () => {
  it.each([
    ['ffmpeg-version-8.0-brew.txt', 'ffmpeg', '8.0', 8],
    ['ffprobe-version-8.0-brew.txt', 'ffprobe', '8.0', 8],
    ['ffmpeg-version-9.0.2-tessus.txt', 'ffmpeg', '9.0.2-tessus', 9],
    ['ffmpeg-version-N-127085-tessus.txt', 'ffmpeg', 'N-127085-g0eb6a369c69-tessus', 9],
  ] as const)('reads the recorded %s', (file, program, version, major) => {
    expect(parseFfVersion(fixture(file), program)).toEqual({ version, major, mp3: true })
  })

  it.each([
    ['point release', 'ffmpeg version 8.0.1', 8],
    ['static build', 'ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/ ', 7],
    ['Ubuntu package', 'ffmpeg version 6.1.1-3ubuntu5', 6],
    ['Debian package', 'ffmpeg version 5.1.6-0+deb12u1', 5],
    ['package with an epoch', 'ffmpeg version 7:6.1.1-3ubuntu5', 6],
    ['Arch tag build', 'ffmpeg version n8.0', 8],
    ['release-branch git build', 'ffmpeg version n8.0-12-g1234abcd', 8],
    ['gyan release', 'ffmpeg version 8.0-essentials_build-www.gyan.dev', 8],
    ['two-digit major', 'ffmpeg version 10.0', 10],
  ])('takes the major from the version of a %s, not from libavformat', (_label, line, major) => {
    expect(parseFfVersion(ffOutput(line, 50), 'ffmpeg')?.major).toBe(major)
  })

  it.each([
    ['master build', 'ffmpeg version N-121234-gabcdef0123', 62, 8],
    ['master build with a date suffix', 'ffmpeg version N-121234-gabcdef0123-20251001', 61, 7],
    ['shallow clone', 'ffmpeg version git-2025-10-01-abcdef1', 63, 9],
    [
      'gyan git build',
      'ffmpeg version 2025-09-28-git-0fdb5829e3-essentials_build-www.gyan.dev',
      62,
      8,
    ],
  ])('derives the major of a %s from libavformat (minus 54)', (_label, line, lavf, major) => {
    expect(parseFfVersion(ffOutput(line, lavf), 'ffmpeg')?.major).toBe(major)
  })

  it('omits the major (rather than null) when neither the version nor libavformat parses', () => {
    const stdout = 'ffmpeg version N-1-gabc Copyright (c) 2000-2026 the FFmpeg developers\n'
    const parsed = parseFfVersion(stdout, 'ffmpeg')
    expect(parsed).toStrictEqual({ version: 'N-1-gabc', mp3: false })
    expect(parsed).not.toHaveProperty('major')
  })

  it('reports whether the build has libmp3lame, the encoder yt-dlp uses for MP3', () => {
    expect(parseFfVersion(ffOutput('ffmpeg version 8.0'), 'ffmpeg')?.mp3).toBe(false)
    const lame = ffOutput('ffmpeg version 8.0', 62, '--enable-gpl --enable-libmp3lame')
    expect(parseFfVersion(lame, 'ffmpeg')?.mp3).toBe(true)
    const lookalike = ffOutput('ffmpeg version 8.0', 62, '--enable-libmp3lame-fake')
    expect(parseFfVersion(lookalike, 'ffmpeg')?.mp3).toBe(false)
  })

  it('rejects the other program and non-ffmpeg output', () => {
    expect(parseFfVersion(fixture('ffprobe-version-8.0-brew.txt'), 'ffmpeg')).toBeNull()
    expect(parseFfVersion(fixture('ffmpeg-version-8.0-brew.txt'), 'ffprobe')).toBeNull()
    expect(parseFfVersion('hello world\n', 'ffprobe')).toBeNull()
    expect(parseFfVersion('', 'ffmpeg')).toBeNull()
  })
})

describe('meetsFfmpegMinimum', () => {
  it('needs ffmpeg 8 or newer, and a known major', () => {
    expect([7, 8, 9, undefined].map(meetsFfmpegMinimum)).toEqual([false, true, true, false])
  })
})

describe('parseDenoVersion', () => {
  it('reads the recorded Homebrew deno', () => {
    expect(parseDenoVersion(fixture('deno-version-2.9.7.txt'))).toEqual({
      version: '2.9.7',
      supported: true,
    })
  })

  it.each([
    ['the minimum, 2.3.0', 'deno 2.3.0 (stable, release, aarch64-apple-darwin)\n', '2.3.0', true],
    ['an older 2.2.12', 'deno 2.2.12 (stable, release, aarch64-apple-darwin)\n', '2.2.12', false],
    ['deno 1.x', 'deno 1.46.3 (stable, release, x86_64-apple-darwin)\n', '1.46.3', false],
    ['a canary build', 'deno 2.5.0+abc1234 (canary, release, x)\n', '2.5.0+abc1234', true],
  ])('reads %s', (_label, stdout, version, supported) => {
    expect(parseDenoVersion(stdout)).toEqual({ version, supported })
  })

  it.each([
    ['node --version output', 'v24.12.0\n'],
    ['empty output', ''],
    ['a version without a patch number', 'deno 2.9 (stable)\n'],
  ])('rejects %s', (_label, stdout) => {
    expect(parseDenoVersion(stdout)).toBeNull()
  })
})

describe('isSupportedNode', () => {
  it.each([
    ['21.7.3', false],
    ['22.0.0', true],
    ['24.12.0', true],
    ['not-a-version', false],
  ])('%s -> %s', (version, supported) => {
    expect(isSupportedNode(version)).toBe(supported)
  })

  it('accepts the Node running these tests (the repo requires Node 24)', () => {
    expect(isSupportedNode(process.versions.node)).toBe(true)
  })
})
