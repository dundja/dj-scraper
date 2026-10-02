import type { CollectionKind } from './collection.ts'
import type { Platform } from './platform.ts'
import type { AmbiguousListKind } from './resolve.ts'
import { MAX_URL_LENGTH } from './url.ts'

/** Why `classifyUrl` refused the input. The server answers these with `invalid_url`. */
export type UrlRejection = 'empty' | 'too_long' | 'not_a_url' | 'not_http' | 'credentials'

/**
 * What a URL points at, judged from its shape alone (no network).
 * - `youtube_video`: `watch?v=…`, `youtu.be/…`, `/shorts/…`, `/live/…`, `/embed/…`, `/v/…`.
 * - `youtube_watch_list`: `watch?v=…&list=…`, a track inside a list. The server answers
 *   `ambiguous` in `auto` mode; `collectionKind` says whether the list is a mix or an album.
 * - `youtube_playlist`: `/playlist?list=…`, `watch?list=…` without a video, or the embed player's
 *   `/embed/videoseries?list=…` (`embeddedList`); `collectionKind` is `playlist` or `mix` (`RD…`,
 *   except YouTube Music's finite `RDCLAK5uy_…` lists).
 * - `youtube_album`: the same URLs with an `OLAK5uy_…` list, or YouTube Music's
 *   `music.youtube.com/browse/MPREb_…`; `collectionKind` is `album`.
 * - `youtube_channel`: `/@handle`, `/channel/UC…`, `/c/…`, `/user/…`, with or without a tab.
 * - `soundcloud_user`: a user page or one of its tabs other than likes.
 * - `soundcloud_short`: `on.soundcloud.com/…`, unknown until yt-dlp follows it.
 * - `out_of_scope`: DRM streaming services (Spotify, Apple Music, Amazon Music, Tidal, Deezer,
 *   Beatport). The server refuses them with `unsupported_url` without starting yt-dlp.
 * - `other`: any other http(s) URL; yt-dlp decides what it is.
 */
export type UrlKind =
  | 'youtube_video'
  | 'youtube_watch_list'
  | 'youtube_playlist'
  | 'youtube_album'
  | 'youtube_channel'
  | 'soundcloud_track'
  | 'soundcloud_set'
  | 'soundcloud_user'
  | 'soundcloud_likes'
  | 'soundcloud_short'
  | 'out_of_scope'
  | 'other'

/** The instant badge the web shows before the server answers. */
export type UrlGuess = 'track' | 'collection' | 'ambiguous' | 'unknown'

export type ClassifiedUrl =
  | { ok: false; reason: UrlRejection }
  | {
      ok: true
      /** Normalized (`new URL(…).href`, `https://` added when the scheme was left off). */
      url: string
      platform: Platform
      kind: UrlKind
      guess: UrlGuess
      /** The list's kind, for collections and `youtube_watch_list`. */
      collectionKind?: CollectionKind
      /** YouTube video id (watch, youtu.be, shorts, live, embed). */
      videoId?: string
      /** YouTube list id (`list=`) or YouTube Music album browse id (`MPREb_…`). */
      listId?: string
      /**
       * A YouTube embed player URL for a list (`/embed/videoseries?list=…`): yt-dlp doesn't know it
       * on every YouTube host, so resolve the list's `/playlist?list=…` URL instead. Present only
       * when true.
       */
      embeddedList?: boolean
      /**
       * A YouTube channel URL without a tab (or on its `featured` tab): yt-dlp lists its tabs, so
       * resolve the channel's `/videos` tab instead. Present only when true.
       */
      channelRoot?: boolean
      /**
       * A SoundCloud secret link (`/s-…` or `secret_token=`): the URL is a credential, so never log
       * it. Present only when true.
       */
      secret?: boolean
    }

export type ValidUrl = Extract<ClassifiedUrl, { ok: true }>

/** What the host-specific rules decide; `classifyUrl` adds the url, platform and guess. */
type UrlShape = Omit<ValidUrl, 'ok' | 'url' | 'platform' | 'guess'>

const OTHER: UrlShape = { kind: 'other' }

/** The badge follows from the kind alone, so the two can never disagree. */
const GUESS_BY_KIND: Record<UrlKind, UrlGuess> = {
  youtube_video: 'track',
  youtube_watch_list: 'ambiguous',
  youtube_playlist: 'collection',
  youtube_album: 'collection',
  youtube_channel: 'collection',
  soundcloud_track: 'track',
  soundcloud_set: 'collection',
  soundcloud_user: 'collection',
  soundcloud_likes: 'collection',
  soundcloud_short: 'unknown',
  out_of_scope: 'unknown',
  other: 'unknown',
}

