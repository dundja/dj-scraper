import { FFMPEG_MIN_MAJOR, NODE_MIN_VERSION, YTDLP_STALE_AFTER_DAYS } from './engine.ts'
import type { Health } from './health.ts'

export type HealthProblem = {
  tool: 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'js-runtime'
  /** 'error' exactly when the problem makes Health.ok false; 'warning' otherwise (stale yt-dlp, ffmpeg without MP3). */
  severity: 'error' | 'warning'
  /** One sentence for humans; shell commands are wrapped in backticks, e.g. "run `brew upgrade yt-dlp`." */
  message: string
}

/**
 * What is wrong with the engine, one problem per line of the server's boot log, in tool order.
 * Empty when everything is fine. The UI shows the same words.
 */
export function healthProblems(health: Health): HealthProblem[] {
  const problems: HealthProblem[] = []
  const error = (tool: HealthProblem['tool'], message: string) =>
    problems.push({ tool, severity: 'error', message })
  const warning = (tool: HealthProblem['tool'], message: string) =>
    problems.push({ tool, severity: 'warning', message })

  const { ytdlp, ffmpeg, ffprobe, jsRuntimes } = health
  if (ytdlp.status !== 'ok') error('yt-dlp', ytdlp.message)
  else if (!ytdlp.meetsMinimum)
    error('yt-dlp', `yt-dlp ${ytdlp.version} is too old: run \`brew upgrade yt-dlp\`.`)
  else if (ytdlp.stale) {
    warning(
      'yt-dlp',
      `yt-dlp ${ytdlp.version} is ${ytdlp.ageDays} days old (over ${YTDLP_STALE_AFTER_DAYS}). If YouTube fails, run \`brew upgrade yt-dlp\` or point YTDLP_PATH at a nightly build.`,
    )
  }

  for (const [name, tool] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', ffprobe],
  ] as const) {
    if (tool.status !== 'ok') error(name, tool.message)
    else if (tool.major === undefined) {
      error(
        name,
        `${name} ${tool.version}: can't tell its version; DJ Scraper needs ${FFMPEG_MIN_MAJOR} or newer.`,
      )
    } else if (!tool.meetsMinimum) {
      error(
        name,
        `${name} ${tool.version} is older than ${FFMPEG_MIN_MAJOR}: run \`brew upgrade ffmpeg\`.`,
      )
    }
  }
  if (ffmpeg.status === 'ok' && !ffmpeg.mp3)
    warning('ffmpeg', 'ffmpeg has no MP3 encoder (libmp3lame), so MP3 downloads will fail.')

  if (!jsRuntimes.some((runtime) => runtime.supported)) {
    error(
      'js-runtime',
      `No supported JS runtime for YouTube: install deno (\`brew install deno\`) or use Node ${shortVersion(NODE_MIN_VERSION)}+.`,
    )
  }
  return problems
}

/** [22, 0, 0] → '22', [2, 3, 0] → '2.3': trailing zero parts dropped, as people write versions. */
export function shortVersion(parts: readonly number[]): string {
  const end = parts.findLastIndex((part) => part !== 0) + 1
  return parts.slice(0, Math.max(end, 1)).join('.')
}
