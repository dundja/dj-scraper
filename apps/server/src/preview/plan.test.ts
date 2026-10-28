import { PREVIEW_ID_PATTERN } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  type CachedFile,
  PREVIEW_EXTENSIONS,
  parseCachedName,
  parseRange,
  planEviction,
  previewId,
  previewMime,
} from './plan.ts'

describe('previewId', () => {
  it('is the first 32 hex characters of sha256("<platform>:<track id>")', () => {
    // printf 'youtube:jNQXAC9IVRw' | shasum -a 256
    expect(previewId('youtube', 'jNQXAC9IVRw')).toBe('4a83d0e7ecc312a7d02d0405eefc004d')
  })

  it('always matches the contract pattern', () => {
    for (const [platform, id] of [
      ['youtube', 'x'],
      ['soundcloud', '47127631'],
      ['soundcloud', 'ünïcode/../id with spaces'],
    ] as const) {
      expect(previewId(platform, id)).toMatch(PREVIEW_ID_PATTERN)
    }
  })

  it('tells platforms and tracks apart and is stable', () => {
    expect(previewId('youtube', '1')).toBe(previewId('youtube', '1'))
    expect(previewId('youtube', '1')).not.toBe(previewId('soundcloud', '1'))
    expect(previewId('youtube', '1')).not.toBe(previewId('youtube', '2'))
  })
})

describe('previewMime and parseCachedName', () => {
  it('maps the playable extensions and nothing else', () => {
    expect(previewMime('m4a')).toBe('audio/mp4')
    expect(previewMime('mp4')).toBe('audio/mp4')
    expect(previewMime('mp3')).toBe('audio/mpeg')
    expect(previewMime('webm')).toBe('audio/webm')
    expect(previewMime('opus')).toBe('audio/ogg')
    expect(previewMime('ogg')).toBe('audio/ogg')
    for (const other of ['aac', 'flac', 'wav', 'json', 'part', '', 'constructor', '__proto__']) {
      expect(previewMime(other)).toBeUndefined()
    }
    expect(PREVIEW_EXTENSIONS.every((extension) => previewMime(extension) !== undefined)).toBe(true)
  })

  const id = 'a'.repeat(32)
  it('reads only <32 hex>.<known extension>', () => {
    expect(parseCachedName(`${id}.m4a`)).toEqual({ id, extension: 'm4a' })
    for (const name of [
      `${id}.part`,
      `${id}`,
      `${id}.m4a.part`,
      `${'A'.repeat(32)}.m4a`,
      `${'a'.repeat(31)}.m4a`,
      '0b7c1a52-8f0e-4c1e-9d38-2a3a6c1f5e11',
      `../${id}.m4a`,
    ]) {
      expect(parseCachedName(name)).toBeUndefined()
    }
  })
})

describe('parseRange', () => {
  const size = 1000
  it('answers the whole file without a usable Range', () => {
    for (const header of [
      undefined,
      '',
      'items=0-5',
      'bytes=',
      'bytes=-',
      'bytes=abc',
      'bytes=0-5,10-20',
      'bytes=5-2',
      'bytes = 0-5',
    ]) {
      expect(parseRange(header, size)).toEqual({ kind: 'full' })
    }
  })

  it('reads a-b, a- and -n', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ kind: 'partial', start: 0, end: 99 })
    expect(parseRange('bytes=100-', size)).toEqual({ kind: 'partial', start: 100, end: 999 })
    expect(parseRange('bytes=-100', size)).toEqual({ kind: 'partial', start: 900, end: 999 })
    expect(parseRange('bytes=0-0', size)).toEqual({ kind: 'partial', start: 0, end: 0 })
    expect(parseRange('bytes=999-999', size)).toEqual({ kind: 'partial', start: 999, end: 999 })
  })

  it('cuts an end past the file, and a suffix longer than it, to the file', () => {
    expect(parseRange('bytes=900-5000', size)).toEqual({ kind: 'partial', start: 900, end: 999 })
    expect(parseRange('bytes=-5000', size)).toEqual({ kind: 'partial', start: 0, end: 999 })
  })

  it('is unsatisfiable from the end of the file on, and for a zero suffix', () => {
    expect(parseRange('bytes=1000-', size)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=1000-1100', size)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-0', size)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange(`bytes=${'9'.repeat(30)}-`, size)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('planEviction', () => {
  const limits = { maxFiles: 3, maxBytes: 100 }
  const file = (name: string, size: number, mtimeMs: number): CachedFile => ({
    name,
    size,
    mtimeMs,
  })

  it('keeps everything that fits', () => {
    expect(planEviction([file('a', 10, 1), file('b', 10, 2)], limits)).toEqual([])
    expect(planEviction([], limits)).toEqual([])
  })

  it('drops the least recently used until the count fits', () => {
    const files = [file('c', 1, 30), file('a', 1, 10), file('d', 1, 40), file('b', 1, 20)]
    expect(planEviction(files, limits)).toEqual(['a'])
    expect(planEviction([...files, file('e', 1, 50), file('f', 1, 60)], limits)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('drops the least recently used until the bytes fit', () => {
    const files = [file('a', 60, 10), file('b', 30, 20), file('c', 30, 30)]
    expect(planEviction(files, limits)).toEqual(['a'])
    expect(planEviction([file('a', 40, 1), file('b', 40, 2), file('c', 40, 3)], limits)).toEqual([
      'a',
    ])
  })

  it('never drops the file just made, even when it is the oldest', () => {
    const files = [file('new', 60, 1), file('b', 30, 20), file('c', 30, 30)]
    expect(planEviction(files, limits, 'new')).toEqual(['b'])
  })

  it('breaks ties by name, so the plan is stable', () => {
    const files = [file('b', 1, 5), file('a', 1, 5), file('c', 1, 5), file('d', 1, 5)]
    expect(planEviction(files, limits)).toEqual(['a'])
  })
})
