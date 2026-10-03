import { describe, expect, it } from 'vitest'
import {
  clipText,
  folderName,
  formatBytes,
  formatClock,
  formatEta,
  formatSpeed,
  formatTotalDuration,
  shortenPath,
} from './format.ts'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [851, '851 B'],
    [999.4, '999 B'],
    [999.6, '1.0 kB'],
    [1000, '1.0 kB'],
    [1536, '1.5 kB'],
    [9949, '9.9 kB'],
    [9950, '10 kB'],
    [851_200, '851 kB'],
    [999_600, '1.0 MB'],
    [4_028_536, '4.0 MB'],
    [38_400_000, '38 MB'],
    [1_200_000_000, '1.2 GB'],
    [5_000_000_000_000_000, '5000 TB'],
  ])('%d bytes → %s (decimal units, one decimal below 10)', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('shows a dash for %d', (bytes) => {
    expect(formatBytes(bytes)).toBe('–')
  })
})

describe('formatSpeed', () => {
  it.each([
    [0, '0 B/s'],
    [851_200, '851 kB/s'],
    [1_234_567, '1.2 MB/s'],
  ])('%d B/s → %s', (speed, text) => {
    expect(formatSpeed(speed)).toBe(text)
  })
})

describe('formatEta', () => {
  it.each([
    [0, '0:00 left'],
    [3, '0:03 left'],
    [12.4, '0:12 left'],
    [59.4, '0:59 left'],
  ])('says the seconds under a minute: %d → %s', (sec, text) => {
    expect(formatEta(sec)).toBe(text)
  })

  it.each([
    [59.6, '1 min left'],
    [89, '1 min left'],
    [90, '2 min left'],
    [125, '2 min left'],
    [3569, '59 min left'],
    [3570, '1 h left'],
    [3900, '1 h 5 min left'],
    [7200, '2 h left'],
  ])('says minutes, then hours from a minute on: %d → %s', (sec, text) => {
    expect(formatEta(sec)).toBe(text)
  })

  it.each([-1, Number.NaN])('says nothing for %d', (sec) => {
    expect(formatEta(sec)).toBe('')
  })
})

describe('formatTotalDuration', () => {
  it.each([
    [0, '0 s'],
    [45, '45 s'],
    [59.4, '59 s'],
    [59.6, '1 min'],
    [720, '12 min'],
    [749, '12 min'],
    [3570, '1 h'],
    [4320, '1 h 12 min'],
    [7200, '2 h'],
    [90_061, '25 h 1 min'],
  ])('%d s → %s', (sec, text) => {
    expect(formatTotalDuration(sec)).toBe(text)
  })

  it('says nothing for a value that is not a duration', () => {
    expect(formatTotalDuration(Number.NaN)).toBe('')
  })
})

describe('formatClock', () => {
  // Built from local time, so the expectation holds in every time zone the tests run in.
  const threeMinutesPastNoon = new Date(2026, 9, 2, 12, 3, 41).toISOString()
  const morning = new Date(2026, 9, 2, 9, 5).toISOString()

  it('shows the local hours and minutes in the given locale', () => {
    expect(formatClock(threeMinutesPastNoon, 'en-GB')).toBe('12:03')
    expect(formatClock(morning, 'en-GB')).toBe('09:05')
    expect(formatClock(morning, 'de-DE')).toBe('09:05')
  })

  it('keeps a 12-hour clock where the locale uses one', () => {
    expect(formatClock(threeMinutesPastNoon, 'en-US')).toMatch(/^12:03\sPM$/)
    expect(formatClock(morning, 'en-US')).toMatch(/^09:05\sAM$/)
  })

  it('says nothing for a timestamp it cannot read', () => {
    expect(formatClock('soon', 'en-GB')).toBe('')
  })
})

describe('shortenPath', () => {
  it.each([
    ['/Users/dj/Music/DJ Scraper', '~/Music/DJ Scraper'],
    ['/Users/dj', '~'],
    ['/Users/dj/', '~/'],
    ['/Users/dj.smith/Desktop', '~/Desktop'],
  ])('shows the home folder as ~: %s → %s', (path, text) => {
    expect(shortenPath(path)).toBe(text)
  })

  it.each([
    '/Volumes/USB',
    '/Volumes/USB/Users/dj',
    '/Users',
    '/Users/Shared/DJ',
    '/Users/Shared',
    '/',
  ])('leaves %s as it is', (path) => {
    expect(shortenPath(path)).toBe(path)
  })
})

describe('folderName', () => {
  it.each([
    ['/Users/dj/Music/DJ Scraper', 'DJ Scraper'],
    ['/Volumes/USB', 'USB'],
    ['/Volumes/USB/', 'USB'],
    ['/', '/'],
  ])('%s → %s', (path, name) => {
    expect(folderName(path)).toBe(name)
  })
})

describe('clipText', () => {
  it('keeps text that fits', () => {
    expect(clipText('Summer 2026', 11)).toBe('Summer 2026')
    expect(clipText('', 5)).toBe('')
  })

  it('cuts longer text to the limit, ending in an ellipsis', () => {
    const clipped = clipText('Late Night Selects Vol. 2', 10)
    expect(clipped).toBe('Late Nigh…')
    expect(clipped).toHaveLength(10)
  })

  it('drops the trailing space before the ellipsis', () => {
    expect(clipText('Late Night Selects', 6)).toBe('Late…')
  })

  it('never ends in half a surrogate pair', () => {
    // 🎧 is two UTF-16 units: cutting after its first one would leave a lone surrogate.
    const clipped = clipText('ab🎧cd', 4)
    expect(clipped).toBe('ab…')
    expect(clipped.isWellFormed()).toBe(true)
    expect(clipText('ab🎧cd', 5)).toBe('ab🎧…')
  })
})
