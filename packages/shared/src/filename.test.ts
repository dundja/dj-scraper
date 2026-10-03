import { describe, expect, it } from 'vitest'
import { DEFAULT_FILENAME_TEMPLATE } from './download.ts'
import {
  MAX_FILENAME_LENGTH,
  renderFilename,
  sanitizeFilename,
  sanitizeFolderName,
  utf8Length,
} from './filename.ts'

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const graphemes = (text: string): string[] =>
  Array.from(segmenter.segment(text), ({ segment }) => segment)

describe('renderFilename', () => {
  // Pinned (design D13): what a template gives when some fields are unknown.
  it.each([
    ['{artist} - {title}', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist} - {title}', { title: 'Title' }, 'Title'],
    ['{artist} - {title}', { artist: 'A' }, 'A'],
    ['{artist} - {title} ({year})', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist} - {title} ({year})', { artist: 'A', title: 'T', year: '2024' }, 'A - T (2024)'],
    ['{year} - {artist} - {title}', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist} - {album} - {title}', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist}{title}', { artist: 'A', title: 'T' }, 'AT'],
    ['{artist} - {title} [{album}]', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist} - {title} ({album}, {year})', { artist: 'A', title: 'T' }, 'A - T'],
    ['{artist} - {title} ({album}, {year})', { title: 'T', year: '2024' }, 'T (2024)'],
    ['{artist} - {title} ({album}, {year})', { title: 'T', album: 'LP' }, 'T (LP)'],
    ['{title} ({album} - {year})', { title: 'T', year: '2024' }, 'T (2024)'],
    ['{title} – {artist}', { title: 'T' }, 'T'],
    ['{title} — {artist}', { artist: 'A' }, 'A'],
    ['{artist}_{title}', { title: 'T' }, 'T'],
    ['{artist}_{album}_{title}', { artist: 'A', title: 'T' }, 'A_T'],
    ['{artist}, {album}, {title}', { artist: 'A', title: 'T' }, 'A, T'],
    ['{platform}-{id}', { platform: 'youtube', id: 'abc' }, 'youtube-abc'],
  ])('%s with %j → %j', (template, fields, expected) => {
    expect(renderFilename(template, fields)).toBe(expected)
  })

  it('renders an empty string when every field is unknown (sanitizeFilename falls back)', () => {
    expect(renderFilename(DEFAULT_FILENAME_TEMPLATE, {})).toBe('')
    expect(renderFilename('{artist} - {title} ({year})', {})).toBe('')
    expect(sanitizeFilename(renderFilename('{artist} - {title}', {}), 'mp3', 'youtube-x1')).toBe(
      'youtube-x1.mp3',
    )
  })

  it('leaves hyphens inside words and later dashes of a title alone', () => {
    expect(
      renderFilename(DEFAULT_FILENAME_TEMPLATE, {
        artist: 'Jay-Z',
        title: 'Empire - Extended Mix',
      }),
    ).toBe('Jay-Z - Empire - Extended Mix')
    expect(renderFilename('{title}', { title: '-5 dB Mix' })).toBe('-5 dB Mix')
  })

  it('keeps underscores of an id inside brackets, but trims them at the ends of the name', () => {
    expect(
      renderFilename('{artist} - {title} [{id}]', { artist: 'A', title: 'T', id: '_x0-abc_' }),
    ).toBe('A - T [_x0-abc_]')
    expect(renderFilename('{id}', { id: '_x0' })).toBe('x0')
  })

  it('renders values literally: braces in a value are not placeholders', () => {
    expect(renderFilename('{title}', { title: '{artist} live' })).toBe('{artist} live')
  })

  it('collapses whitespace and runs of separators inside values too', () => {
    expect(renderFilename('{title}', { title: '  A  -  - B ,, C  ' })).toBe('A - B, C')
  })
})