/** Scheme-less text that starts with a dotted host name (`youtu.be/…`, `soundcloud.com/…`). */
const SCHEMELESS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i

/** Services whose streams are DRM-protected (non-negotiable 7); subdomains count too. */
const DRM_DOMAINS = [
  'spotify.com',
  'spotify.link',
  'music.apple.com',
  'itunes.apple.com',
  'tidal.com',
  'deezer.com',
  'deezer.page.link',
  'beatport.com',
]
/**
 * Amazon Music on every marketplace (`music.amazon.com`, `.de`, `.co.uk`, `.com.au`, …) and its
 * subdomains. A whole-label match: `notmusic.amazon.com` and `music.amazon.com.evil.example` don't
 * count.
 */
const AMAZON_MUSIC_HOST = /(?:^|\.)music\.amazon\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_LIST_ID = /^[A-Za-z0-9_-]+$/
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
const YOUTUBE_ALBUM_BROWSE_ID = /^MPREb_[A-Za-z0-9_-]+$/
/** Paths of the form `/<prefix>/<video id>`. */
const YOUTUBE_VIDEO_PREFIXES = new Set(['shorts', 'live', 'embed', 'v'])
/**
 * Embed paths whose second segment has a video id's shape but isn't one: `/embed/videoseries?list=…`
 * embeds a list, `/embed/live_stream?channel=…` a channel's stream (yt-dlp's YoutubeIE excludes
 * both).
 */
const YOUTUBE_NOT_VIDEO_IDS = new Set(['videoseries', 'live_stream'])
const YOUTUBE_EMBED_LIST = 'videoseries'
/**
 * Channel tabs that list videos or playlists. Others (`community`, `about`, `store`, `search`, and
 * `live`, which redirects to a single stream) stay `other`.
 */
const YOUTUBE_CHANNEL_TABS = new Set([
  'videos',
  'shorts',
  'streams',
  'playlists',
  'releases',
  'podcasts',
])

const SOUNDCLOUD_PAGE_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
const SOUNDCLOUD_API_HOSTS = new Set(['api.soundcloud.com', 'api-v2.soundcloud.com'])
const SOUNDCLOUD_SHORT_HOST = 'on.soundcloud.com'
/** User and track permalinks. */
const SOUNDCLOUD_SLUG = /^[A-Za-z0-9_-]+$/
const SOUNDCLOUD_SECRET_SEGMENT = /^s-[A-Za-z0-9_-]+$/
const SOUNDCLOUD_API_ID = /^\d+$/
/** First path segments that are SoundCloud's own pages, not user permalinks. */
const SOUNDCLOUD_RESERVED = new Set([
  'apps',
  'charts',
  'connect',
  'creators',
  'discover',
  'embed',
  'explore',
  'feed',
  'imprint',
  'jobs',
  'login',
  'logout',
  'messages',
  'mobile',
  'notifications',
  'oauth',
  'oembed',
  'pages',
  'people',
  'player',
  'playlists',
  'popular',
  'premium',
  'pro',
  'register',
  'search',
  'settings',
  'signin',
  'signup',
  'stations',
  'stream',
  'tags',
  'terms-of-use',
  'tracks',
  'upload',
  'users',
  'widget',
])
/** User-page tabs that list tracks (and sets, which the server skips). Likes have their own kind. */
const SOUNDCLOUD_USER_TABS = new Set([
  'tracks',
  'popular-tracks',
  'reposts',
  'albums',
  'sets',
  'toptracks',
  'spotlight',
])
/** Second segments that are neither a track nor a listing tab. */
const SOUNDCLOUD_NOT_TRACKS = new Set(['likes', 'comments', 'followers', 'following', 'groups'])
/** `/you/…` is the signed-in user's own page: only its listing tabs are meaningful. */
const SOUNDCLOUD_SELF = 'you'

/**
 * Classifies pasted text without the network. Trims it, adds `https://` to scheme-less input that
 * starts with a host (`youtu.be/…`, `soundcloud.com/…`) or with `//`, drops trailing dots from the
 * host, and rejects empty input, input or a normalized URL longer than `MAX_URL_LENGTH`, anything
 * that isn't an http(s) URL, and URLs with a username or password (argv is visible in `ps`). Used by
 * the web for the instant badge and by the server to validate and route `POST /api/resolve`.
 */
