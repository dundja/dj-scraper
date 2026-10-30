import type { CSSProperties } from 'react'

/**
 * The inline style of a `range-input` (src/styles.css): `--value`, the share of the track filled
 * up to `value`, which WebKit and Blink paint (Firefox fills it by itself).
 */
export function rangeFill(value: number, min: number, max: number): CSSProperties {
  const share = max > min ? (Math.min(Math.max(value, min), max) - min) / (max - min) : 0
  return { '--value': `${Math.round(share * 10_000) / 100}%` } as CSSProperties
}
