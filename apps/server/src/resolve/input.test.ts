import { urlRejectionMessage } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import { checkUrl, OUT_OF_SCOPE_MESSAGE, SPOTIFY_OTHER_MESSAGE } from './input.ts'

describe('checkUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube', 'youtube_video'],
    [
      'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
      'soundcloud',
      'soundcloud_track',
    ],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'spotify_track'],
    ['https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4', 'spotify', 'spotify_album'],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'spotify_playlist'],
    ['https://vimeo.com/76979871', 'other', 'other'],
  ])('accepts %s as a %s %s', (url, platform, kind) => {
    expect(checkUrl(url)).toMatchObject({ ok: true, input: { platform, kind } })
  })

  it('hands on the canonical Spotify link, without its share token or language prefix', () => {
    const checked = checkUrl('open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=a1b2c3')
    expect(checked).toEqual({
      ok: true,
      input: {
        ok: true,
        url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
        platform: 'spotify',
        kind: 'spotify_track',
        guess: 'track',
        spotifyId: '4uLU6hMCjMI75M1A2tKUQC',
      },
    })
  })

  it.each([
    ['notaurl', 'not_a_url'],
    ['   ', 'empty'],
    ['ftp://example.com/x', 'not_http'],
    ['https://dj:secret@soundcloud.com/x', 'credentials'],
  ] as const)('refuses %j as invalid_url', (url, reason) => {
    expect(checkUrl(url)).toEqual({
      ok: false,
      kind: 'invalid',
      error: { code: 'invalid_url', message: urlRejectionMessage(reason) },
    })
  })

  it.each([
    'https://music.apple.com/us/album/x/1440857781?i=1440857786',
    'https://tidal.com/browse/track/1',
    'https://www.deezer.com/track/1',
    'https://www.beatport.com/track/x/1',
    'https://music.amazon.com/albums/B0000000000',
  ])('refuses the DRM service %s as unsupported_url', (url) => {
    expect(checkUrl(url)).toEqual({
      ok: false,
      kind: 'out_of_scope',
      error: { code: 'unsupported_url', message: OUT_OF_SCOPE_MESSAGE },
    })
  })

  it('no longer names Spotify among the services it never downloads from', () => {
    expect(OUT_OF_SCOPE_MESSAGE).not.toContain('Spotify')
    expect(OUT_OF_SCOPE_MESSAGE).toMatch(/Apple Music.*Beatport.*DRM-protected/)
  })

  it.each([
    'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt',
    'https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ',
    'https://open.spotify.com/show/2mTUnDkuKUkhiueKcVWoP0',
    'https://open.spotify.com/user/spotify',
    'https://open.spotify.com/track/notAnId',
    'https://spotify.link/abc123',
    'https://www.spotify.com/us/premium/',
  ])('refuses the Spotify page %s, which is no track or list, as unsupported_url', (url) => {
    expect(checkUrl(url)).toEqual({
      ok: false,
      kind: 'spotify_other',
      error: { code: 'unsupported_url', message: SPOTIFY_OTHER_MESSAGE },
    })
  })

  it('tells the user what to do with a Spotify short link', () => {
    expect(SPOTIFY_OTHER_MESSAGE).toContain('spotify.link')
    expect(SPOTIFY_OTHER_MESSAGE).toContain('open.spotify.com')
  })
})