export function classifyUrl(input: string): ClassifiedUrl {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' }

  const candidate = text.startsWith('//')
    ? `https:${text}`
    : SCHEMELESS_HOST.test(text)
      ? `https://${text}`
      : text
  if (!URL.canParse(candidate)) return { ok: false, reason: 'not_a_url' }
  const url = new URL(candidate)
  const { protocol } = url
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: false, reason: 'not_http' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  // DNS ignores a trailing dot (`open.spotify.com.`, also typed as `。`), but the host rules below
  // would not: drop it before they run, and from the URL yt-dlp gets.
  const host = url.hostname.replace(/\.+$/, '')
  if (host !== url.hostname) url.hostname = host
  // An http(s) URL can't have an empty host: the setter refuses it, leaving the dots.
  if (host === '' || url.hostname !== host) return { ok: false, reason: 'not_a_url' }
  // Percent-encoding can triple the length of pasted text.
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' }

  const { platform, shape } = describeUrl(url)
  return { ok: true, url: url.href, platform, guess: GUESS_BY_KIND[shape.kind], ...shape }
}

const REJECTION_MESSAGES: Record<UrlRejection, string> = {
  empty: 'Paste a YouTube or SoundCloud link.',
  too_long: 'That link is too long.',
  not_a_url: "That doesn't look like a link.",
  not_http: 'Only http and https links work here.',
  credentials: "Links with a username or password aren't supported.",
}

/** Human text for a rejection, for the paste box and the server's `invalid_url` message. */
export function urlRejectionMessage(reason: UrlRejection): string {
  return REJECTION_MESSAGES[reason]
}

function describeUrl(url: URL): { platform: Platform; shape: UrlShape } {
  const host = url.hostname
  if (isDrmHost(host)) return { platform: 'other', shape: { kind: 'out_of_scope' } }
  // An explicit non-default port means it isn't the real site, and yt-dlp wouldn't match it either.
  if (url.port === '') {
    if (YOUTUBE_HOSTS.has(host)) return { platform: 'youtube', shape: youtubeShape(url) }
    if (
      SOUNDCLOUD_PAGE_HOSTS.has(host) ||
      SOUNDCLOUD_API_HOSTS.has(host) ||
      host === SOUNDCLOUD_SHORT_HOST
    ) {
      return { platform: 'soundcloud', shape: soundcloudShape(url) }
    }
  }
  return { platform: 'other', shape: OTHER }
}

function isDrmHost(host: string): boolean {
  return (
    DRM_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    AMAZON_MUSIC_HOST.test(host)
  )
}

/** Non-empty path segments, so trailing and doubled slashes don't matter. */
function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment !== '')
}

function youtubeShape(url: URL): UrlShape {
  const segments = pathSegments(url)
  const listParam = url.searchParams.get('list')
  const listId = listParam !== null && YOUTUBE_LIST_ID.test(listParam) ? listParam : undefined
  const videoId = youtubeVideoId(url, segments)

  if (videoId !== undefined) {
    if (listId === undefined) return { kind: 'youtube_video', videoId }
    return { kind: 'youtube_watch_list', videoId, listId, collectionKind: youtubeListKind(listId) }
  }
  if (url.hostname === 'youtu.be') return OTHER

  const [first, second] = segments
  const embeddedList = segments.length === 2 && first === 'embed' && second === YOUTUBE_EMBED_LIST
  if (embeddedList || (segments.length === 1 && (first === 'playlist' || first === 'watch'))) {
    if (listId === undefined) return OTHER
    const collectionKind = youtubeListKind(listId)
    const kind = collectionKind === 'album' ? 'youtube_album' : 'youtube_playlist'
    return embeddedList
      ? { kind, listId, collectionKind, embeddedList: true }
      : { kind, listId, collectionKind }
  }
  if (
    url.hostname === 'music.youtube.com' &&
    segments.length === 2 &&
    first === 'browse' &&
    second !== undefined &&
    YOUTUBE_ALBUM_BROWSE_ID.test(second)
  ) {
    return { kind: 'youtube_album', listId: second, collectionKind: 'album' }
  }
  return youtubeChannelShape(segments) ?? OTHER
}

/** The 11-character id of a single-video URL; `watch?v=` with a malformed id doesn't count. */
function youtubeVideoId(url: URL, segments: string[]): string | undefined {
  const [first, second] = segments
  let candidate: string | null | undefined
  if (url.hostname === 'youtu.be') {
    if (segments.length === 1) candidate = first
  } else if (segments.length === 1 && first === 'watch') {
    candidate = url.searchParams.get('v')
  } else if (
    segments.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    YOUTUBE_VIDEO_PREFIXES.has(first) &&
    !YOUTUBE_NOT_VIDEO_IDS.has(second)
  ) {
    candidate = second
  }
  return typeof candidate === 'string' && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : undefined
}

