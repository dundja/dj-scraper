// Resolve bodies for tests, parsed with the shared schemas so they can't drift from the contract.
// Shapes follow the server's normalizer (apps/server/src/engine/ytdlp-parse.ts) and its recorded
// fixtures: flat YouTube rows are `availability: 'unknown'` unless they are a placeholder such as
// "[Private video]", and SoundCloud set rows past the first few are `partial` (id + url only).
import {
  type Collection,
  type CollectionEntry,
  CollectionSchema,
  type EntryResult,
  EntryResultSchema,
  type ErrorInfo,
  type Platform,
  type ResolveResult,
  ResolveResultSchema,
  type Track,
  TrackSchema,
} from '@dj-scraper/shared'

type Ambiguous = Extract<ResolveResult, { kind: 'ambiguous' }>

/** URLs as a user would paste them, for the instant badge (`classifyUrl`) and request bodies. */
export const urls = {
  track: 'https://www.youtube.com/watch?v=XNEnEBrHws8',
  scTrack: 'https://soundcloud.com/excision/robokitty',
  playlist: 'https://www.youtube.com/playlist?list=PLdjscraperwarmupselection00000001',
  scSet: 'https://soundcloud.com/crate-diggers/sets/late-night-selects',
  /** `watch?v=…&list=…`: the server answers `ambiguous` in auto mode. */
  watchList: 'https://www.youtube.com/watch?v=gHKT4uU8Zng&list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  mix: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
  userSets: 'https://soundcloud.com/the-concept-band/sets',
  /** A DRM service: `classifyUrl` says `out_of_scope`, so the web shows that without resolving. */
  drm: 'https://music.apple.com/us/album/whenever-you-need-somebody/1558533900?i=1558534271',
  /** Spotify's links are track lists, their audio matched on YouTube (ADR-026). */
  spotifyTrack: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  spotifyAlbum: 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4',
  spotifyPlaylist: 'https://open.spotify.com/playlist/37i9dQZF1DX6J5NfMJS675',
  /** An artist page: `spotify_other`, refused like a DRM service, with Spotify's own words. */
  spotifyArtist: 'https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt',
} as const

/** A track with `changes` on top, validated against the contract. */
export function trackWith(changes: Partial<Track>, base: Track = track): Track {
  return TrackSchema.parse({ ...base, ...changes })
}

/** A collection with `changes` on top, validated against the contract. */
export function collectionWith(base: Collection, changes: Partial<Collection>): Collection {
  return CollectionSchema.parse({ ...base, ...changes })
}

/**
 * A YouTube Music track whose best audio is the AAC stream (format 140: yt-dlp reports 129.553
 * kbps for its nominal 128). Artist from the platform's metadata, uploader its Topic channel.
 */
export const track: Track = TrackSchema.parse({
  id: 'XNEnEBrHws8',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=XNEnEBrHws8',
  title: 'The Chill Zone',
  artist: 'Royalty Free Music',
  uploader: 'Royalty Free Music Crew',
  durationSec: 267,
  thumbnailUrl: 'https://i.ytimg.com/vi/XNEnEBrHws8/maxresdefault.jpg',
  availability: 'available',
  source: { codec: 'mp4a.40.2', bitrateKbps: 129.553 },
})

/** A SoundCloud track served as MP3 128 kbps (what an MP3 download keeps). */
export const scTrack: Track = TrackSchema.parse({
  id: '189341496',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/excision/robokitty',
  title: 'Robo Kitty',
  artist: 'Excision',
  uploader: 'Excision',
  durationSec: 245.316,
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000104942331-0yw4n9-original.jpg',
  availability: 'available',
  source: { codec: 'mp3', bitrateKbps: 128 },
})

/** A SoundCloud Go+ track: only a 30 s preview, so unavailable, with no source and no duration. */
export const previewTrack: Track = TrackSchema.parse({
  id: '75206121',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/the-concept-band/world-on-fire-1',
  title: 'World On Fire',
  artist: 'The Royal Concept',
  uploader: 'The Royal Concept',
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000039467711-5mc8re-original.jpg',
  availability: 'unavailable',
  unavailableReason: 'preview_only',
})

