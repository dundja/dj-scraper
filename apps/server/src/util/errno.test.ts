import { describe, expect, it } from 'vitest'
import { StepError } from '../jobs/types.ts'
import { errnoCode, failureName } from './errno.ts'

/** What fs calls throw: an Error with `code`, and a message holding the path. */
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: no such file or directory, open '/Users/dj/Music/a.mp3'`), {
    code,
  })

describe('errnoCode', () => {
  it("is an fs or spawn error's code", () => {
    expect(errnoCode(fsError('ENOENT'))).toBe('ENOENT')
    expect(errnoCode({ code: 'EACCES' })).toBe('EACCES')
  })

  it.each([
    ['an Error without a code', new TypeError('boom')],
    ['a numeric code', { code: 28 }],
    ['a string', 'ENOENT'],
    ['null', null],
    ['undefined', undefined],
  ])('is undefined for %s', (_name, error) => {
    expect(errnoCode(error)).toBeUndefined()
  })
})

describe('failureName', () => {
  it('is the code, then the name, then the type, never the message', () => {
    expect(failureName(fsError('ENOSPC'))).toBe('ENOSPC')
    expect(
      failureName(new StepError('disk_full', "The drive with DJ Scraper's data is full.")),
    ).toBe('disk_full')
    expect(failureName(new TypeError('/Users/dj/Music/a.mp3'))).toBe('TypeError')
    expect(failureName(new DOMException('aborted', 'AbortError'))).toBe('AbortError')
    expect(failureName({ code: 28, name: 'SystemError' })).toBe('SystemError')
    expect(failureName('/Users/dj/Music/a.mp3')).toBe('string')
    expect(failureName(undefined)).toBe('undefined')
    expect(failureName(null)).toBe('object')
  })
})