/**
 * What kind of list a YouTube list id names: `OLAK5uy_…` is an album; `RD…` lists are endless
 * mixes, except YouTube Music's curated `RDCLAK5uy_…` playlists. Used for pasted URLs here and for
 * resolved list ids on the server, so the two can't disagree.
 */
export function youtubeListKind(listId: string): AmbiguousListKind {
  if (listId.startsWith('OLAK5uy_')) return 'album'
  if (listId.startsWith('RD') && !listId.startsWith('RDCLAK5uy_')) return 'mix'
  return 'playlist'
}

/** A YouTube channel id: `UC` + 22 characters. */
export function isYoutubeChannelId(id: string): boolean {
  return YOUTUBE_CHANNEL_ID.test(id)
}

function youtubeChannelShape(segments: string[]): UrlShape | undefined {
  const [first, second] = segments
  let tabIndex: number
  if (first !== undefined && first.length > 1 && first.startsWith('@')) {
    tabIndex = 1
  } else if (first === 'channel' && second !== undefined && isYoutubeChannelId(second)) {
    tabIndex = 2
  } else if ((first === 'c' || first === 'user') && second !== undefined) {
    tabIndex = 2
  } else {
    return undefined
  }
  if (segments.length > tabIndex + 1) return undefined

  const tab = segments[tabIndex]
  if (tab === undefined || tab === 'featured') {
    return { kind: 'youtube_channel', collectionKind: 'channel', channelRoot: true }
  }
  return YOUTUBE_CHANNEL_TABS.has(tab)
    ? { kind: 'youtube_channel', collectionKind: 'channel' }
    : undefined
}

function soundcloudShape(url: URL): UrlShape {
  const segments = pathSegments(url)
  let shape: UrlShape
  if (url.hostname === SOUNDCLOUD_SHORT_HOST) {
    shape = segments.length === 1 ? { kind: 'soundcloud_short' } : OTHER
  } else if (SOUNDCLOUD_API_HOSTS.has(url.hostname)) {
    shape = soundcloudApiShape(segments)
  } else {
    shape = soundcloudPageShape(segments)
  }
  // A token marks the URL as a credential whatever page it is on.
  const token = url.searchParams.get('secret_token')
  return token !== null && token !== '' ? { ...shape, secret: true } : shape
}

/** `api(-v2).soundcloud.com/tracks/<id>` and `/playlists/<id>`, as flat set listings return them. */
function soundcloudApiShape(segments: string[]): UrlShape {
  const [resource, id] = segments
  if (segments.length !== 2 || id === undefined || !SOUNDCLOUD_API_ID.test(id)) return OTHER
  if (resource === 'tracks') return { kind: 'soundcloud_track' }
  if (resource === 'playlists') return { kind: 'soundcloud_set', collectionKind: 'set' }
  return OTHER
}

function soundcloudPageShape(segments: string[]): UrlShape {
  const [user, second, third, fourth] = segments
  if (
    user === undefined ||
    segments.length > 4 ||
    !SOUNDCLOUD_SLUG.test(user) ||
    SOUNDCLOUD_RESERVED.has(user.toLowerCase())
  ) {
    return OTHER
  }
  const isSelf = user.toLowerCase() === SOUNDCLOUD_SELF
  if (second === undefined) {
    return isSelf ? OTHER : { kind: 'soundcloud_user', collectionKind: 'channel' }
  }

  const sub = second.toLowerCase()
  // /<user>/sets/<set>[/s-…]
  if (sub === 'sets' && third !== undefined) {
    if (isSelf || !SOUNDCLOUD_SLUG.test(third)) return OTHER
    if (fourth === undefined) return { kind: 'soundcloud_set', collectionKind: 'set' }
    return SOUNDCLOUD_SECRET_SEGMENT.test(fourth)
      ? { kind: 'soundcloud_set', collectionKind: 'set', secret: true }
      : OTHER
  }
  if (fourth !== undefined) return OTHER

  // /<user>/<tab>
  if (third === undefined) {
    if (sub === 'likes') return { kind: 'soundcloud_likes', collectionKind: 'likes' }
    if (SOUNDCLOUD_USER_TABS.has(sub)) return { kind: 'soundcloud_user', collectionKind: 'channel' }
  }

  // /<user>/<track>[/s-…]
  if (
    isSelf ||
    SOUNDCLOUD_USER_TABS.has(sub) ||
    SOUNDCLOUD_NOT_TRACKS.has(sub) ||
    !SOUNDCLOUD_SLUG.test(second)
  ) {
    return OTHER
  }
  if (third === undefined) return { kind: 'soundcloud_track' }
  return SOUNDCLOUD_SECRET_SEGMENT.test(third) ? { kind: 'soundcloud_track', secret: true } : OTHER
}
