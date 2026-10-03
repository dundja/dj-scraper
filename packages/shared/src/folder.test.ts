import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import {
  type FolderPath,
  FolderPathSchema,
  MAX_PATH_LENGTH,
  normalizeFolderPath,
} from './folder.ts'
import { issuePaths } from './test-helpers.ts'

/** Folders the API takes as they are. */
const normalFolders = [
  ['the root', '/'],
  ['a home Music folder', '/Users/dj/Music'],
  ['a folder with spaces', '/Users/dj/Music/DJ Scraper'],
  ['a USB stick', '/Volumes/USB'],
  ['non-ASCII names', '/Users/dj/Música/東京'],
  ['names that only start with dots', '/Users/dj/.hidden/...'],
] as const

/** Not folder paths at all, or paths with a segment the server would have to interpret. */
const malformedFolders = [
  ['an empty string', ''],
  ['a home-relative path', '~/Music'],
  ['a relative path', 'Music/DJ Scraper'],
  ['a dot-relative path', './Music'],
  ['a double slash', '//'],
  ['an empty segment', '/Users//dj'],
  ['two trailing slashes', '/Volumes/USB//'],
  ['a . segment', '/Users/dj/./Music'],
  ['a trailing . segment', '/Users/dj/Music/.'],
  ['a .. segment', '/Users/dj/../Music'],
  ['a trailing .. segment', '/Users/dj/..'],
  ['a file URL', 'file:///Users/dj/Music'],
  ['a Windows path', 'C:\\Users\\dj\\Music'],
] as const

const controlCharacters = [
  ['NUL', '\u0000'],
  ['a tab', '\t'],
  ['a newline', '\n'],
  ['a carriage return', '\r'],
  ['ESC', '\u001b'],
  ['DEL', '\u007f'],
] as const

describe('normalizeFolderPath', () => {
  it.each(normalFolders)('keeps %s as it is', (_label, path) => {
    expect(normalizeFolderPath(path)).toBe(path)
  })

  it.each([
    ['a USB stick from the folder picker', '/Volumes/USB/', '/Volumes/USB'],
    ['a home folder typed with a slash', '/Users/dj/Music/', '/Users/dj/Music'],
  ])('drops the trailing slash of %s', (_label, input, expected) => {
    expect(normalizeFolderPath(input)).toBe(expected)
  })

  it('returns its own output unchanged (idempotent)', () => {
    const once = normalizeFolderPath('/Volumes/USB/')
    expect(once).toBe('/Volumes/USB')
    expect(normalizeFolderPath(once ?? '')).toBe(once)
  })

  it.each(malformedFolders)('rejects %s', (_label, input) => {
    expect(normalizeFolderPath(input)).toBeUndefined()
  })

  it.each(controlCharacters)('rejects a path containing %s', (_label, char) => {
    expect(normalizeFolderPath(`/Users/dj/Mu${char}sic`)).toBeUndefined()
  })

  it('accepts MAX_PATH_LENGTH characters and rejects one more', () => {
    const longest = `/${'a'.repeat(MAX_PATH_LENGTH - 1)}`
    expect(normalizeFolderPath(longest)).toBe(longest)
    expect(normalizeFolderPath(`${longest}a`)).toBeUndefined()
  })

  it('counts UTF-16 units, so a path within the cap can still be over the byte budget', () => {
    // 1024 units but 3,070 UTF-8 bytes: the server checks the macOS byte limit itself.
    const path = `/${'東'.repeat(MAX_PATH_LENGTH - 1)}`
    expect(normalizeFolderPath(path)).toBe(path)
  })
})

describe('FolderPathSchema', () => {
  it.each(normalFolders)('parses %s unchanged', (_label, path) => {
    expect(FolderPathSchema.parse(path)).toBe(path)
  })

  it('rejects a trailing slash: clients normalize picker output before sending it', () => {
    expect(issuePaths(FolderPathSchema, '/Volumes/USB/')).toEqual([[]])
    expect(FolderPathSchema.parse(normalizeFolderPath('/Volumes/USB/'))).toBe('/Volumes/USB')
  })

  it.each(malformedFolders)('rejects %s', (_label, input) => {
    expect(issuePaths(FolderPathSchema, input)).toEqual([[]])
  })

  it.each(controlCharacters)('rejects a path containing %s', (_label, char) => {
    expect(issuePaths(FolderPathSchema, `/Users/dj/Mu${char}sic`)).toEqual([[]])
  })

  it('accepts MAX_PATH_LENGTH characters and rejects one more', () => {
    const longest = `/${'a'.repeat(MAX_PATH_LENGTH - 1)}`
    expect(issuePaths(FolderPathSchema, longest)).toEqual([])
    const paths = issuePaths(FolderPathSchema, `${longest}a`)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((path) => path.length === 0)).toBe(true)
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an array of segments', ['Users', 'dj']],
  ])('rejects %s', (_label, input) => {
    expect(issuePaths(FolderPathSchema, input)).toEqual([[]])
  })

  it('caps paths at the macOS limit of 1024', () => {
    expect(MAX_PATH_LENGTH).toBe(1024)
  })

  it('types a folder path as a plain string, with no transform', () => {
    expectTypeOf<FolderPath>().toEqualTypeOf<string>()
    expectTypeOf<z.input<typeof FolderPathSchema>>().toEqualTypeOf<string>()
  })
})
