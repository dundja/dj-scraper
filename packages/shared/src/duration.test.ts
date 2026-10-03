import { describe, expect, it } from 'vitest'
import { formatDuration } from './duration.ts'

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [187, '3:07'],
    [599, '9:59'],
    [600, '10:00'],
    [3599, '59:59'],
  ])('shows %d s under an hour as m:ss: %s', (sec, text) => {
    expect(formatDuration(sec)).toBe(text)
  })

  it.each([
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36_000, '10:00:00'],
    [360_000, '100:00:00'],
  ])('shows %d s from an hour on as h:mm:ss: %s', (sec, text) => {
    expect(formatDuration(sec)).toBe(text)
  })

  it.each([
    [186.4, '3:06'],
    [186.5, '3:07'],
    // SoundCloud reports milliseconds (the recorded set's 1398.595 s).
    [1398.595, '23:19'],
    // Rounding up can carry into the minutes and the hours.
    [59.5, '1:00'],
    [3599.6, '1:00:00'],
  ])('rounds %d s to the nearest second: %s', (sec, text) => {
    expect(formatDuration(sec)).toBe(text)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'shows a placeholder, not 0:00, for input the contract never sends (%d)',
    (sec) => {
      expect(formatDuration(sec)).toBe('–:––')
    },
  )
})
