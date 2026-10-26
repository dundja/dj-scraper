import { describe, expect, it } from 'vitest'
import { containsRun, normalize, words } from './words.ts'

describe('normalize', () => {
  it('reads names that differ only in case and accents as one name', () => {
    expect(normalize('ADÉLA')).toBe('adela')
    expect(normalize('RÜFÜS DU SOL')).toBe(normalize('Rufus du Sol'))
    expect(normalize('Blémmes')).toBe('blemmes')
  })

  it('reads & as "and", so "Pola & Bryson" and "Pola and Bryson" are one pair', () => {
    expect(normalize('Pola & Bryson')).toBe('pola and bryson')
    expect(normalize('Drum&Bass')).toBe('drum and bass')
  })

  it("drops apostrophes inside words instead of splitting them: Don't → dont", () => {
    expect(normalize("Don't Stop")).toBe('dont stop')
    expect(normalize('Torsten Stenzel’s Remix')).toBe('torsten stenzels remix')
  })

  it('turns punctuation and runs of whitespace into single spaces, trimmed', () => {
    expect(normalize('  Moby - Porcelain (Arty Remix) [FREE DL]!! ')).toBe(
      'moby - porcelain arty remix free dl',
    )
    expect(normalize('a\t\n b')).toBe('a b')
  })

  it('keeps hyphens inside words and letters of any script', () => {
    expect(normalize('Jay-Z')).toBe('jay-z')
    expect(normalize('Shoji正治')).toBe('shoji正治')
  })

  it('folds compatibility forms (full-width letters, ligatures) to plain ones', () => {
    expect(normalize('ＭＯＢＹ')).toBe('moby')
    expect(normalize('ﬁre')).toBe('fire')
  })

  it('leaves nothing of a text without letters, digits or hyphens', () => {
    expect(normalize(' — !? ')).toBe('')
    expect(normalize('')).toBe('')
    // A lone hyphen survives normalize; words() drops it.
    expect(normalize(' - ')).toBe('-')
  })
})

describe('words', () => {
  it('splits a text into its normalized words', () => {
    expect(words('Moby - Porcelain (Arty Remix)')).toEqual(['moby', 'porcelain', 'arty', 'remix'])
  })

  it('splits hyphenated words, and a lone dash or separator is no word', () => {
    expect(words('Jay-Z')).toEqual(['jay', 'z'])
    expect(words('Lo-Fi -- Dub - Mix')).toEqual(['lo', 'fi', 'dub', 'mix'])
    expect(words(' - ')).toEqual([])
  })

  it('has no words for an empty or punctuation-only text', () => {
    expect(words('')).toEqual([])
    expect(words('(!!!) []')).toEqual([])
  })
})

describe('containsRun', () => {
  const title = words('Rick Astley - Never Gonna Give You Up (Krysiek Remix)')

  it('finds a needle whose words follow each other', () => {
    expect(containsRun(title, ['rick', 'astley'])).toBe(true)
    expect(containsRun(title, ['krysiek', 'remix'])).toBe(true)
    expect(containsRun(title, ['remix'])).toBe(true)
  })

  it('does not find words that are there but apart or out of order', () => {
    expect(containsRun(title, ['rick', 'never'])).toBe(false)
    expect(containsRun(title, ['astley', 'rick'])).toBe(false)
  })

  it('matches whole words only', () => {
    expect(containsRun(title, ['astle'])).toBe(false)
  })

  it('never finds an empty needle, or one longer than the haystack', () => {
    expect(containsRun(title, [])).toBe(false)
    expect(containsRun([], [])).toBe(false)
    expect(containsRun(['a'], ['a', 'b'])).toBe(false)
  })
})