/** A video in a playlist, as `watch?v=…&list=…` resolves it (Opus source). */
const watchListTrack: Track = TrackSchema.parse({
  id: 'gHKT4uU8Zng',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=gHKT4uU8Zng',
  title: 'dlp test video title primary (en-GB)',
  uploader: 'cole-dlp-test-acc',
  durationSec: 5,
  thumbnailUrl: 'https://i.ytimg.com/vi/gHKT4uU8Zng/maxresdefault.jpg',
  availability: 'available',
  source: { codec: 'opus', bitrateKbps: 98.215 },
})

const mixSeed: Track = TrackSchema.parse({
  id: 'dQw4w9WgXcQ',
  platform: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up (Official Video) (4K Remaster)',
  artist: 'Rick Astley',
  uploader: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
  availability: 'available',
  source: { codec: 'opus', bitrateKbps: 128.93 },
})

const ambiguousWith = (fields: Omit<Ambiguous, 'kind'>): Ambiguous => {
  const result = ResolveResultSchema.parse({ kind: 'ambiguous', ...fields })
  if (result.kind !== 'ambiguous') throw new Error('unreachable')
  return result
}

/** `ambiguous` answers, one per list kind: "This track" or the whole playlist, album or mix. */
export const ambiguous = {
  playlist: ambiguousWith({
    track: watchListTrack,
    collectionUrl: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
    collectionKind: 'playlist',
  }),
  album: ambiguousWith({
    track,
    collectionUrl:
      'https://www.youtube.com/playlist?list=OLAK5uy_l1m0thk3g31NmIIz_vMIbWtyv7eZixlH0',
    collectionKind: 'album',
  }),
  /** The mix's URL keeps `v=`: listing it again with `mode: 'collection'` gives the first 50. */
  mix: ambiguousWith({ track: mixSeed, collectionUrl: urls.mix, collectionKind: 'mix' }),
}

/** An 11-character video id, distinct per `n`. */
const videoId = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(11 - prefix.length, '0')}`
const ytThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`

/** [artist (undefined: the title has no "Artist - "), title, duration] of the playlist's rows. */
const PLAYLIST_ROWS: [artist: string | undefined, title: string, durationSec: number][] = [
  ['Kollektiv Nord', 'Tidal Drift', 384],
  ['Mara Vey', 'Low Sun (Extended Mix)', 412],
  ['', '[Private video]', 0],
  ['Orbit Theory', 'Glasshouse', 365],
  ['Deep Season', 'Night Ferry (Original Mix)', 437],
  ['Lune Atelier', 'Copper Lines', 298],
  ['Halden & Rui', 'Slow Motion City', 356],
  [undefined, 'Sunset Session Mix 2026', 3721],
  ['Kollektiv Nord', 'Undertow', 402],
  ['Sable Coast', 'Afterglow (Dub)', 389],
  ['Mara Vey', 'Fold', 344],
  ['', '[Deleted video]', 0],
  ['Ilse Varga', 'Run Deep', 371],
  ['Tomas Brink', 'Weekday (Club Edit)', 333],
  ['Orbit Theory', 'Live at Dockside', 0],
  ['Pale Harbour', 'Static Bloom', 395],
  ['Deep Season', 'Lanterns', 421],
  ['Ono Ferreira', 'Água Viva', 352],
  ['Lune Atelier', 'Pressure Point', 377],
  ['Halden & Rui', 'Ferris', 340],
  // The same video again: a playlist may list one twice.
  ['Lune Atelier', 'Copper Lines', 298],
  ['Sable Coast', 'Shoreline', 408],
  ['Ilse Varga', 'Quiet Engine', 362],
  ['Tomas Brink', 'Late Bloomer', 349],
  ['Pale Harbour', 'Hollow Bay', 381],
  ['Kollektiv Nord', 'Breakwater', 415],
  ['Mara Vey', 'Signal (Reprise)', 297],
  ['Ono Ferreira', 'Sereno', 366],
  ['Deep Season', 'Harbour Lights', 428],
  ['Orbit Theory', 'Afterhours', 399],
]

