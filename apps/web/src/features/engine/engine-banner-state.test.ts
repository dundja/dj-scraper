import { type FfmpegHealth, healthProblems } from '@dj-scraper/shared'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import { healthWith, healthy, missingFfprobe, staleYtdlp } from '@/test/health.ts'
import {
  bannerState,
  installAllCommand,
  readDismissedWarnings,
  saveDismissedWarnings,
  warningKeys,
} from './engine-banner-state.ts'
import { engineState } from './engine-state.ts'

const missingYtdlp = {
  status: 'missing',
  message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
} as const
const missingFfmpeg = {
  status: 'missing',
  message: 'ffmpeg is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
} as const
const ffmpegWithoutMp3 = {
  status: 'ok',
  path: '/usr/local/bin/ffmpeg',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
  mp3: false,
} satisfies FfmpegHealth

const fromHealth = (health = healthy) => engineState({ data: health, error: null })
/** Nothing dismissed this session. */
const none: ReadonlySet<string> = new Set()
const dismissed = (...keys: string[]): ReadonlySet<string> => new Set(keys)

describe('bannerState', () => {
  it('shows nothing while the first check runs, or when all is fine', () => {
    expect(bannerState(engineState({ data: undefined, error: null }), none)).toEqual({
      kind: 'none',
    })
    expect(bannerState(fromHealth(healthy), none)).toEqual({ kind: 'none' })
  })

  it('says the server is offline when the check never reached it', () => {
    const error = new ApiError({
      kind: 'unreachable',
      message: "Can't reach the DJ Scraper server.",
    })
    expect(bannerState(engineState({ data: healthy, error }), none)).toEqual({
      kind: 'offline',
    })
  })

  it('passes on an unexpected answer', () => {
    const error = new ApiError({ kind: 'invalid_response', status: 200, message: 'Unexpected' })
    expect(bannerState(engineState({ data: undefined, error }), none)).toEqual({
      kind: 'unexpected',
      error,
    })
  })

  it('lists every problem when the engine cannot download', () => {
    expect(bannerState(fromHealth(missingFfprobe), none)).toEqual({
      kind: 'problems',
      health: missingFfprobe,
      problems: healthProblems(missingFfprobe),
    })
  })

  it('adds one install command when yt-dlp and ffmpeg are both missing', () => {
    const fresh = healthWith({
      ok: false,
      ytdlp: missingYtdlp,
      ffmpeg: missingFfmpeg,
      ffprobe: {
        ...missingFfmpeg,
        message: missingFfmpeg.message.replace('ffmpeg is', 'ffprobe is'),
      },
    })
    const state = bannerState(fromHealth(fresh), none)
    expect(state).toMatchObject({ kind: 'problems', installAll: 'brew install yt-dlp ffmpeg' })
    if (state.kind === 'problems') expect(state.problems).toHaveLength(3)
  })

  it('shows warnings with their keys, and nothing once those were dismissed', () => {
    const state = bannerState(fromHealth(staleYtdlp), none)
    expect(state).toEqual({
      kind: 'warnings',
      health: staleYtdlp,
      problems: healthProblems(staleYtdlp),
      keys: ['yt-dlp:warning'],
    })
    expect(bannerState(fromHealth(staleYtdlp), dismissed('yt-dlp:warning'))).toEqual({
      kind: 'none',
    })
  })

  it('shows a new kind of warning even when another was dismissed', () => {
    const noMp3 = healthWith({ ffmpeg: ffmpegWithoutMp3 })
    expect(bannerState(fromHealth(noMp3), dismissed('yt-dlp:warning'))).toMatchObject({
      kind: 'warnings',
      keys: ['ffmpeg:warning'],
    })
    // Joined by a new one, a dismissed warning shows again with it.
    const both = healthWith({ ytdlp: staleYtdlp.ytdlp, ffmpeg: ffmpegWithoutMp3 })
    expect(bannerState(fromHealth(both), dismissed('yt-dlp:warning'))).toMatchObject({
      kind: 'warnings',
      keys: ['yt-dlp:warning', 'ffmpeg:warning'],
    })
  })

  it('keeps the rest dismissed when one of the dismissed warnings is fixed', () => {
    const both = healthWith({ ytdlp: staleYtdlp.ytdlp, ffmpeg: ffmpegWithoutMp3 })
    const seen = dismissed(...warningKeys(healthProblems(both)))
    expect(bannerState(fromHealth(both), seen)).toEqual({ kind: 'none' })

    // ffmpeg reinstalled with LAME, then Check again: the stale yt-dlp stays dismissed.
    expect(bannerState(fromHealth(staleYtdlp), seen)).toEqual({ kind: 'none' })
  })

  it('never hides problems, whatever was dismissed', () => {
    const keys = warningKeys(healthProblems(missingFfprobe))
    expect(bannerState(fromHealth(missingFfprobe), dismissed(...keys))).toMatchObject({
      kind: 'problems',
    })
  })
})

