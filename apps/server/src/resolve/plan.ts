import {
  type AmbiguousListKind,
  MAX_COLLECTION_ENTRIES,
  MAX_MIX_ENTRIES,
  type ResolveMode,
  type ValidUrl,
} from '@dj-scraper/shared'

/** A single-track lookup: one page plus the player. */
export const TRACK_TIMEOUT_MS = 60_000
/**
 * A listing: YouTube pages 100 rows per request. A 5001-row listing was measured at 38.5 s for a
 * playlist and 56 s for a channel tab (test/fixtures/youtube/README.md), so this leaves headroom.
 */
export const COLLECTION_TIMEOUT_MS = 180_000

/** What to ask yt-dlp for, decided from the URL's shape and the requested mode. */
export type ResolvePlan = {
  /**
   * The URL to resolve: the input, or a rewrite (channel root → /videos, the list of a watch URL,
   * an embedded list → its /playlist page, a seeded mix → its seed video's watch URL).
   */
  url: string
  playlist?: 'yes' | 'no'
  /** The listing cap, passed to `resolveArgs` and `normalizeInfo`. */
  limit: number
  /** `track` when the answer can only be one track (it gets the shorter timeout). */
  expect: 'track' | 'any'
  /** Set for `watch?v=…&list=…` in `auto` mode: wrap the track as `ambiguous` with this list. */
  ambiguous?: { collectionUrl: string; collectionKind: AmbiguousListKind }
  timeoutMs: number
}

/**
 * Pure: classified URL + mode → plan. `out_of_scope` URLs must be refused before planning.
 * - `watch?v=…&list=…`: `auto` looks up only the track (`--no-playlist`) and offers the list;
 *   `track` takes the track; `collection` lists the list, capped at 50 rows for a mix.
 * - A YouTube video URL is always just the track. A channel root lists its uploads tab.
 * - A mix pasted as a list (`playlist?list=RD<video id>`) is listed from its seed video, capped
 *   at 50 rows, in every mode: YouTube only opens a mix next to a video.
 * - An embedded list (`/embed/videoseries?list=…`) is resolved at its `/playlist?list=…` page.
 * - Other kinds pass the mode on as a playlist flag (`auto` passes none).
 */
export function planResolve(input: ValidUrl, mode: ResolveMode): ResolvePlan {
  if (input.kind === 'out_of_scope') {
    throw new RangeError('planResolve: refuse out_of_scope URLs before planning')
  }

  if (input.kind === 'youtube_watch_list' && input.listId !== undefined) {
    const collectionKind = ambiguousKind(input.collectionKind)
    const collectionUrl = youtubeListUrl(input.listId, collectionKind, input.videoId)
    if (mode === 'collection') {
      const limit = collectionKind === 'mix' ? MAX_MIX_ENTRIES : MAX_COLLECTION_ENTRIES
      return listing(collectionUrl, 'yes', limit)
    }
    const track = single(input.url)
    return mode === 'auto' ? { ...track, ambiguous: { collectionUrl, collectionKind } } : track
  }

  // A watch_list without a list id can't offer the list; treat it as the video it names.
  if (input.kind === 'youtube_video' || input.kind === 'youtube_watch_list') {
    return single(input.url)
  }

  const playlist = playlistFlag(mode)
  if (input.kind === 'soundcloud_track') {
    return plan(input.url, playlist, MAX_COLLECTION_ENTRIES, 'track')
  }
  if (input.kind === 'youtube_channel' && input.channelRoot === true) {
    return listing(channelVideosUrl(input.url), playlist, MAX_COLLECTION_ENTRIES)
  }
  const isMix = input.kind === 'youtube_playlist' && input.collectionKind === 'mix'
  if (isMix && input.listId !== undefined) {
    // `playlist?list=RD…` fails with "This playlist type is unviewable" (youtube-mix-playlist-url.log).
    const seed = SEEDED_MIX.exec(input.listId)?.[1]
    if (seed !== undefined) {
      return listing(youtubeListUrl(input.listId, 'mix', seed), 'yes', MAX_MIX_ENTRIES)
    }
  }
  const url =
    input.embeddedList === true && input.listId !== undefined
      ? youtubeListUrl(input.listId, 'playlist')
      : input.url
  return listing(url, playlist, isMix ? MAX_MIX_ENTRIES : MAX_COLLECTION_ENTRIES)
}

/**
 * A mix generated from one video: `RD` + its 11-character id. Other mixes (`RDMM…`, `RDAMVM…`,
 * `RDEM…`) aren't seeded by a video id this way and stay as pasted.
 */
const SEEDED_MIX = /^RD([A-Za-z0-9_-]{11})$/

const plan = (
  url: string,
  playlist: 'yes' | 'no' | undefined,
  limit: number,
  expect: ResolvePlan['expect'],
): ResolvePlan => ({
  url,
  ...(playlist === undefined ? {} : { playlist }),
  limit,
  expect,
  timeoutMs: expect === 'track' ? TRACK_TIMEOUT_MS : COLLECTION_TIMEOUT_MS,
})

const single = (url: string): ResolvePlan => plan(url, 'no', MAX_COLLECTION_ENTRIES, 'track')

const listing = (url: string, playlist: 'yes' | 'no' | undefined, limit: number): ResolvePlan =>
  plan(url, playlist, limit, 'any')

function playlistFlag(mode: ResolveMode): 'yes' | 'no' | undefined {
  if (mode === 'track') return 'no'
  if (mode === 'collection') return 'yes'
  return undefined
}

function ambiguousKind(kind: ValidUrl['collectionKind']): AmbiguousListKind {
  return kind === 'mix' || kind === 'album' ? kind : 'playlist'
}

/** A mix is generated from its seed video, so its URL keeps `v=`; other lists stand alone. */
function youtubeListUrl(listId: string, kind: AmbiguousListKind, videoId?: string): string {
  if (kind === 'mix' && videoId !== undefined) {
    return `https://www.youtube.com/watch?${new URLSearchParams({ v: videoId, list: listId })}`
  }
  return `https://www.youtube.com/playlist?${new URLSearchParams({ list: listId })}`
}

/**
 * yt-dlp lists a channel root as nested tab playlists; its uploads are the /videos tab. The
 * `featured` tab counts as the root (classifyUrl marks it `channelRoot`), so it is replaced.
 */
function channelVideosUrl(url: string): string {
  const parsed = new URL(url)
  const channel = parsed.pathname.replace(/\/+$/, '').replace(/\/featured$/, '')
  return `${parsed.origin}${channel}/videos`
}