/** Rows by index with something special about them. */
export const PLAYLIST_SPECIAL_ROWS = {
  /** `[Private video]`: unavailable, reason `private`, no uploader, duration or artwork. */
  privateVideo: 2,
  /** `[Deleted video]`: unavailable, reason `unavailable`. */
  deletedVideo: 11,
  /** No artist: only the uploader names who made it. */
  noArtist: 7,
  /** No duration (a past live stream). */
  noDuration: 14,
  /** The same video as row 5. */
  duplicateOf5: 20,
  /** No artwork. */
  noArtwork: 25,
} as const

const playlistEntry = (
  [artist, title, durationSec]: (typeof PLAYLIST_ROWS)[number],
  index: number,
): unknown => {
  const special = PLAYLIST_SPECIAL_ROWS
  const id = videoId('djRow', index === special.duplicateOf5 ? 5 : index)
  const base = { id, platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, title }
  if (index === special.privateVideo || index === special.deletedVideo) {
    const reason = index === special.privateVideo ? 'private' : 'unavailable'
    return { ...base, availability: 'unavailable', unavailableReason: reason, partial: false }
  }
  return {
    ...base,
    ...(artist === undefined ? {} : { artist }),
    uploader: artist ?? 'Lofi Garden',
    ...(index === special.noDuration ? {} : { durationSec }),
    ...(index === special.noArtwork ? {} : { thumbnailUrl: ytThumbnail(id) }),
    // Flat rows rarely say; a few listings do.
    availability: index % 4 === 0 ? 'available' : 'unknown',
    partial: false,
  }
}

/**
 * A YouTube playlist of 30 rows (trackCount 30): unknown and available rows, a `[Private video]`
 * and a `[Deleted video]`, a row without artist, one without duration, one without artwork and a
 * duplicate video (see PLAYLIST_SPECIAL_ROWS).
 */
export const playlist: Collection = CollectionSchema.parse({
  id: 'PLdjscraperwarmupselection00000001',
  platform: 'youtube',
  url: urls.playlist,
  kind: 'playlist',
  title: 'Warm-up Selection',
  owner: 'Crate Diggers',
  thumbnailUrl: ytThumbnail(videoId('djRow', 0)),
  trackCount: PLAYLIST_ROWS.length,
  truncated: false,
  entries: PLAYLIST_ROWS.map(playlistEntry),
})

/** The full tracks behind `scSet`'s rows, as `POST /api/resolve/entries` returns them. */
const SC_SET_TRACKS = [
  ['1501000001', 'night-shift', 'Night Shift', 'Kollektiv Nord', 402.311],
  ['1501000002', 'blue-hour', 'Blue Hour', 'Mara Vey', 367.88],
  ['1501000003', 'tram-lines', 'Tram Lines', 'Deep Season', 391.024],
  ['1501000004', 'velvet-static', 'Velvet Static', 'Orbit Theory', 355.5],
  ['1501000005', 'harbour-dub', 'Harbour Dub', 'Sable Coast', 428.193],
  ['1501000006', 'go-plus-exclusive', 'Go+ Exclusive', 'Lune Atelier', 341.72],
  ['1501000007', 'last-ferry', 'Last Ferry', 'Pale Harbour', 376.4],
  ['1501000008', 'daybreak', 'Daybreak', 'Ilse Varga', 410.007],
] as const

/** Index in `scSet` of the row whose track turns out to be a Go+ preview when enriched. */
export const SC_SET_PREVIEW_ROW = 5
/** Index in `scSet` of the row listed with an API URL instead of its page URL. */
export const SC_SET_API_URL_ROW = 7
/** How many of `scSet`'s first rows come with full data (not partial). */
export const SC_SET_FULL_ROWS = 2

const scPage = (slug: string) => `https://soundcloud.com/crate-diggers/${slug}`
const scArtwork = (id: string) => `https://i1.sndcdn.com/artworks-000${id}-abc123-original.jpg`

/**
 * Full Tracks for every row of `scSet`, in its order: MP3 128 or AAC 160 sources. The one at
 * SC_SET_PREVIEW_ROW is a Go+ preview: `unavailable`, reason `preview_only`, no source or duration.
 */
