import { describe, expect, expectTypeOf, it } from 'vitest'
import { splitArtistTitle } from './artist-title.ts'

describe('splitArtistTitle', () => {
  it.each([
    ['Rick Astley - Never Gonna Give You Up', 'Rick Astley', 'Never Gonna Give You Up'],
    ['Bicep – Glue', 'Bicep', 'Glue'],
    ['Bicep — Glue', 'Bicep', 'Glue'],
    ['Some Artist  -  Deep House Edit', 'Some Artist', 'Deep House Edit'],
    ['  Some Artist - Deep House Edit  ', 'Some Artist', 'Deep House Edit'],
    ['Some Artist - Deep House Edit', 'Some Artist', 'Deep House Edit'],
  ])('splits %j at the dash', (input, artist, title) => {
    expect(splitArtistTitle(input)).toStrictEqual({ artist, title })
  })

  it.each([
    [
      'Some Artist - Deep House Edit - Extended Mix',
      'Some Artist',
      'Deep House Edit - Extended Mix',
    ],
    ['Artist A – Track – Artist B Remix', 'Artist A', 'Track – Artist B Remix'],
    ['Artist A - Track — Live', 'Artist A', 'Track — Live'],
  ])('splits %j at the first dash, keeping later ones in the title', (input, artist, title) => {
    expect(splitArtistTitle(input)).toStrictEqual({ artist, title })
  })

  it.each([
    ['Jay-Z - Empire State of Mind', 'Jay-Z', 'Empire State of Mind'],
    ['Lo-Fi Dub - Night-Drive', 'Lo-Fi Dub', 'Night-Drive'],
    ['808 State - Pacific State', '808 State', 'Pacific State'],
    ['01. Some Artist - Deep House Edit', '01. Some Artist', 'Deep House Edit'],
    [
      'Some Artist - Deep House Edit (Official Video) [HD]',
      'Some Artist',
      'Deep House Edit (Official Video) [HD]',
    ],
  ])(
    'keeps hyphens inside words and leaves clean-up to later rules: %j',
    (input, artist, title) => {
      expect(splitArtistTitle(input)).toStrictEqual({ artist, title })
    },
  )

  it.each([
    ['a title without a dash', 'Deep House Edit'],
    ['a hyphenated word only', 'Jay-Z'],
    ['a dash without a space before it', 'Some Artist- Deep House Edit'],
    ['a dash without a space after it', 'Some Artist -Deep House Edit'],
    ['a dash glued to both words', 'Some Artist-Deep House Edit'],
    ['nothing before the dash', ' - Deep House Edit'],
    ['nothing after the dash', 'Some Artist - '],
    ['only a dash', ' - '],
    ['a track number before the dash', '01 - Intro'],
    ['a long track number before the dash', '0042 - Outro'],
    ['YouTube’s private video placeholder', '[Private video]'],
    ['YouTube’s deleted video placeholder', '[Deleted video]'],
    ['an empty title', ''],
  ])('does not split %s', (_label, input) => {
    expect(splitArtistTitle(input)).toBeUndefined()
  })

  it('returns both parts as strings, or undefined', () => {
    expectTypeOf(splitArtistTitle).returns.toEqualTypeOf<
      { artist: string; title: string } | undefined
    >()
  })
})
