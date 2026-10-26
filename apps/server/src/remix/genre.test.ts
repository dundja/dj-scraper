import { MAX_GENRE_LENGTH } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { words } from '../util/words.ts'
import { GENRE_NAMES, genreIn, genrePhrase, uploadGenre } from './genre.ts'

describe('GENRE_NAMES', () => {
  it('lists each genre once, each short enough for the contract', () => {
    expect(new Set(GENRE_NAMES).size).toBe(GENRE_NAMES.length)
    for (const name of GENRE_NAMES) expect(name.length).toBeLessThanOrEqual(MAX_GENRE_LENGTH)
  })
})

describe('genreIn', () => {
  it.each([
    ['Moby - Porcelain (Melodic Techno Remix)', 'Melodic Techno'],
    ['Song (Afro House Remix)', 'Afro House'],
    ['Melodic House & Techno', 'Melodic House & Techno'],
    ['melodic house techno', 'Melodic House & Techno'],
    ['Song (Hard Techno Edit)', 'Hard Techno'],
    ['Song (Liquid DnB Remix)', 'Liquid DnB'],
    ['Song (Deep House Mix)', 'Deep House'],
  ])('names the most specific genre: %j → %s, not a shorter one inside it', (text, genre) => {
    expect(genreIn(text)).toBe(genre)
  })

  it.each([
    ['Drum & Bass', 'Drum & Bass'],
    ['drum and bass', 'Drum & Bass'],
    ['Drum n Bass', 'Drum & Bass'],
    ['D&B', 'Drum & Bass'],
    ['DnB', 'Drum & Bass'],
    ['afrohouse', 'Afro House'],
    ['Lofi', 'Lo-Fi'],
    ['lo-fi', 'Lo-Fi'],
    ['UKG', 'UK Garage'],
    ['2-step', 'UK Garage'],
    ['Brazilian Bass', 'Slap House'],
    ['TECHNO', 'Techno'],
    ['Jungle', 'Jungle'],
  ])('reads the spelling %j as %s', (text, genre) => {
    expect(genreIn(text)).toBe(genre)
  })

  it('names none for a text without a listed genre, or no text', () => {
    expect(genreIn('Moby - Porcelain (Arty Remix)')).toBeUndefined()
    expect(genreIn('Electronic')).toBeUndefined()
    expect(genreIn('Dance & EDM')).toBeUndefined()
    expect(genreIn('')).toBeUndefined()
    expect(genreIn(undefined)).toBeUndefined()
  })

  it('matches whole words: "Housemeister" and "technology" name no genre', () => {
    expect(genreIn('Housemeister - Technology')).toBeUndefined()
  })

  it("ignores a phrase the song's own name holds: Techno Party by someone names no genre", () => {
    const ignore = words('Techno Party Someone')
    expect(genreIn('Someone - Techno Party (Arty Remix)', ignore)).toBeUndefined()
    // A longer phrase that the song's name doesn't hold still counts.
    expect(genreIn('Someone - Techno Party (Hard Techno Remix)', ignore)).toBe('Hard Techno')
    // And another genre named beside it.
    expect(genreIn('Someone - Techno Party (Jungle Remix)', ignore)).toBe('Jungle')
  })

  it('in prose, skips the single words prose uses for other things', () => {
    expect(genreIn('a minimal video from a house party', [], { prose: true })).toBeUndefined()
    expect(genreIn('trap door, garage sale, disco ball', [], { prose: true })).toBeUndefined()
    // The same words in a title are genres.
    expect(genreIn('Song (Minimal Remix)')).toBe('Minimal')
    expect(genreIn('Song (Disco Edit)')).toBe('Nu Disco')
  })

  it('in prose, still names genres in more words, or by words prose has no other use for', () => {
    expect(genreIn('a fresh new melodic house remix of a classic', [], { prose: true })).toBe(
      'Melodic House',
    )
    expect(genreIn('Label: Mute. Style: Trance.', [], { prose: true })).toBe('Trance')
    expect(genreIn('peak time techno for the floor', [], { prose: true })).toBe('Peak Time Techno')
  })
})

describe('genrePhrase', () => {
  it('gives the words of the phrase that named the genre, not its display name', () => {
    expect(genrePhrase('Song (Lofi Remix)')).toEqual({ name: 'Lo-Fi', words: ['lofi'] })
    expect(genrePhrase('Song (DnB Remix)')).toEqual({ name: 'Drum & Bass', words: ['dnb'] })
    expect(genrePhrase('Song (Drum n Bass Remix)')).toEqual({
      name: 'Drum & Bass',
      words: ['drum', 'n', 'bass'],
    })
    expect(genrePhrase('Song (Arty Remix)')).toBeUndefined()
  })
})

describe('uploadGenre', () => {
  const ignore = words('Porcelain Moby')

  it("takes SoundCloud's own genre field first, as the platform's", () => {
    expect(
      uploadGenre(
        {
          platformGenre: 'Drum & Bass',
          title: 'Moby - Porcelain (Afro House Remix)',
          tags: ['Techno'],
          description: 'a deep house remix',
        },
        ignore,
      ),
    ).toEqual({ name: 'Drum & Bass', source: 'platform' })
  })

  it('reads a free-form SoundCloud genre that names a listed one', () => {
    expect(uploadGenre({ platformGenre: 'INDIE DANCE', title: 'x' }, ignore)).toEqual({
      name: 'Indie Dance',
      source: 'platform',
    })
    expect(uploadGenre({ platformGenre: 'Progressive-House', title: 'x' }, ignore)).toEqual({
      name: 'Progressive House',
      source: 'platform',
    })
  })

  it.each(['Electronic', 'Dance & EDM', 'Dance', 'Pop', 'Moby'])(
    'lets the generic SoundCloud genre %j give way to the title',
    (platformGenre) => {
      expect(
        uploadGenre({ platformGenre, title: 'Moby - Porcelain (Afro House Remix)' }, ignore),
      ).toEqual({ name: 'Afro House', source: 'text' })
    },
  )

  it('then the title, then the tags in order, then the description, all as text', () => {
    const title = 'Moby - Porcelain (Jungle Remix)'
    const tags = ['Moby', 'Trance', 'Techno']
    const description = 'a melodic house remix'
    expect(uploadGenre({ title, tags, description }, ignore)).toEqual({
      name: 'Jungle',
      source: 'text',
    })
    expect(uploadGenre({ title: 'Porcelain', tags, description }, ignore)).toEqual({
      name: 'Trance',
      source: 'text',
    })
    expect(uploadGenre({ title: 'Porcelain', tags: ['Moby'], description }, ignore)).toEqual({
      name: 'Melodic House',
      source: 'text',
    })
  })

  it('reads the description as prose', () => {
    expect(
      uploadGenre({ title: 'Porcelain', description: 'shot at a house party' }, ignore),
    ).toBeUndefined()
  })

  it("ignores the song's own words everywhere, the platform's field included", () => {
    const song = words('Techno Party Someone')
    expect(
      uploadGenre({ platformGenre: 'Techno', title: 'Techno Party (X Remix)' }, song),
    ).toBeUndefined()
  })

  it('names none when nothing names a genre', () => {
    expect(
      uploadGenre({ platformGenre: 'Electronic', title: 'Porcelain (Arty Remix)' }, ignore),
    ).toBeUndefined()
  })
})
