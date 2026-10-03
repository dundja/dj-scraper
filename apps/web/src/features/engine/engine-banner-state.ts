import type { Health, HealthProblem } from '@dj-scraper/shared'
import type { EngineState } from './engine-state.ts'

/** What the banner under the header shows, from the same engine state as the header chip. */
export type BannerState =
  /** All fine, the first check still runs, or the warnings were dismissed. */
  | { kind: 'none' }
  | { kind: 'offline' }
  /** The server answered the health check with an error or a body we can't read. */
  | { kind: 'unexpected'; error: Error }
  /**
   * The engine can't download (Health.ok false): every problem, errors and warnings. `installAll`
   * installs every missing tool at once, when more than one formula is missing.
   */
  | { kind: 'problems'; health: Health; problems: HealthProblem[]; installAll?: string }
  /** Only warnings: downloads work. `keys` name them for "dismiss for this session". */
  | { kind: 'warnings'; health: Health; problems: HealthProblem[]; keys: string[] }

/**
 * `dismissed`: the keys of the warnings dismissed this session. The warnings stay hidden while each
 * of them was dismissed, so one going away (fixed) doesn't bring back the others.
 */
export function bannerState(state: EngineState, dismissed: ReadonlySet<string>): BannerState {
  switch (state.kind) {
    case 'checking':
    case 'ready':
      return { kind: 'none' }
    case 'offline':
      return { kind: 'offline' }
    case 'unexpected':
      return { kind: 'unexpected', error: state.error }
    case 'attention': {
      const { health, problems } = state
      const installAll = installAllCommand(health)
      return installAll === undefined
        ? { kind: 'problems', health, problems }
        : { kind: 'problems', health, problems, installAll }
    }
    case 'warnings': {
      const keys = warningKeys(state.problems)
      if (keys.every((key) => dismissed.has(key))) return { kind: 'none' }
      return { kind: 'warnings', health: state.health, problems: state.problems, keys }
    }
  }
}

/**
 * Names each warning by its tool, not its words: a stale yt-dlp's warning counts its age in days,
 * and a dismissed warning shouldn't come back the next day. A new kind of warning does.
 */
export function warningKeys(problems: readonly HealthProblem[]): string[] {
  return problems.map((problem) => `${problem.tool}:${problem.severity}`)
}

/**
 * `brew install yt-dlp ffmpeg` when both are missing from PATH: each problem names its own install
 * command, so one that covers them all helps only then. ffprobe comes with ffmpeg. A broken override
 * (YTDLP_PATH, FFMPEG_PATH) isn't fixed by installing, so it doesn't count.
 */
export function installAllCommand(health: Health): string | undefined {
  const formulas = new Set<string>()
  if (health.ytdlp.status === 'missing') formulas.add('yt-dlp')
  if (health.ffmpeg.status === 'missing' || health.ffprobe.status === 'missing') {
    formulas.add('ffmpeg')
  }
  return formulas.size > 1 ? `brew install ${[...formulas].join(' ')}` : undefined
}

const DISMISSED_STORAGE_KEY = 'dj-scraper:dismissed-engine-warnings'

/**
 * The keys of the warnings dismissed in this tab's session, stored space-separated (sessionStorage:
 * a reload keeps them dismissed, a new tab or browser session shows them again). Storage can be
 * blocked: then nothing was dismissed.
 */
export function readDismissedWarnings(): ReadonlySet<string> {
  try {
    const stored = sessionStorage.getItem(DISMISSED_STORAGE_KEY) ?? ''
    return new Set(stored.split(' ').filter((key) => key !== ''))
  } catch {
    return new Set()
  }
}

/** Remembers dismissed warnings for the session; with storage blocked, only until a reload. */
export function saveDismissedWarnings(keys: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(DISMISSED_STORAGE_KEY, [...keys].join(' '))
  } catch {
    // The banner's own state still hides them.
  }
}
