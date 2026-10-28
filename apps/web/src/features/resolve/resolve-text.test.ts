import { MAX_PASTED_LINKS } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  collectionResult,
  ambiguous as fixtures,
  pastedLinks,
  playlist,
  scSet,
  trackResult,
  userPageWithLists,
} from '@/test/resolve.ts'
import {
  ambiguousWording,
  bigListNote,
  countOf,
  loadingLabel,
  pastedLinksNote,
  resultAnnouncement,
  submissionLoadingLabel,
  submissionShape,
} from './resolve-text.ts'

describe('ambiguousWording', () => {
  it('asks about a playlist', () => {
    expect(ambiguousWording('playlist')).toEqual({
      question: 'This track or the whole playlist?',
      track: 'This track',
      list: 'Whole playlist',
      openList: 'Open the playlist',
      note: 'The link opens a track inside a playlist.',
    })
  })

  it('asks about an album', () => {
    expect(ambiguousWording('album')).toMatchObject({
      question: 'This track or the whole album?',
      track: 'This track',
      list: 'Whole album',
      openList: 'Open the album',
    })
  })

  it('says a mix loads only its first 50 tracks', () => {
    const wording = ambiguousWording('mix')
    expect(wording).toMatchObject({
      question: 'This track or the mix?',
      track: 'This track',
      list: 'Load the mix (first 50)',
      openList: 'Open the mix (first 50)',
    })
    expect(wording.note).toContain('never ends')
  })
})

describe('loadingLabel', () => {
  it('names what is loading', () => {
    expect(loadingLabel('track')).toBe('Loading the track…')
    expect(loadingLabel('list')).toBe('Loading the list…')
    expect(loadingLabel('link')).toBe('Loading the link…')
  })
})

describe('submissionLoadingLabel', () => {
  it('words a link by its likely shape, and pasted links by their count', () => {
    const link = { kind: 'link', url: playlist.url, mode: 'auto', seq: 1 } as const
    expect(submissionShape(link)).toBe('list')
    expect(submissionLoadingLabel(link)).toBe('Loading the list…')
    expect(submissionLoadingLabel({ ...link, mode: 'track' })).toBe('Loading the track…')

    const urls = Array.from({ length: 1312 }, (_, n) => `https://open.spotify.com/track/${n}`)
    const links = { kind: 'links', urls, seq: 2 } as const
    expect(submissionShape(links)).toBe('list')
    expect(submissionLoadingLabel(links)).toBe('Loading 1,312 Spotify tracks…')
    expect(submissionLoadingLabel({ ...links, urls: urls.slice(0, 1) })).toBe(
      'Loading 1 Spotify track…',
    )
  })
})

describe('pastedLinksNote', () => {
  it('says how many links the emptied box loaded', () => {
    expect(pastedLinksNote(312)).toBe('Pasted 312 Spotify track links: they load as one list.')
    expect(pastedLinksNote(MAX_PASTED_LINKS)).toBe(
      'Pasted the first 5,000 Spotify track links, the most one list takes: paste any others on their own.',
    )
  })
})

describe('bigListNote', () => {
  it("gives YouTube's measured listing times", () => {
    expect(bigListNote('youtube')).toBe(
      'Big lists take a while: 1,800 videos ≈ 20 s, 5,000 ≈ 1 min.',
    )
  })

  it('stays general for other platforms', () => {
    expect(bigListNote('soundcloud')).toBe('Big lists take a while.')
    expect(bigListNote('other')).toBe('Big lists take a while.')
  })
})

describe('countOf', () => {
  it('counts with thousands separators and plurals', () => {
    expect(countOf(0, 'track')).toBe('0 tracks')
    expect(countOf(1, 'track')).toBe('1 track')
    expect(countOf(1800, 'track')).toBe('1,800 tracks')
  })
})

describe('resultAnnouncement', () => {
  it('names a track', () => {
    expect(resultAnnouncement(trackResult())).toBe('Track: The Chill Zone')
  })

  it('names a list, its kind and its rows', () => {
    expect(resultAnnouncement(collectionResult(playlist))).toBe(
      'Playlist: Warm-up Selection, 30 tracks',
    )
    expect(resultAnnouncement(collectionResult(scSet))).toBe('Set: Late Night Selects, 8 tracks')
  })

  it('counts the lists of a page that has no tracks, only lists', () => {
    expect(resultAnnouncement(collectionResult(userPageWithLists))).toBe(
      'Channel: The Royal Concept (Sets), 4 lists',
    )
  })

  it('names pasted links by their title alone: they have no page or kind of their own', () => {
    expect(resultAnnouncement(collectionResult(pastedLinks))).toBe(
      'Pasted Spotify tracks, 3 tracks',
    )
  })

  it('asks the question of an ambiguous link', () => {
    expect(resultAnnouncement(fixtures.album)).toBe('This track or the whole album?')
  })
})
