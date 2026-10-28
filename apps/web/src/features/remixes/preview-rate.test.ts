import { PREVIEW_RATE_PRESETS } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  clampRate,
  formatClockTime,
  formatRate,
  isPresetRate,
  nudgeRate,
  positionText,
  presetLabel,
} from './preview-rate.ts'

describe('clampRate', () => {
  it('keeps the slider range and step', () => {
    expect(clampRate(0.1)).toBe(0.5)
    expect(clampRate(3)).toBe(1.5)
    expect(clampRate(1.0749)).toBe(1.07)
    expect(clampRate(Number.NaN)).toBe(1)
  })
})

describe('formatRate and presetLabel', () => {
  it('shows the exact speed, and presets without needless zeros', () => {
    expect(formatRate(1.07)).toBe('1.07x')
    expect(formatRate(1)).toBe('1.00x')
    expect(PREVIEW_RATE_PRESETS.map(presetLabel)).toEqual([
      '0.75x',
      '0.9x',
      '1x',
      '1.1x',
      '1.25x',
      '1.5x',
    ])
  })
})

describe('nudgeRate', () => {
  it('moves by 0.01 without a float tail, and stops at the ends', () => {
    expect(nudgeRate(1.06, 1)).toBe(1.07)
    expect(nudgeRate(1.07, -1)).toBe(1.06)
    expect(nudgeRate(0.7 + 0.1, 1)).toBe(0.81)
    expect(nudgeRate(1.5, 1)).toBe(1.5)
    expect(nudgeRate(0.5, -1)).toBe(0.5)
  })
})

describe('isPresetRate', () => {
  it('matches a preset only at its own speed', () => {
    expect(isPresetRate(1.1, 1.1)).toBe(true)
    expect(isPresetRate(1.1000000000000001, 1.1)).toBe(true)
    expect(isPresetRate(1.09, 1.1)).toBe(false)
  })
})

describe('formatClockTime and positionText', () => {
  it('formats minutes, hours and non-times', () => {
    expect(formatClockTime(65.9)).toBe('1:05')
    expect(formatClockTime(3723)).toBe('1:02:03')
    expect(formatClockTime(Number.NaN)).toBe('0:00')
    expect(formatClockTime(-4)).toBe('0:00')
    expect(positionText(65, 210)).toBe('1:05 of 3:30')
    expect(positionText(65, undefined)).toBe('1:05')
  })
})
