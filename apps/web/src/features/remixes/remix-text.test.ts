import { describe, expect, it } from 'vitest'
import {
  artyRemix,
  artyReupload,
  artySoundcloud,
  artyYoutube,
  bareRemix,
  bareUpload,
  extendedMix,
  nightFerryBootleg,
  noRemixes,
  quickRemixes,
  remixes,
} from '@/test/remixes.ts'
import {
  defaultUpload,
  emptyText,
  genreCounts,
  genreSourceText,
  kindText,
  playsText,
  remixCount,
  searchedText,
  searchFailures,
  searchingText,
  suggestionKey,
  uploadsByPlatform,
  uploadText,
} from './remix-text.ts'

const failed = (message: string) =>
  ({ status: 'error', error: { code: 'rate_limited', message } }) as const

describe('searchedText', () => {
  it('names the song the server searched for, and where', () => {
    expect(searchedText(remixes.song)).toBe('Remixes of Moby – Porcelain on YouTube and SoundCloud')
    expect(searchedText({ title: 'Porcelain' })).toBe(
      'Remixes of Porcelain on YouTube and SoundCloud',
    )
  })
})

describe('kindText', () => {
  it('says what kind of version it is, and by whom when a title names them', () => {
    expect(kindText(artyRemix)).toBe('Remix by Arty')
    expect(kindText(bareRemix)).toBe('Remix')
    expect(kindText(nightFerryBootleg)).toBe('Bootleg by Night Ferry')
    expect(kindText({ kind: 'bootleg' })).toBe('Bootleg')
    expect(kindText(extendedMix)).toBe('Extended mix')
  })
})

describe('genreSourceText', () => {
  it("tells a SoundCloud uploader's genre from one read in the text", () => {
    expect(genreSourceText('platform')).toBe('Genre set on SoundCloud')
    expect(genreSourceText('text')).toBe('Genre named in the title or tags')
  })
})

describe('playsText', () => {
  it("counts YouTube's views and SoundCloud's plays", () => {
    expect(playsText('youtube', 908_123)).toBe('908K views')
    expect(playsText('soundcloud', 381_927)).toBe('382K plays')
    expect(playsText('youtube', 1)).toBe('1 view')
    expect(playsText('soundcloud', 1)).toBe('1 play')
    expect(playsText('soundcloud', 0)).toBe('0 plays')
  })
})

describe('defaultUpload and suggestionKey', () => {
  it('take the most played upload', () => {
    expect(defaultUpload(artyRemix)).toEqual(artyYoutube)
    expect(suggestionKey(artyRemix)).toBe(`youtube:${artyYoutube.id}`)
    expect(suggestionKey(bareRemix)).toBe(`soundcloud:${bareUpload.id}`)
  })
})

describe('uploadsByPlatform', () => {
  it("takes each platform's most played upload, YouTube first", () => {
    expect(uploadsByPlatform(artyRemix)).toEqual([artyYoutube, artySoundcloud])
    expect(uploadsByPlatform(nightFerryBootleg)).toEqual(nightFerryBootleg.uploads)
  })

  it('lists SoundCloud second even when it is the most played', () => {
    const scFirst = { ...artyRemix, uploads: [artySoundcloud, artyReupload] }
    expect(uploadsByPlatform(scFirst)).toEqual([artyReupload, artySoundcloud])
  })
})

describe('uploadText', () => {
  it('describes an upload by platform, uploader, plays and length', () => {
    expect(uploadText(artyYoutube)).toBe('YouTube · Anjunabeats · 908K views · 3:34')
    expect(uploadText(artySoundcloud)).toBe('SoundCloud · Anjunabeats · 382K plays · 3:35')
  })

  it('leaves out what it lacks', () => {
    expect(uploadText(bareUpload)).toBe('SoundCloud')
  })
})

describe('genreCounts', () => {
  it('counts each genre, most suggestions first, and skips suggestions without one', () => {
    expect(genreCounts(remixes.suggestions)).toEqual([
      { name: 'Afro House', count: 2 },
      { name: 'Trance', count: 1 },
    ])
  })

  it('orders genres with the same count by name', () => {
    expect(genreCounts([artyRemix, extendedMix])).toEqual([
      { name: 'Afro House', count: 1 },
      { name: 'Trance', count: 1 },
    ])
    expect(genreCounts([bareRemix])).toEqual([])
  })
})

describe('searchFailures', () => {
  it('has a note for each failed search only', () => {
    expect(searchFailures(remixes.searches)).toEqual([])
    expect(searchFailures(quickRemixes.searches)).toEqual([])
    expect(
      searchFailures({
        youtube: { status: 'ok', found: 3 },
        soundcloud: failed('Too many requests.'),
      }),
    ).toEqual([{ platform: 'soundcloud', text: 'SoundCloud search failed: Too many requests.' }])
  })
})

describe('emptyText', () => {
  it('names the platforms whose search went fine', () => {
    expect(emptyText(noRemixes.searches)).toBe('No remixes found on YouTube or SoundCloud.')
    expect(emptyText({ youtube: { status: 'ok', found: 0 }, soundcloud: failed('Down.') })).toBe(
      'No remixes found on YouTube.',
    )
    expect(emptyText(quickRemixes.searches)).toBe('No remixes found on YouTube.')
  })

  it('says nothing when no search went fine', () => {
    expect(emptyText({ youtube: failed('Down.'), soundcloud: failed('Down.') })).toBeUndefined()
  })
})

describe('searchingText and remixCount', () => {
  it('word the running searches and the count', () => {
    expect(searchingText(['soundcloud'])).toBe('Searching SoundCloud…')
    expect(searchingText(['youtube', 'soundcloud'])).toBe('Searching YouTube and SoundCloud…')
    expect(remixCount(1)).toBe('1 remix')
    expect(remixCount(0)).toBe('0 remixes')
    expect(remixCount(12)).toBe('12 remixes')
  })
})