export const scSetTracks: Track[] = SC_SET_TRACKS.map(
  ([id, slug, title, artist, durationSec], index) =>
    TrackSchema.parse(
      index === SC_SET_PREVIEW_ROW
        ? {
            id,
            platform: 'soundcloud',
            url: scPage(slug),
            title,
            artist,
            uploader: artist,
            thumbnailUrl: scArtwork(id),
            availability: 'unavailable',
            unavailableReason: 'preview_only',
          }
        : {
            id,
            platform: 'soundcloud',
            url: scPage(slug),
            title,
            artist,
            uploader: artist,
            durationSec,
            thumbnailUrl: scArtwork(id),
            availability: 'available',
            source:
              index % 2 === 0
                ? { codec: 'mp3', bitrateKbps: 128 }
                : { codec: 'mp4a.40.2', bitrateKbps: 160 },
          },
    ),
)

/**
 * A SoundCloud set of 8 rows with the platform's total `durationSec`: the first SC_SET_FULL_ROWS
 * rows come complete, the rest are `partial` (id + url, `availability: 'unknown'`), and the row at
 * SC_SET_API_URL_ROW has an API URL. `scSetTracks` holds what enrichment returns for each row.
 */
export const scSet: Collection = CollectionSchema.parse({
  id: '1876543210',
  platform: 'soundcloud',
  url: urls.scSet,
  kind: 'set',
  title: 'Late Night Selects',
  owner: 'Crate Diggers',
  thumbnailUrl: 'https://i1.sndcdn.com/artworks-000187654321-xyz789-original.jpg',
  trackCount: SC_SET_TRACKS.length,
  durationSec: SC_SET_TRACKS.reduce((sum, row) => sum + row[4], 0),
  truncated: false,
  entries: scSetTracks.map((full, index): unknown => {
    if (index < SC_SET_FULL_ROWS) {
      const { source: _source, ...listed } = full
      return { ...listed, availability: 'unknown', partial: false }
    }
    const url =
      index === SC_SET_API_URL_ROW ? `https://api-v2.soundcloud.com/tracks/${full.id}` : full.url
    return { id: full.id, platform: 'soundcloud', url, availability: 'unknown', partial: true }
  }),
})

/** An `ok` row of `POST /api/resolve/entries`, keyed by the requested platform + id. */
export function entryOk(full: Track): EntryResult {
  return EntryResultSchema.parse({
    status: 'ok',
    platform: full.platform,
    id: full.id,
    track: full,
  })
}

/** An `error` row of `POST /api/resolve/entries`. */
export function entryError(row: { platform: Platform; id: string }, error: ErrorInfo): EntryResult {
  return EntryResultSchema.parse({ status: 'error', platform: row.platform, id: row.id, error })
}

const bigPlaylists = new Map<number, Collection>()

/**
 * A YouTube playlist of `n` rows (up to 5,000, the listing cap), for virtualization and selection
 * at scale: row i is "Artist <i mod 97> - Track <i + 1>", with a duration and artwork, availability
 * unknown. Parsed once per size and shared, so don't mutate it.
 */
export function bigPlaylist(n: number): Collection {
  const cached = bigPlaylists.get(n)
  if (cached !== undefined) return cached
  const entries: unknown[] = Array.from({ length: n }, (_, index) => {
    const id = videoId('big', index)
    return {
      id,
      platform: 'youtube',
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `Track ${index + 1}`,
      artist: `Artist ${index % 97}`,
      uploader: `Artist ${index % 97}`,
      durationSec: 120 + ((index * 37) % 400),
      thumbnailUrl: ytThumbnail(id),
      availability: 'unknown',
      partial: false,
    }
  })
  const collection = CollectionSchema.parse({
    id: `PLbig${String(n).padStart(30, '0')}`,
    platform: 'youtube',
    url: `https://www.youtube.com/playlist?list=PLbig${String(n).padStart(30, '0')}`,
    kind: 'playlist',
    title: `Big playlist (${n})`,
    owner: 'Crate Diggers',
    trackCount: n,
    truncated: false,
    entries,
  })
  bigPlaylists.set(n, collection)
  return collection
}

