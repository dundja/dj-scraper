// Pure display formatting for numbers, times, paths and text. Track lengths ("3:07") come from
// `formatDuration` in @dj-scraper/shared.

/** Decimal units, as Finder counts them (1 MB = 1,000,000 bytes). */
const BYTE_UNITS = ['kB', 'MB', 'GB', 'TB'] as const

/**
 * "0 B", "851 B", "4.0 MB", "38 MB": one decimal below 10 so a live value keeps its width, none
 * from 10 on. A value that rounds to 1000 moves up a unit ("1.0 MB", never "1000 kB").
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–'
  if (Math.round(bytes) < 1000) return `${Math.round(bytes)} B`
  let value = bytes
  let text = ''
  for (const unit of BYTE_UNITS) {
    value /= 1000
    text = `${value.toFixed(value < 9.95 ? 1 : 0)} ${unit}`
    if (Number.parseFloat(text) < 1000) break
  }
  return text
}

/** A transfer rate from bytes per second: "851 kB/s", "1.2 MB/s". */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

/**
 * Time left of a download: "0:12 left" under a minute, then "2 min left" and "1 h 5 min left".
 * Minutes round to the nearest one, but never down to "0 min".
 */
export function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  const total = Math.round(sec)
  if (total < 60) return `0:${String(total).padStart(2, '0')} left`
  return `${hoursAndMinutes(Math.max(1, Math.round(total / 60)))} left`
}

/**
 * A summed length, e.g. what a selection adds up to: "45 s" under a minute, then "12 min",
 * "1 h 12 min" and "2 h". Minutes round to the nearest one.
 */
export function formatTotalDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ''
  const total = Math.round(sec)
  if (total < 60) return `${total} s`
  return hoursAndMinutes(Math.round(total / 60))
}

function hoursAndMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

/**
 * The local time of an ISO timestamp in the user's locale, hours and minutes only: "09:05", or
 * "09:05 AM" where the locale uses a 12-hour clock (two-digit hours keep the width steady). Empty
 * for an invalid timestamp. `locale` is for tests; the app passes none.
 */
export function formatClock(iso: string, locale?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/** `/Users/<name>` and what's inside it; `/Users/Shared` is not a home folder. */
const HOME = /^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/

/**
 * A folder path the way a Mac user reads it: their home folder as `~` ("~/Music/DJ Scraper").
 * Other paths ("/Volumes/USB") stay as they are. The browser can't know which home is the user's,
 * so any `/Users/<name>` but Shared counts.
 */
export function shortenPath(path: string): string {
  return path.replace(HOME, '~')
}

/** The last segment of a folder path: "DJ Scraper" for `/Users/dj/Music/DJ Scraper`, "/" for `/`. */
export function folderName(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name === '' ? trimmed : name
}

/**
 * `text` cut to at most `maxLength` UTF-16 units (what Zod's `.max()` counts), ending in "…" when
 * cut, and never in half a surrogate pair. For values the contract caps, e.g. a batch label made
 * from a long title.
 */
export function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  let end = Math.max(0, maxLength - 1)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end).trimEnd()}…`
}