describe('sanitizeFilename', () => {
  // Pinned (design D13): one table of what each rule does.
  it.each([
    ['AC/DC - Back In Black', 'AC-DC - Back In Black.mp3'],
    ['Artist - Title: The Remix', 'Artist - Title - The Remix.mp3'],
    ['a:b|c\\d"e<f>g?h*i', "a-b-c-d'efghi.mp3"],
    ['Time 12:30', 'Time 12-30.mp3'],
    ['  ..hidden. ', 'hidden.mp3'],
    ['Title -', 'Title.mp3'],
    ['Title —', 'Title.mp3'],
    ['Title...', 'Title.mp3'],
    ['many   spaces\u{a0}and\u{3000}ideographic', 'many spaces and ideographic.mp3'],
    ['line1\nline2\ttab\u0000nul\u007fdel\u0085nel', 'line1 line2 tab nul del nel.mp3'],
    ['evil\u{202e}gpj.exe', 'evilgpj.exe.mp3'],
    ['zero\u{200b}width\u{feff}bom', 'zerowidthbom.mp3'],
    ['private\u{f022}use', 'privateuse.mp3'],
    ['lone \ud83c surrogate', 'lone surrogate.mp3'],
    ['Beyoncé & 東京 — Ñandú', 'Beyoncé & 東京 — Ñandú.mp3'],
    [
      '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} Scotland',
      '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} Scotland.mp3',
    ],
    ['👨\u{200d}👩\u{200d}👧 family', '👨\u{200d}👩\u{200d}👧 family.mp3'],
  ])('%j → %j', (base, expected) => {
    expect(sanitizeFilename(base, 'mp3', 'youtube-abc')).toBe(expected)
  })

  it('composes to NFC, also after removing a character between a letter and its accent', () => {
    expect(sanitizeFilename('A\u{308}', 'mp3', 'x')).toBe('Ä.mp3')
    expect(sanitizeFilename('e\u{200b}\u{301}', 'mp3', 'x')).toBe('é.mp3')
  })

  it.each([
    ['CON', '_CON.mp3'],
    ['con', '_con.mp3'],
    ['NUL.tar', '_NUL.tar.mp3'],
    ['AUX .remix', '_AUX .remix.mp3'],
    ['COM1', '_COM1.mp3'],
    ['COM0', '_COM0.mp3'],
    ['COM¹', '_COM¹.mp3'],
    ['LPT³', '_LPT³.mp3'],
    ['CONIN$', '_CONIN$.mp3'],
    ['CONOUT$', '_CONOUT$.mp3'],
    ['PRN. ', '_PRN.mp3'],
    ['Con Funk Shun', 'Con Funk Shun.mp3'],
    ['CONSOLE', 'CONSOLE.mp3'],
    ['COM10', 'COM10.mp3'],
  ])('prefixes the Windows device name %j', (base, expected) => {
    expect(sanitizeFilename(base, 'mp3', 'x')).toBe(expected)
  })

  it.each([
    ['', 'youtube-abc.mp3'],
    ['   ', 'youtube-abc.mp3'],
    ['...', 'youtube-abc.mp3'],
    ['???', 'youtube-abc.mp3'],
    ['<>*', 'youtube-abc.mp3'],
    ['\u{200b}\u{202e}', 'youtube-abc.mp3'],
  ])('falls back for %j', (base, expected) => {
    expect(sanitizeFilename(base, 'mp3', 'youtube-abc')).toBe(expected)
  })

  it('sanitizes the fallback too, and has a last resort', () => {
    expect(sanitizeFilename('', 'mp3', 'other-a/b:c')).toBe('other-a-b-c.mp3')
    expect(sanitizeFilename('', 'mp3', '...')).toBe('Untitled.mp3')
  })

  it('keeps the name within 180 UTF-16 units with the extension, which is never cut', () => {
    const name = sanitizeFilename('a'.repeat(300), 'aiff', 'x')
    expect(name).toBe(`${'a'.repeat(MAX_FILENAME_LENGTH - 5)}.aiff`)
    expect(name).toHaveLength(MAX_FILENAME_LENGTH)
  })

  it('re-trims after truncating', () => {
    const base = `${'a'.repeat(MAX_FILENAME_LENGTH - 6)} - rest`
    expect(sanitizeFilename(base, 'mp3', 'x')).toBe(`${'a'.repeat(MAX_FILENAME_LENGTH - 6)}.mp3`)
  })

  it.each([
    ['🎧', 100],
    ['👨\u{200d}👩\u{200d}👧', 40],
    ['🇷🇸', 60],
    ['🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', 20],
  ])('truncates %s by whole graphemes', (emoji, count) => {
    const name = sanitizeFilename(emoji.repeat(count), 'mp3', 'x')
    expect(name.endsWith('.mp3')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
    expect(name.isWellFormed()).toBe(true)
    const kept = graphemes(name.slice(0, -4))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every((grapheme) => grapheme === emoji)).toBe(true)
    // Whole graphemes as long as another one would not fit.
    expect(`${name.slice(0, -4)}${emoji}.mp3`.length).toBeGreaterThan(MAX_FILENAME_LENGTH)
  })

  it('also keeps the decomposed (NFD) length within 255 units for HFS+', () => {
    const accented = sanitizeFilename('é'.repeat(200), 'mp3', 'x')
    expect(accented).toBe(`${'é'.repeat(125)}.mp3`)
    expect(accented.normalize('NFD').length).toBe(254)
    const stacked = sanitizeFilename('ệ'.repeat(120), 'mp3', 'x')
    expect(stacked.normalize('NFD').length).toBeLessThanOrEqual(255)
    expect(stacked.length).toBeLessThan(MAX_FILENAME_LENGTH)
    expect(stacked).toBe(`${'ệ'.repeat(83)}.mp3`)
  })

  it('falls back when a single grapheme is too long to fit', () => {
    expect(sanitizeFilename(`a${'\u{301}'.repeat(300)}`, 'mp3', 'youtube-abc')).toBe(
      'youtube-abc.mp3',
    )
  })

  it.each(['', 'MP3', 'mp3 ', '.mp3', 'abcdef', 'm/p3'])('refuses the extension %j', (ext) => {
    expect(() => sanitizeFilename('Title', ext, 'x')).toThrow('Invalid file extension')
  })
})

