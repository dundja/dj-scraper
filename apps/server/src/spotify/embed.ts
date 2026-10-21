import {
  type Collection,
  type CollectionEntry,
  CollectionEntrySchema,
  CollectionSchema,
  HttpUrlSchema,
  MAX_SPOTIFY_ENTRIES,
  MAX_URL_LENGTH,
  spotifyUrl,
  type Track,
  TrackSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import * as z from 'zod'
import { lenient, omitUndefined } from '../util/fields.ts'

/**
 * Pure: Spotify's embed player page → our Track / Collection (ADR-026). The embed page
 * (`open.spotify.com/embed/<type>/<id>`) needs no sign-in and carries the track, album or playlist
 * as JSON in its `__NEXT_DATA__` script. Only `props.pageProps.state.data.entity` is read: the page
 * also holds an anonymous access token, which is never used, kept or logged. The page is distrusted
 * like yt-dlp's JSON: tolerant schemas, and values the contract would reject are dropped.
 */

/** The embed player lists at most this many rows of a playlist or album. */
export const SPOTIFY_EMBED_LIMIT = MAX_SPOTIFY_ENTRIES

/** The page isn't the embed page we know (no data script, unreadable JSON, an unknown entity). */
export class EmbedParseError extends Error {
  override name = 'EmbedParseError'
}

/** `/embed/<type>/<id>`: the path of a classified Spotify track, album or playlist's embed page. */
export function embedPath(input: ValidUrl): string {
  if (input.spotifyId === undefined) throw new RangeError(`${input.kind} has no Spotify id`)
  const canonical = new URL(spotifyUrl(input.kind, input.spotifyId))
  return `/embed${canonical.pathname}`
}

/** A Spotify track, as the download needs it: the names to search YouTube with and to tag. */
export type SpotifyTrack = {
  id: string
  title: string
  /** In Spotify's order, the main artist first. */
  artists: string[]
  durationSec?: number
  releaseYear?: number
  /** The largest cover the page offers (640 px for an album's). */
  coverUrl?: string
}

export type SpotifyEntity =
  | { type: 'track'; track: SpotifyTrack }
  | {
      type: 'album' | 'playlist'
      id: string
      title: string
      /** A playlist's curator or an album's artists, as the page's subtitle says. */
      owner?: string
      coverUrl?: string
      rows: SpotifyRow[]
      /** Rows that aren't tracks (podcast episodes in a playlist). */
      skipped: number
      /** Every row the page listed, repeats included: `SPOTIFY_EMBED_LIMIT` means there may be more. */
      listed: number
    }

/** A row of an album or playlist: its artists come as one display string. */
export type SpotifyRow = {
  id: string
  title: string
  artist?: string
  durationSec?: number
}

/** Trimmed, non-empty text; Spotify separates artists with `, `, which becomes `, `. */
const Text = lenient(
  z
    .string()
    .transform((value) => value.replace(/\u00a0/g, ' ').trim())
    .pipe(z.string().min(1)),
)
const Url = lenient(HttpUrlSchema.max(MAX_URL_LENGTH))
const Id = lenient(z.string().regex(/^[A-Za-z0-9]{22}$/))
/** Spotify's durations are milliseconds. */
const Millis = lenient(z.number().positive())

const ImageSchema = z.looseObject({ url: Url, maxWidth: lenient(z.number()) })
const VisualIdentitySchema = z.looseObject({ image: lenient(z.array(lenient(ImageSchema))) })
const CoverArtSchema = z.looseObject({
  sources: lenient(z.array(lenient(z.looseObject({ url: Url, width: lenient(z.number()) })))),
})

const TrackEntitySchema = z.looseObject({
  type: z.literal('track'),
  id: Id,
  name: Text,
  title: Text,
  artists: lenient(z.array(lenient(z.looseObject({ name: Text })))),
  duration: Millis,
  releaseDate: lenient(z.looseObject({ isoString: Text })),
  visualIdentity: lenient(VisualIdentitySchema),
})

const RowSchema = z.looseObject({
  uri: Text,
  title: Text,
  subtitle: Text,
  duration: Millis,
  entityType: Text,
})

const ListEntitySchema = z.looseObject({
  type: z.enum(['album', 'playlist']),
  id: Id,
  name: Text,
  title: Text,
  subtitle: Text,
  coverArt: lenient(CoverArtSchema),
  visualIdentity: lenient(VisualIdentitySchema),
  trackList: lenient(z.array(z.unknown())),
})

const NEXT_DATA = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/

/** Reads the entity from an embed page's HTML. Error messages never quote the page. */
export function parseEmbedPage(html: string): SpotifyEntity {
  const script = NEXT_DATA.exec(html)?.[1]
  if (script === undefined) throw new EmbedParseError('the page has no __NEXT_DATA__ script')
  let data: unknown
  try {
    data = JSON.parse(script)
  } catch {
    throw new EmbedParseError(`__NEXT_DATA__ is not JSON (${script.length} characters)`)
  }
  return readEntity(entityOf(data))
}

/** `props.pageProps.state.data.entity`, and nothing else of the page's state. */
function entityOf(data: unknown): unknown {
  let value = data
  for (const key of ['props', 'pageProps', 'state', 'data', 'entity']) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
      throw new EmbedParseError(`the page's data has no ${key}`)
    }
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function readEntity(entity: unknown): SpotifyEntity {
  const track = TrackEntitySchema.safeParse(entity)
  if (track.success) return { type: 'track', track: readTrack(track.data) }
  const list = ListEntitySchema.safeParse(entity)
  if (!list.success) throw new EmbedParseError('the entity is not a track, album or playlist')
  const { id, type } = list.data
  const title = list.data.name ?? list.data.title
  if (id === undefined || title === undefined) {
    throw new EmbedParseError(`the ${type} has no id or title`)
  }
  const listed = list.data.trackList ?? []
  const rows: SpotifyRow[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const raw of listed) {
    const row = readRow(raw)
    if (row === undefined) {
      skipped++
      continue
    }
    // A playlist may hold a track twice; a collection lists each track once.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  const coverUrl =
    largestImage(list.data.visualIdentity?.image) ??
    list.data.coverArt?.sources?.find((source) => source?.url !== undefined)?.url
  return {
    type,
    id,
    title,
    ...omitUndefined({ owner: list.data.subtitle, coverUrl }),
    rows,
    skipped,
    listed: listed.length,
  }
}

function readTrack(entity: z.output<typeof TrackEntitySchema>): SpotifyTrack {
  const title = entity.name ?? entity.title
  if (entity.id === undefined || title === undefined) {
    throw new EmbedParseError('the track has no id or title')
  }
  const artists = (entity.artists ?? []).flatMap((artist) =>
    artist?.name === undefined ? [] : [artist.name],
  )
  return {
    id: entity.id,
    title,
    artists,
    ...omitUndefined({
      durationSec: seconds(entity.duration),
      releaseYear: yearOf(entity.releaseDate?.isoString),
      coverUrl: largestImage(entity.visualIdentity?.image),
    }),
  }
}

/** A track row, or undefined for anything else (an episode, a row without an id or title). */
function readRow(raw: unknown): SpotifyRow | undefined {
  const parsed = RowSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const { uri, title, subtitle, duration, entityType } = parsed.data
  if (entityType !== undefined && entityType !== 'track') return undefined
  const id = uri === undefined ? undefined : TRACK_URI.exec(uri)?.[1]
  if (id === undefined || title === undefined) return undefined
  return { id, title, ...omitUndefined({ artist: subtitle, durationSec: seconds(duration) }) }
}

function largestImage(
  images: ReadonlyArray<z.output<typeof ImageSchema> | undefined> | undefined,
): string | undefined {
  let best: { url: string; width: number } | undefined
  for (const image of images ?? []) {
    if (image?.url === undefined) continue
    const width = image.maxWidth ?? 0
    if (best === undefined || width > best.width) best = { url: image.url, width }
  }
  return best?.url
}

const seconds = (ms: number | undefined): number | undefined =>
  ms === undefined ? undefined : Math.round(ms) / 1000

function yearOf(iso: string | undefined): number | undefined {
  const year = Number(iso?.slice(0, 4))
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : undefined
}

export type EmbedResult =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }

/**
 * The entity as our contract has it. Rows are complete (never `partial`): the page names every
 * row's title, artists and duration. Their audio is unknown (no `source`) until a download matches
 * it on YouTube. An album's rows show its cover; a playlist's rows have none on the page. A row
 * the contract refuses is left out and counted in `skippedEntries`; a track or list it refuses
 * throws `EmbedParseError`.
 */
export function toResolveResult(entity: SpotifyEntity): EmbedResult {
  if (entity.type === 'track') {
    const { track } = entity
    const parsed = TrackSchema.safeParse({
      id: track.id,
      platform: 'spotify',
      url: spotifyUrl('spotify_track', track.id),
      title: track.title,
      availability: 'available',
      ...omitUndefined({
        artist: track.artists.length > 0 ? track.artists.join(', ') : undefined,
        durationSec: track.durationSec,
        thumbnailUrl: track.coverUrl,
      }),
    })
    if (!parsed.success) throw new EmbedParseError("the track doesn't fit the contract")
    return { kind: 'track', track: parsed.data }
  }
  const rowCover = entity.type === 'album' ? entity.coverUrl : undefined
  let refused = 0
  const entries = entity.rows.flatMap((row): CollectionEntry[] => {
    const parsed = CollectionEntrySchema.safeParse({
      partial: false,
      id: row.id,
      platform: 'spotify',
      url: spotifyUrl('spotify_track', row.id),
      title: row.title,
      availability: 'available',
      ...omitUndefined({
        artist: row.artist,
        durationSec: row.durationSec,
        thumbnailUrl: rowCover,
      }),
    })
    if (parsed.success) return [parsed.data]
    refused++
    return []
  })
  const kind = entity.type
  const skipped = entity.skipped + refused
  const collection = CollectionSchema.safeParse({
    id: entity.id,
    platform: 'spotify',
    url: spotifyUrl(kind === 'album' ? 'spotify_album' : 'spotify_playlist', entity.id),
    kind,
    title: entity.title,
    // The page lists at most SPOTIFY_EMBED_LIMIT rows and never says how many there are.
    truncated: entity.listed >= SPOTIFY_EMBED_LIMIT,
    ...omitUndefined({
      owner: entity.owner,
      thumbnailUrl: entity.coverUrl,
      skippedEntries: skipped > 0 ? skipped : undefined,
    }),
    entries,
  })
  if (!collection.success) throw new EmbedParseError(`the ${kind} doesn't fit the contract`)
  return { kind: 'collection', collection: collection.data }
}
