import {
  classifyUrl,
  type Platform,
  type ResolveMode,
  SPOTIFY_OTHER_MESSAGE,
  type UrlGuess,
  urlRejectionMessage,
  type ValidUrl,
} from '@dj-scraper/shared'

/** What the result will look like, for the loading skeleton: a track card, a list, or unknown. */
export type ResultShape = 'track' | 'list' | 'link'

/**
 * The instant judgement of the paste box's text, before the server answers.
 * - `empty`/`invalid`: not a link; `message` says why (shown once the user tries to load it).
 * - `refused`: a link the server would refuse, so it isn't sent: a DRM streaming service
 *   (non-negotiable 7), or a Spotify page that isn't a track, album or playlist. `label` is the
 *   badge's word for it, `message` says why.
 * - `ok`: worth resolving; `url` is normalized, `label` is the badge's guess ("Playlist").
 */
export type UrlVerdict =
  | { status: 'empty'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'refused'; label: string; message: string }
  | {
      status: 'ok'
      url: string
      platform: Platform
      label: string
      shape: ResultShape
      /** A SoundCloud secret link: the URL itself grants access. */
      secret: boolean
    }

export const DRM_LABEL = 'DRM service: not supported'
export const DRM_MESSAGE =
  "Apple Music, Amazon Music, Tidal, Deezer and Beatport streams are DRM-protected, so DJ Scraper can't download them."

/** An artist, podcast or user page, or a `spotify.link` short link: no track list to read. */
export const SPOTIFY_OTHER_LABEL = 'Spotify: not a track or list'
/** The server's own words for it (422 `unsupported_url`), from the contract. */
export { SPOTIFY_OTHER_MESSAGE }

export function urlVerdict(text: string): UrlVerdict {
  const classified = classifyUrl(text)
  if (!classified.ok) {
    const message = urlRejectionMessage(classified.reason)
    return classified.reason === 'empty'
      ? { status: 'empty', message }
      : { status: 'invalid', message }
  }
  if (classified.kind === 'out_of_scope') {
    return { status: 'refused', label: DRM_LABEL, message: DRM_MESSAGE }
  }
  if (classified.kind === 'spotify_other') {
    return { status: 'refused', label: SPOTIFY_OTHER_LABEL, message: SPOTIFY_OTHER_MESSAGE }
  }
  return {
    status: 'ok',
    url: classified.url,
    platform: classified.platform,
    label: guessLabel(classified),
    shape: SHAPE_BY_GUESS[classified.guess],
    secret: classified.secret === true,
  }
}

/** The badge's word for what a link points at, judged from its shape alone. */
export function guessLabel(url: ValidUrl): string {
  switch (url.kind) {
    case 'youtube_video':
    case 'soundcloud_track':
    case 'spotify_track':
      return 'Track'
    case 'youtube_watch_list':
      if (url.collectionKind === 'album') return 'Track in an album'
      if (url.collectionKind === 'mix') return 'Track in a mix'
      return 'Track in a playlist'
    case 'youtube_playlist':
      return url.collectionKind === 'mix' ? 'Mix' : 'Playlist'
    case 'youtube_album':
    case 'spotify_album':
      return 'Album'
    case 'spotify_playlist':
      return 'Playlist'
    case 'youtube_channel':
    case 'soundcloud_user':
      return 'Channel'
    case 'soundcloud_set':
      return 'Set'
    case 'soundcloud_likes':
      return 'Likes'
    case 'soundcloud_short':
    case 'spotify_other':
    case 'out_of_scope':
    case 'other':
      return 'Link'
  }
}

/** `ambiguous` (a track in a list) first looks up the track, so it loads like one. */
const SHAPE_BY_GUESS: Record<UrlGuess, ResultShape> = {
  track: 'track',
  ambiguous: 'track',
  collection: 'list',
  unknown: 'link',
}

/** What a resolve of `url` in `mode` will most likely show, for its skeleton. */
export function loadingShape(url: string, mode: ResolveMode): ResultShape {
  if (mode === 'collection') return 'list'
  if (mode === 'track') return 'track'
  const verdict = urlVerdict(url)
  return verdict.status === 'ok' ? verdict.shape : 'link'
}
