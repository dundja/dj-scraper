import {
  DENO_MIN_VERSION,
  FFMPEG_MIN_MAJOR,
  NODE_MIN_VERSION,
  YTDLP_MIN_RELEASE,
  YTDLP_STALE_AFTER_DAYS,
} from '@dj-scraper/shared'

const DAY_MS = 86_400_000

export type YtdlpVersion = { version: string; releaseDate: string }

// Stable YYYY.MM.DD, same-day re-release YYYY.MM.DD.N, nightly/master YYYY.MM.DD.HHMMSS.
// One-digit month/day tolerates PEP 440-normalized versions (2026.8.19).
const YTDLP_VERSION_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.\d+)?$/

/** `yt-dlp --version` stdout → version and release day, or null for anything else. */
export function parseYtdlpVersion(stdout: string): YtdlpVersion | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  const match = line === undefined ? null : YTDLP_VERSION_RE.exec(line)
  if (line === undefined || match === null) return null
  const releaseDate = isoDay(Number(match[1]), Number(match[2]), Number(match[3]))
  return releaseDate ? { version: line, releaseDate } : null
}

export type YtdlpFreshness = { ageDays: number; stale: boolean; meetsMinimum: boolean }

export function ytdlpFreshness(releaseDate: string, now: Date): YtdlpFreshness {
  const ageDays = daysSince(releaseDate, now)
  return {
    ageDays,
    stale: ageDays > YTDLP_STALE_AFTER_DAYS,
    // Zero-padded ISO days compare correctly as strings.
    meetsMinimum: releaseDate >= YTDLP_MIN_RELEASE,
  }
}

/** Whole UTC days from `day` (YYYY-MM-DD) to `now`; never negative (clock skew, today's build). */
export function daysSince(day: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.max(0, Math.round((today - Date.parse(`${day}T00:00:00Z`)) / DAY_MS))
}

export type FfVersion = { version: string; major?: number; mp3: boolean }

// FFMPEG_VERSION is a release (8.0), `git describe` output (N-…, n8.0-…) or git-YYYY-MM-DD-hash,
// plus an optional -<extra-version> (-tessus, -static, -3ubuntu5), sometimes after an epoch (7:).
const FF_RELEASE_RE = /^(?:\d+:)?n?(\d+)\.\d+/
const LAVF_MAJOR_RE = /^libavformat\s+(\d+)\./m
/** libavformat's major is FFmpeg's + 54 (checked at tags n4.4 through n9.0). */
const LAVF_MAJOR_OFFSET = 54

/** `ffmpeg -version` / `ffprobe -version` stdout → version info, or null if it isn't that program. */
export function parseFfVersion(stdout: string, program: 'ffmpeg' | 'ffprobe'): FfVersion | null {
  const version = new RegExp(`^${program} version (\\S+)`, 'm').exec(stdout)?.[1]
  if (version === undefined) return null
  const release = FF_RELEASE_RE.exec(version)
  const lavf = LAVF_MAJOR_RE.exec(stdout)
  const major = release
    ? Number(release[1])
    : lavf
      ? Number(lavf[1]) - LAVF_MAJOR_OFFSET
      : undefined
  const mp3 = /--enable-libmp3lame(?:\s|$)/m.test(stdout)
  return major === undefined ? { version, mp3 } : { version, major, mp3 }
}

export function meetsFfmpegMinimum(major: number | undefined): boolean {
  return major !== undefined && major >= FFMPEG_MIN_MAJOR
}

/** `deno --version` stdout (`deno 2.9.7 (stable, release, …)`) → version, or null. */
export function parseDenoVersion(stdout: string): { version: string; supported: boolean } | null {
  const match = /^deno (\d+)\.(\d+)\.(\d+)\S*/m.exec(stdout)
  if (match === null) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  return { version: match[0].slice('deno '.length), supported: atLeast(parts, DENO_MIN_VERSION) }
}

/** process.versions.node (24.12.0) → whether yt-dlp accepts it for --js-runtimes node. */
export function isSupportedNode(version: string): boolean {
  return atLeast(version.split('.').map(Number), NODE_MIN_VERSION)
}

function atLeast(parts: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    const b = min[i] ?? 0
    if (Number.isNaN(a)) return false
    if (a !== b) return a > b
  }
  return true
}

function isoDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return valid ? date.toISOString().slice(0, 10) : null
}