/** The four sets on The Royal Concept's SoundCloud Sets tab (recorded 2026-10). */
const ROYAL_CONCEPT_SETS = [
  {
    url: 'https://soundcloud.com/the-concept-band/sets/goldrushed-2013-album',
    title: 'Goldrushed [2013 Album]',
  },
  { url: 'https://soundcloud.com/the-concept-band/sets/royal-ep', title: 'Royal EP' },
  {
    url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
    title: 'The Royal Concept EP',
  },
  { url: 'https://soundcloud.com/the-concept-band/sets/the-concept-1', title: 'The Royal Concept' },
]

/**
 * A SoundCloud user's Sets tab: no tracks (`entries: []`), only the four sets it lists, as `lists`
 * (each to resolve on its own) and `skippedEntries: 4`.
 */
export const userPageWithLists: Collection = CollectionSchema.parse({
  id: '9518724',
  platform: 'soundcloud',
  url: urls.userSets,
  kind: 'channel',
  title: 'The Royal Concept (Sets)',
  owner: 'The Royal Concept',
  truncated: false,
  skippedEntries: ROYAL_CONCEPT_SETS.length,
  lists: ROYAL_CONCEPT_SETS,
  entries: [],
})

/**
 * A SoundCloud user page (All) with three tracks and, among its rows, one set (`lists`) plus one
 * more row that isn't a track and has no URL: `skippedEntries` (2) counts both.
 */
export const userPage: Collection = CollectionSchema.parse({
  id: '9518724',
  platform: 'soundcloud',
  url: 'https://soundcloud.com/the-concept-band',
  kind: 'channel',
  title: 'The Royal Concept (All)',
  owner: 'The Royal Concept',
  truncated: false,
  skippedEntries: 2,
  lists: ROYAL_CONCEPT_SETS.slice(1, 2),
  entries: scSetTracks.slice(0, 3).map(({ source: _source, ...listed }) => ({
    ...listed,
    availability: 'unknown',
    partial: false,
  })),
})

// Spotify (ADR-026): the server reads names, durations and covers from Spotify's embed page. Rows
// are never partial, no row has a `source` (its audio is unknown until a download matches it on
// YouTube), and a list has no `trackCount`: the page lists at most 100 rows and never says more.

/**
 * Rick Astley's "Never Gonna Give You Up" as Spotify's embed page has it (recorded 2026-10): the
 * album's cover, the duration to the millisecond, no source.
 */
export const spotifyTrack: Track = TrackSchema.parse({
  id: '4uLU6hMCjMI75M1A2tKUQC',
  platform: 'spotify',
  url: urls.spotifyTrack,
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  durationSec: 213.573,
  thumbnailUrl:
    'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273255e131abc1410833be95673',
  availability: 'available',
})

/** A 22-character Spotify id, distinct per `n`. */
const spotifyId = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(22 - prefix.length, '0')}`

/** [artists joined with ", ", title, duration] of the Spotify playlist's rows. */
const SPOTIFY_PLAYLIST_ROWS: [artist: string, title: string, durationSec: number][] = [
  ['Kollektiv Nord', 'Tidal Drift', 384.12],
  ['Mara Vey, Orbit Theory', 'Low Sun', 412.5],
  ['Deep Season', 'Night Ferry', 437.861],
  ['Lune Atelier', 'Copper Lines', 298.04],
  ['Halden & Rui', 'Slow Motion City', 356.333],
]

const spotifyRow = (id: string, artist: string, title: string, durationSec: number): unknown => ({
  id,
  platform: 'spotify',
  url: `https://open.spotify.com/track/${id}`,
  title,
  artist,
  durationSec,
  availability: 'available',
  partial: false,
})

/**
 * A Spotify playlist of 5 rows with a curator as owner. A playlist's rows have no artwork on the
 * embed page, and one podcast episode on it is skipped (`skippedEntries`).
 */