describe('sanitizeFilename with a byte budget', () => {
  it('cuts a CJK name to the UTF-8 bytes the folder leaves (3 bytes a character)', () => {
    // 180 units of CJK are 532 bytes: too many for a folder whose path leaves 300.
    const unlimited = sanitizeFilename('日本語のタイトル'.repeat(40), 'mp3', 'x')
    expect(unlimited).toHaveLength(MAX_FILENAME_LENGTH)
    expect(utf8Length(unlimited)).toBe(532)
    const name = sanitizeFilename('日本語のタイトル'.repeat(40), 'mp3', 'x', 300)
    expect(utf8Length(name)).toBeLessThanOrEqual(300)
    expect(name).toBe(`${'日本語のタイトル'.repeat(12)}日本.mp3`)
    expect(utf8Length(name)).toBe(298)
  })

  it('counts bytes, not units: ASCII fills the budget, emoji take 4 bytes per pair', () => {
    expect(sanitizeFilename('a'.repeat(300), 'mp3', 'x', 100)).toBe(`${'a'.repeat(96)}.mp3`)
    const emoji = sanitizeFilename('🎧'.repeat(100), 'mp3', 'x', 100)
    expect(emoji).toBe(`${'🎧'.repeat(24)}.mp3`)
    expect(utf8Length(emoji)).toBe(100)
    // Mixed: whole graphemes only, the last one that fits.
    expect(sanitizeFilename('ab日🎧', 'mp3', 'x', 4 + 2 + 3 + 3)).toBe('ab日.mp3')
  })

  it('cuts the fallback and the last resort to the budget too', () => {
    // Not one 3-byte character fits in 2 bytes: the fallback, cut.
    expect(sanitizeFilename('日日日', 'mp3', 'youtube-jNQXAC9IVRw', 6)).toBe('yo.mp3')
    expect(sanitizeFilename('', 'mp3', '', 5)).toBe('U.mp3')
  })

  it('refuses a budget without room for the extension and one character', () => {
    expect(() => sanitizeFilename('Title', 'mp3', 'x', 4)).toThrow(RangeError)
    expect(() => sanitizeFilename('Title', 'mp3', 'x', Number.NaN)).toThrow(RangeError)
    expect(sanitizeFilename('Title', 'mp3', 'x', 5)).toBe('T.mp3')
  })

  it('leaves names within the budget as they are', () => {
    // 6 + 2 (é) + 3 + 6 (東京) + 4 + 4 (.mp3) = 25 bytes.
    expect(sanitizeFilename('Beyoncé - 東京 Mix', 'mp3', 'x', 25)).toBe('Beyoncé - 東京 Mix.mp3')
    // Cut after "東京 " and re-trimmed.
    expect(sanitizeFilename('Beyoncé - 東京 Mix', 'mp3', 'x', 22)).toBe('Beyoncé - 東京.mp3')
  })
})

describe('utf8Length', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['日', 3],
    ['🎧', 4],
    ['\u{d83c}', 3],
    ['A\u{308}', 3],
  ])('%j is %i bytes', (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes)
  })
})

describe('sanitizeFolderName', () => {
  it.each([
    ['Summer Set: Vol. 1', 'Summer Set - Vol. 1'],
    ['House/Techno', 'House-Techno'],
    ['  ..Hidden  ', 'Hidden'],
    ['NUL', '_NUL'],
    ['Mix 2024.', 'Mix 2024'],
    ['Café', 'Café'],
  ])('%j → %j', (name, expected) => {
    expect(sanitizeFolderName(name)).toBe(expected)
  })

  it.each(['', ' ', '.', '..', '...', '???', '\u{200b}'])('refuses %j', (name) => {
    expect(sanitizeFolderName(name)).toBeUndefined()
  })

  it('is one path component, at most 180 units', () => {
    const name = sanitizeFolderName(`../../${'x'.repeat(300)}`)
    expect(name).toBeDefined()
    expect(name).not.toContain('/')
    expect(name?.length).toBe(MAX_FILENAME_LENGTH)
  })
})
