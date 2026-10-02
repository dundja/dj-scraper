import { describe, expect, it } from 'vitest'
import { baseArgs, entryArgs, resolveArgs } from './ytdlp-args.ts'

const NODE = '/opt/homebrew/bin/node'
const BASE = [
  '--ignore-config',
  '--no-update',
  '--color',
  'never',
  '--encoding',
  'utf-8',
  '--js-runtimes',
  `node:${NODE}`,
]

describe('baseArgs', () => {
  it('ignores user config, never self-updates, prints plain UTF-8 and offers our Node for JS', () => {
    expect(baseArgs(NODE)).toEqual(BASE)
  })
})

describe('resolveArgs', () => {
  const url = 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0'

  it('lists flat and asks for one row more than the cap, so a longer list shows as truncated', () => {
    expect(resolveArgs({ url, limit: 5000, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '-I',
      '1:5001',
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })

  it.each([
    ['yes', '--yes-playlist'],
    ['no', '--no-playlist'],
  ] as const)('adds the playlist flag for playlist: %s', (playlist, flag) => {
    expect(resolveArgs({ url, playlist, limit: 50, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '-I',
      '1:51',
      flag,
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })

  it('keeps a URL that looks like an option after --, as the last argument', () => {
    const argv = resolveArgs({ url: '--exec=touch /tmp/x', limit: 1, jsRuntime: NODE })
    expect(argv.slice(-2)).toEqual(['--', '--exec=touch /tmp/x'])
    expect(argv.indexOf('--')).toBe(argv.length - 2)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the limit %s', (limit) => {
    expect(() => resolveArgs({ url, limit, jsRuntime: NODE })).toThrow(RangeError)
  })
})

describe('entryArgs', () => {
  it('looks up one track in full, never its playlist, and a list only as a flat page', () => {
    const url = 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy'
    expect(entryArgs({ url, jsRuntime: NODE })).toEqual([
      ...BASE,
      '-J',
      '--flat-playlist',
      '--no-playlist',
      '--socket-timeout',
      '20',
      '--',
      url,
    ])
  })
})