export const spotifyPlaylist: Collection = CollectionSchema.parse({
  id: '37i9dQZF1DX6J5NfMJS675',
  platform: 'spotify',
  url: urls.spotifyPlaylist,
  kind: 'playlist',
  title: 'Deep House Warm-up',
  owner: 'Crate Diggers',
  thumbnailUrl: 'https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84djscraperwarmup0001',
  truncated: false,
  skippedEntries: 1,
  entries: SPOTIFY_PLAYLIST_ROWS.map(([artist, title, durationSec], index) =>
    spotifyRow(spotifyId('djSpot', index), artist, title, durationSec),
  ),
})

/** The most rows Spotify's embed page lists: a list that long is `truncated`. */
export const SPOTIFY_LIST_ROWS = 100

/** A Spotify playlist cut at the embed page's 100 rows: `truncated`, no `trackCount`. */
export const spotifyBigPlaylist: Collection = CollectionSchema.parse({
  id: '37i9dQZF1DXa8NOEUWPn9W',
  platform: 'spotify',
  url: 'https://open.spotify.com/playlist/37i9dQZF1DXa8NOEUWPn9W',
  kind: 'playlist',
  title: 'Housewerk',
  owner: 'Spotify',
  thumbnailUrl: 'https://image-cdn-ak.spotifycdn.com/image/ab67706f00000002djscraperhousewerk',
  truncated: true,
  entries: Array.from({ length: SPOTIFY_LIST_ROWS }, (_, index) =>
    spotifyRow(
      spotifyId('djBig', index),
      `Artist ${index % 23}`,
      `Track ${index + 1}`,
      180 + ((index * 41) % 300) + 0.25,
    ),
  ),
})

/**
 * Three Spotify tracks as their embed pages give them (recorded 2026-10): what
 * `POST /api/resolve/entries` fills `pastedLinks`' rows with, in its order.
 */
export const pastedTracks: Track[] = [
  spotifyTrack,
  TrackSchema.parse({
    id: '6aiKIFjPwa3UvDCD5ecoJj',
    platform: 'spotify',
    url: 'https://open.spotify.com/track/6aiKIFjPwa3UvDCD5ecoJj',
    title: 'Whenever You Need Somebody',
    artist: 'Rick Astley',
    durationSec: 233.666,
    thumbnailUrl: spotifyTrack.thumbnailUrl,
    availability: 'available',
  }),
  TrackSchema.parse({
    id: '76QJgXPE3oc1cnkE4PFHEn',
    platform: 'spotify',
    url: 'https://open.spotify.com/track/76QJgXPE3oc1cnkE4PFHEn',
    title: 'Together Forever',
    artist: 'Rick Astley',
    durationSec: 205.533,
    thumbnailUrl: spotifyTrack.thumbnailUrl,
    availability: 'available',
  }),
]

/** `pastedTracks`' links, one per line, as the Spotify app copies a selection of tracks (⌘A, ⌘C). */
export const pastedLinksText = pastedTracks.map((full) => full.url).join('\n')

/**
 * What `POST /api/resolve/links` answers for `pastedLinksText`: a `links` collection whose rows are
 * partial (id + url, `availability: 'unknown'`) in paste order, filled in from each track's embed
 * page as they come into view. Its `url` is the first track's: no page holds the list.
 */
export const pastedLinks: Collection = CollectionSchema.parse({
  id: `links-${spotifyTrack.id}`,
  platform: 'spotify',
  url: spotifyTrack.url,
  kind: 'links',
  title: 'Pasted Spotify tracks',
  truncated: false,
  entries: pastedTracks.map(({ id, url }) => ({
    id,
    platform: 'spotify',
    url,
    availability: 'unknown',
    partial: true,
  })),
})

/** `{ kind: 'track' }`, the answer to a single track's URL. */
export function trackResult(resolved: Track = track): ResolveResult {
  return ResolveResultSchema.parse({ kind: 'track', track: resolved })
}

/** `{ kind: 'collection' }`, the answer to a list's URL. */
export function collectionResult(collection: Collection): ResolveResult {
  return ResolveResultSchema.parse({ kind: 'collection', collection })
}

/** The rows of a collection that can be selected (not `unavailable`), in order. */
export function selectableEntries(collection: Collection): CollectionEntry[] {
  return collection.entries.filter((entry) => entry.availability !== 'unavailable')
}