describe('warningKeys', () => {
  it("names warnings by tool and severity, not by words that change (a stale yt-dlp's age)", () => {
    const { ytdlp } = staleYtdlp
    if (ytdlp.status !== 'ok') throw new Error('staleYtdlp has a found yt-dlp')
    const older = healthWith({ ytdlp: { ...ytdlp, ageDays: ytdlp.ageDays + 1 } })
    expect(healthProblems(older)[0]?.message).not.toBe(healthProblems(staleYtdlp)[0]?.message)
    expect(warningKeys(healthProblems(older))).toEqual(warningKeys(healthProblems(staleYtdlp)))
    const both = healthWith({ ytdlp: staleYtdlp.ytdlp, ffmpeg: ffmpegWithoutMp3 })
    expect(warningKeys(healthProblems(both))).toEqual(['yt-dlp:warning', 'ffmpeg:warning'])
  })
})

describe('installAllCommand', () => {
  it('is needed only when more than one formula is missing', () => {
    expect(installAllCommand(healthy)).toBeUndefined()
    expect(installAllCommand(healthWith({ ok: false, ytdlp: missingYtdlp }))).toBeUndefined()
    expect(
      installAllCommand(healthWith({ ok: false, ffmpeg: missingFfmpeg, ffprobe: missingFfmpeg })),
    ).toBeUndefined()
    expect(
      installAllCommand(healthWith({ ok: false, ytdlp: missingYtdlp, ffprobe: missingFfmpeg })),
    ).toBe('brew install yt-dlp ffmpeg')
  })

  it("leaves out a broken override, which installing doesn't fix", () => {
    const broken = healthWith({
      ok: false,
      ytdlp: {
        status: 'error',
        path: '/opt/yt-dlp/yt-dlp',
        source: 'env',
        message: 'YTDLP_PATH: /opt/yt-dlp/yt-dlp is not executable (chmod +x).',
      },
      ffmpeg: missingFfmpeg,
    })
    expect(installAllCommand(broken)).toBeUndefined()
  })
})

describe('dismissed warnings in sessionStorage', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => sessionStorage.clear())

  it('remembers the dismissed keys for the session', () => {
    expect(readDismissedWarnings()).toEqual(none)
    saveDismissedWarnings(dismissed('yt-dlp:warning', 'ffmpeg:warning'))
    expect(readDismissedWarnings()).toEqual(dismissed('yt-dlp:warning', 'ffmpeg:warning'))
  })

  it('reads a key stored before as one entry', () => {
    sessionStorage.setItem('dj-scraper:dismissed-engine-warnings', 'yt-dlp:warning')
    expect(readDismissedWarnings()).toEqual(dismissed('yt-dlp:warning'))
  })

  it('treats blocked storage as nothing dismissed, without throwing', () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    // Restores only these two: vi.restoreAllMocks() would also unhook setup.ts's console guard.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    onTestFinished(() => {
      getItem.mockRestore()
      setItem.mockRestore()
    })

    expect(() => saveDismissedWarnings(dismissed('yt-dlp:warning'))).not.toThrow()
    expect(readDismissedWarnings()).toEqual(none)
  })
})
