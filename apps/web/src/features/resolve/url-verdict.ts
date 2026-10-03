import {
  classifyUrl,
  type Platform,
  type ResolveMode,
  type UrlGuess,
  urlRejectionMessage,
  type ValidUrl,
} from '@dj-scraper/shared'

/** What the result will look like, for the loading skeleton: a track card, a list, or unknown. */
export type ResultShape = 'track' | 'list' | 'link'

/**
 * The instant judgement of the paste box's text, before the server answers.
 * - `empty`/`invalid`: not a link; `message` says why (shown once the user tries to load it).
 * - `drm`: a DRM streaming service, refused without resolving (non-negotiable 7).
 * - `ok`: worth resolving; `url` is normalized, `label` is the badge's guess ("Playlist").
 */
export type UrlVerdict =
  | { status: 'empty'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'drm'; label: string; message: string }
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
  "Spotify, Apple Music, Amazon Music, Tidal, Deezer and Beatport streams are DRM-protected, so DJ Scraper can't download them."

export function urlVerdict(text: string): UrlVerdict {
  const classified = classifyUrl(text)
  if (!classified.ok) {
    const message = urlRejectionMessage(classified.reason)
    return classified.reason === 'empty'
      ? { status: 'empty', message }
      : { status: 'invalid', message }
  }
  if (classified.kind === 'out_of_scope') {
    return { status: 'drm', label: DRM_LABEL, message: DRM_MESSAGE }
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
      return 'Track'
    case 'youtube_watch_list':
      if (url.collectionKind === 'album') return 'Track in an album'
      if (url.collectionKind === 'mix') return 'Track in a mix'
      return 'Track in a playlist'
    case 'youtube_playlist':
      return url.collectionKind === 'mix' ? 'Mix' : 'Playlist'
    case 'youtube_album':
      return 'Album'
    case 'youtube_channel':
    case 'soundcloud_user':
      return 'Channel'
    case 'soundcloud_set':
      return 'Set'
    case 'soundcloud_likes':
      return 'Likes'
    case 'soundcloud_short':
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
