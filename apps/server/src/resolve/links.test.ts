import { CollectionSchema, MAX_PASTED_LINKS } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../http/errors.ts'
import { LINKS_TITLE, linksCollection, NO_SPOTIFY_TRACKS } from './links.ts'

const A = '4uLU6hMCjMI75M1A2tKUQC'
const B = '6aiKIFjPwa3UvDCD5ecoJj'
const C = '76QJgXPE3oc1cnkE4PFHEn'
const link = (id: string) => `https://open.spotify.com/track/${id}`

function collectionOf(urls: readonly string[]) {
  const result = linksCollection(urls)
  if (result.kind !== 'collection') throw new Error(`expected a collection, got ${result.kind}`)
  return CollectionSchema.parse(result.collection)
}

const ids = (urls: readonly string[]) => collectionOf(urls).entries.map((entry) => entry.id)

describe('linksCollection', () => {
  it('lists Spotify track links as partial rows, in paste order', () => {
    expect(collectionOf([link(A), link(B)])).toStrictEqual({
      id: `links-${A}`,
      platform: 'spotify',
      url: link(A),
      kind: 'links',
      title: LINKS_TITLE,
      truncated: false,
      entries: [A, B].map((id) => ({
        partial: true,
        id,
        platform: 'spotify',
        url: link(id),
        availability: 'unknown',
      })),
    })
  })

  it('takes the canonical link of every form the Spotify app and site share', () => {
    const list = collectionOf([
      `${link(A)}?si=0123456789abcdef`,
      `open.spotify.com/intl-de/track/${B}`,
      `https://open.spotify.com/embed/track/${C}?utm_source=generator`,
    ])
    expect(list.entries.map((entry) => entry.url)).toEqual([link(A), link(B), link(C)])
    expect(list.skippedEntries).toBeUndefined()
  })

  it('lists a track once, where it first appears, and counts no repeat as skipped', () => {
    const list = collectionOf([link(A), link(B), `${link(A)}?si=x`, link(B)])
    expect(list.entries.map((entry) => entry.id)).toEqual([A, B])
    expect(list.skippedEntries).toBeUndefined()
  })

  it.each([
    ['an album', 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4'],
    ['a playlist', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
    ['an artist page', 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt'],
    ['a short link', 'https://spotify.link/abc123'],
    ['a YouTube video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a SoundCloud track', 'https://soundcloud.com/someone/a-track'],
    ['a DRM service', 'https://music.apple.com/us/album/x/1440857781?i=1440857786'],
    ['text', 'not a link'],
    ['a Spotify URI', `spotify:track:${C}`],
  ])('skips %s and counts it', (_label, url) => {
    const list = collectionOf([link(A), url])
    expect(list.entries.map((entry) => entry.id)).toEqual([A])
    expect(list.skippedEntries).toBe(1)
  })

  it('stands the first track in for the list’s url: no page holds the list', () => {
    expect(collectionOf(['not a link', link(B), link(A)]).url).toBe(link(B))
  })

  it('takes a full paste', () => {
    const urls = Array.from({ length: MAX_PASTED_LINKS }, (_, i) =>
      link(String(i).padStart(22, '0')),
    )
    expect(ids(urls)).toHaveLength(MAX_PASTED_LINKS)
  })

  it('refuses a paste without a Spotify track with unsupported_url', () => {
    const refusal = () =>
      linksCollection(['https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4', 'hello'])
    expect(refusal).toThrow(ApiError)
    expect(refusal).toThrow(NO_SPOTIFY_TRACKS)
    try {
      refusal()
    } catch (error) {
      expect(error).toMatchObject({ code: 'unsupported_url' })
    }
  })
})
