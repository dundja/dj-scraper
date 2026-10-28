import { PREVIEW_RATE_MAX, PREVIEW_RATE_MIN, PREVIEW_RATE_STEP } from '@dj-scraper/shared'

/** How far a nudge button moves the speed. */
export const NUDGE_STEP = PREVIEW_RATE_STEP

/** The speed as the slider has it: within its range and on its step (two decimals), NaN as 1x. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  const clamped = Math.min(PREVIEW_RATE_MAX, Math.max(PREVIEW_RATE_MIN, rate))
  return Math.round(clamped * 100) / 100
}

/** "1.07x": the exact speed, two decimals, trailing zeros kept so the width stays steady. */
export function formatRate(rate: number): string {
  return `${clampRate(rate).toFixed(2)}x`
}

/** A preset's label: "0.75x", "1x", "1.1x" (no needless zeros). */
export function presetLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}x`
}

/** One nudge up (+1) or down (-1), kept on the grid despite floating point (1.07 + 0.01). */
export function nudgeRate(rate: number, direction: 1 | -1): number {
  return clampRate(clampRate(rate) + direction * NUDGE_STEP)
}

/** Whether `rate` is `preset` (to the slider's step, so a float's tail doesn't matter). */
export function isPresetRate(rate: number, preset: number): boolean {
  return Math.abs(clampRate(rate) - preset) < NUDGE_STEP / 2
}

/** "3:05" or "1:02:03" for a time in seconds; "0:00" for anything that isn't a time. */
export function formatClockTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "1:05 of 3:30", for a screen reader's slider value. */
export function positionText(current: number, duration: number | undefined): string {
  const now = formatClockTime(current)
  return duration === undefined ? now : `${now} of ${formatClockTime(duration)}`
}
