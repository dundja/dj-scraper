import type {
  DownloadFormat,
  JobStatus,
  PauseCode,
  Platform,
  PlatformQueueState,
  QueueState,
} from '@dj-scraper/shared'
import { errorHint } from '@/lib/error-text.ts'
import { formatClock } from '@/lib/format.ts'
import type { BatchGroup } from './panel-rows.ts'
import type { JobsSummary, StatusCounts } from './summary.ts'

// Words for the downloads panel. Pure; `locale` is for tests, the app passes none.

/** Which counts the panel names, in this order; queued and running jobs add up to "left". */
const COUNTED: readonly { statuses: readonly JobStatus[]; word: string }[] = [
  { statuses: ['done'], word: 'done' },
  { statuses: ['skipped'], word: 'skipped' },
  { statuses: ['failed'], word: 'failed' },
  { statuses: ['canceled'], word: 'canceled' },
  { statuses: ['queued', 'downloading', 'processing'], word: 'left' },
]

/** "8 done · 2 skipped · 1 failed · 3 left": counts of zero are left out; '' for no jobs. */
export function countsText(counts: StatusCounts): string {
  const parts: string[] = []
  for (const { statuses, word } of COUNTED) {
    const count = statuses.reduce((sum, status) => sum + counts[status], 0)
    if (count > 0) parts.push(`${count.toLocaleString('en-US')} ${word}`)
  }
  return parts.join(' · ')
}

/** A batch's own progress: "3/12" finished. */
export function batchProgressText(summary: JobsSummary): string {
  return `${summary.finished.toLocaleString('en-US')}/${summary.total.toLocaleString('en-US')}`
}

/** The same for assistive tech: "3 of 12 finished". */
export function batchProgressLabel(summary: JobsSummary): string {
  return `${summary.finished.toLocaleString('en-US')} of ${summary.total.toLocaleString('en-US')} finished`
}

/**
 * What a batch is called: its label (the playlist's or track's title), else "Single track" for one
 * job and "12 tracks" for more.
 */
export function batchTitle({ batch, jobs }: Pick<BatchGroup, 'batch' | 'jobs'>): string {
  if (batch.label !== undefined) return batch.label
  return jobs.length === 1 ? 'Single track' : `${jobs.length.toLocaleString('en-US')} tracks`
}

const FORMAT_NAMES: Record<DownloadFormat, string> = {
  mp3: 'MP3',
  m4a: 'M4A',
  aiff: 'AIFF',
  wav: 'WAV',
  flac: 'FLAC',
  original: 'Original',
}

/** The short name of a download format: "MP3", "AIFF", "Original". */
export function formatName(format: DownloadFormat): string {
  return FORMAT_NAMES[format]
}

const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  other: 'Other sites',
}

const PAUSE_REASONS: Record<PauseCode, string> = {
  rate_limited: 'rate-limited',
  bot_check: 'it asks for a bot check',
}

/** A platform the queue holds back, in words; `hint` may contain `backtick` commands. */
export type QueueNote = {
  platform: Platform
  kind: 'paused' | 'paced'
  text: string
  hint?: string
}

/**
 * One note per platform the queue holds back:
 * - paused: "SoundCloud paused until 12:05: rate-limited (retries on its own)";
 * - paced: "YouTube: next start at 12:01 (paced to stay under its limits)".
 * A pause says more than the pacing behind it, so a paused platform gets only the pause.
 */
export function queueNotes(queue: QueueState | undefined, locale?: string): QueueNote[] {
  const notes: QueueNote[] = []
  for (const state of queue?.platforms ?? []) {
    const note = queueNote(state, locale)
    if (note !== undefined) notes.push(note)
  }
  return notes
}

/** The note for one platform, if the queue holds it back: why a queued job of it waits. */
export function platformQueueNote(
  queue: QueueState | undefined,
  platform: Platform,
  locale?: string,
): QueueNote | undefined {
  const state = queue?.platforms.find((entry) => entry.platform === platform)
  return state === undefined ? undefined : queueNote(state, locale)
}

function queueNote(state: PlatformQueueState, locale: string | undefined): QueueNote | undefined {
  const name = PLATFORM_NAMES[state.platform]
  if (state.pausedUntil !== undefined) {
    const reason = state.pauseCode === undefined ? '' : `: ${PAUSE_REASONS[state.pauseCode]}`
    const hint = state.pauseCode === 'bot_check' ? errorHint('bot_check') : undefined
    return {
      platform: state.platform,
      kind: 'paused',
      text: `${name} paused until ${formatClock(state.pausedUntil, locale)}${reason} (retries on its own)`,
      ...(hint === undefined ? {} : { hint }),
    }
  }
  if (state.nextStartAt !== undefined) {
    return {
      platform: state.platform,
      kind: 'paced',
      text: `${name}: next start at ${formatClock(state.nextStartAt, locale)} (paced to stay under its limits)`,
    }
  }
  return undefined
}
