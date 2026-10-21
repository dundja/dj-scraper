import { classifyUrl, urlRejectionMessage, type ValidUrl } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { urls } from '@/test/resolve.ts'
import {
  DRM_LABEL,
  DRM_MESSAGE,
  guessLabel,
  loadingShape,
  SPOTIFY_OTHER_LABEL,
  SPOTIFY_OTHER_MESSAGE,
  urlVerdict,
} from './url-verdict.ts'

function valid(url: string): ValidUrl {
  const classified = classifyUrl(url)
  if (!classified.ok) throw new Error(`not a valid URL: ${url}`)
  return classified
}

describe('urlVerdict', () => {
  it('gives a link its normalized URL, platform, guess and skeleton shape', () => {
    expect(urlVerdict(`  ${urls.track} `)).toEqual({
      status: 'ok',
      url: urls.track,
      platform: 'youtube',
      label: 'Track',
      shape: 'track',
      secret: false,
    })
    expect(urlVerdict('soundcloud.com/crate-diggers/sets/late-night-selects')).toEqual({
      status: 'ok',
      url: urls.scSet,
      platform: 'soundcloud',
      label: 'Set',
      shape: 'list',
      secret: false,
    })
  })

  it('loads a track in a list like a track: the server looks up the track first', () => {
    expect(urlVerdict(urls.watchList)).toMatchObject({
      label: 'Track in a playlist',
      shape: 'track',
    })
  })

  it('marks a SoundCloud secret link', () => {
    expect(urlVerdict('https://soundcloud.com/jaimemf/youtube-dl-test/s-8Pjrp')).toMatchObject({
      label: 'Track',
      secret: true,
    })
  })

  it('takes any other website as a link yt-dlp may know', () => {
    expect(urlVerdict('https://bandcamp.com/album/x')).toMatchObject({
      status: 'ok',
      platform: 'other',
      label: 'Link',
      shape: 'link',
    })
  })

  it('refuses DRM services without resolving them', () => {
    expect(urlVerdict(urls.drm)).toEqual({
      status: 'refused',
      label: DRM_LABEL,
      message: DRM_MESSAGE,
    })
    expect(urlVerdict('https://tidal.com/browse/track/77646169')).toMatchObject({
      status: 'refused',
      label: DRM_LABEL,
    })
    expect(DRM_LABEL).toBe('DRM service: not supported')
    // Spotify is read as a track list now (ADR-026), so the DRM services no longer name it.
    expect(DRM_MESSAGE).toBe(
      "Apple Music, Amazon Music, Tidal, Deezer and Beatport streams are DRM-protected, so DJ Scraper can't download them.",
    )
  })

  it('takes Spotify tracks, albums and playlists at their canonical URL, without the share token', () => {
    expect(urlVerdict(`${urls.spotifyTrack}?si=1b2c3d4e5f6a7b8c`)).toEqual({
      status: 'ok',
      url: urls.spotifyTrack,
      platform: 'spotify',
      label: 'Track',
      shape: 'track',
      secret: false,
    })
    expect(urlVerdict('https://open.spotify.com/intl-de/album/6N9PS4QXF1D0OWPk0Sxtb4')).toEqual({
      status: 'ok',
      url: urls.spotifyAlbum,
      platform: 'spotify',
      label: 'Album',
      shape: 'list',
      secret: false,
    })
    expect(urlVerdict(urls.spotifyPlaylist)).toMatchObject({
      status: 'ok',
      platform: 'spotify',
      label: 'Playlist',
      shape: 'list',
    })
  })

  it.each([
    ['an artist page', urls.spotifyArtist],
    ['a podcast', 'https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL'],
    ['a short link', 'https://spotify.link/AbCdEfGhIjK'],
  ])("refuses %s on Spotify with the server's words, without resolving it", (_name, url) => {
    expect(urlVerdict(url)).toEqual({
      status: 'refused',
      label: SPOTIFY_OTHER_LABEL,
      message: SPOTIFY_OTHER_MESSAGE,
    })
  })

  it('says why text is not a link, with the shared wording', () => {
    expect(urlVerdict('')).toEqual({ status: 'empty', message: urlRejectionMessage('empty') })
    expect(urlVerdict('   ')).toEqual({ status: 'empty', message: urlRejectionMessage('empty') })
    expect(urlVerdict('hello')).toEqual({
      status: 'invalid',
      message: urlRejectionMessage('not_a_url'),
    })
    expect(urlVerdict('ftp://example.com/a')).toEqual({
      status: 'invalid',
      message: urlRejectionMessage('not_http'),
    })
    expect(urlVerdict('https://me:secret@soundcloud.com/a/b')).toEqual({
      status: 'invalid',
      message: urlRejectionMessage('credentials'),
    })
  })
})

describe('guessLabel', () => {
  it.each([
    ['https://youtu.be/XNEnEBrHws8', 'Track'],
    ['https://www.youtube.com/shorts/XNEnEBrHws8', 'Track'],
    [urls.watchList, 'Track in a playlist'],
    [
      'https://www.youtube.com/watch?v=XNEnEBrHws8&list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
      'Track in an album',
    ],
    [urls.mix, 'Track in a mix'],
    [urls.playlist, 'Playlist'],
    ['https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ', 'Mix'],
    [
      'https://www.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs',
      'Playlist',
    ],
    ['https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0', 'Album'],
    ['https://music.youtube.com/browse/MPREb_abc123', 'Album'],
    ['https://www.youtube.com/@djscraper', 'Channel'],
    ['https://www.youtube.com/@djscraper/videos', 'Channel'],
    [urls.scTrack, 'Track'],
    [urls.scSet, 'Set'],
    ['https://soundcloud.com/the-concept-band', 'Channel'],
    [urls.userSets, 'Channel'],
    ['https://soundcloud.com/the-concept-band/likes', 'Likes'],
    ['https://on.soundcloud.com/AbCdEf', 'Link'],
    ['https://vimeo.com/123', 'Link'],
    [urls.spotifyTrack, 'Track'],
    [urls.spotifyAlbum, 'Album'],
    [urls.spotifyPlaylist, 'Playlist'],
    [urls.spotifyArtist, 'Link'],
  ])('%s → %s', (url, label) => {
    expect(guessLabel(valid(url))).toBe(label)
  })
})

describe('loadingShape', () => {
  it('follows the guess in auto mode', () => {
    expect(loadingShape(urls.track, 'auto')).toBe('track')
    expect(loadingShape(urls.watchList, 'auto')).toBe('track')
    expect(loadingShape(urls.playlist, 'auto')).toBe('list')
    expect(loadingShape('https://on.soundcloud.com/AbCdEf', 'auto')).toBe('link')
    expect(loadingShape(urls.spotifyTrack, 'auto')).toBe('track')
    expect(loadingShape(urls.spotifyAlbum, 'auto')).toBe('list')
  })

  it('follows the mode when it says which', () => {
    expect(loadingShape(urls.watchList, 'collection')).toBe('list')
    expect(loadingShape(urls.watchList, 'track')).toBe('track')
  })

  it('has no shape to guess for text that is not a link', () => {
    expect(loadingShape('nope', 'auto')).toBe('link')
  })
})
