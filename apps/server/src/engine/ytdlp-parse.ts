import {
  type AudioSource,
  type Availability,
  type Collection,
  type CollectionEntry,
  CollectionEntrySchema,
  type CollectionKind,
  CollectionSchema,
  classifyUrl,
  HttpUrlSchema,
  isYoutubeChannelId,
  MAX_URL_LENGTH,
  type Platform,
  splitArtistTitle,
  type Track,
  TrackSchema,
  type UnavailableReason,
  type ValidUrl,
  youtubeListKind,
} from '@dj-scraper/shared'
import * as z from 'zod'

/**
 * Pure: yt-dlp `-J` info JSON → our Track / Collection. yt-dlp's JSON is distrusted: it is read
 * with tolerant schemas (almost everything optional), and values the contract would reject
 * (empty strings, nulls, non-http URLs, placeholder thumbnails) are dropped, not fatal.
 */

export type NormalizeContext = {
  /** The classified URL that was resolved: a fallback for platform and collection kind. */
  input: ValidUrl
  /** The listing cap. The listing was requested with `-I 1:<limit + 1>`, so a longer list is truncated. */
  limit: number
}

export type Normalized =
  | { kind: 'track'; track: Track }
  | { kind: 'collection'; collection: Collection }

/** The JSON can't become a Track or Collection (not an object, no id, an unknown `_type`, …). */
export class InfoParseError extends Error {
  override name = 'InfoParseError'
}

/** Extractors change their fields over time: a missing, null or wrongly typed value is just absent. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

/** Trimmed, non-empty text: the contract rejects `''`. */
const Text = lenient(z.string().trim().min(1))
/** SoundCloud ids are numeric strings, but a number from a future extractor must not drop the row. */
const Id = lenient(z.union([z.string().trim().min(1), z.int().nonnegative().transform(String)]))
/** Only http(s): a `javascript:` or `file:` URL from a page must never reach the UI. */
const Url = lenient(HttpUrlSchema.max(MAX_URL_LENGTH))
const Seconds = lenient(z.number().nonnegative())
const Kbps = lenient(z.number().positive())

const ThumbnailSchema = z.looseObject({
  url: Url,
  width: lenient(z.number()),
  height: lenient(z.number()),
  preference: lenient(z.number()),
})

const FormatSchema = z.looseObject({
  format_id: Text,
  vcodec: Text,
  acodec: Text,
  abr: Kbps,
  tbr: Kbps,
  has_drm: lenient(z.boolean()),
})
type Format = z.output<typeof FormatSchema>

/** A flat listing row; also the track fields of a full info document. */
const RowSchema = z.looseObject({
  _type: Text,
  ie_key: Text,
  id: Id,
  url: Url,
  webpage_url: Url,
  title: Text,
  track: Text,
  artist: Text,
  artists: lenient(z.array(Text)),
  uploader: Text,
  channel: Text,
  duration: Seconds,
  thumbnail: Url,
  thumbnails: lenient(z.array(lenient(ThumbnailSchema))),
  availability: Text,
  live_status: Text,
})
type Row = z.output<typeof RowSchema>

const InfoSchema = RowSchema.extend({
  extractor_key: Text,
  original_url: Url,
  format_id: Text,
  formats: lenient(z.array(lenient(FormatSchema))),
  playlist_count: lenient(z.int().nonnegative()),
  entries: lenient(z.array(z.unknown())),
})
type Info = z.output<typeof InfoSchema>

type Status = { availability: Availability; unavailableReason?: UnavailableReason }

/** Flat YouTube rows of videos the listing can't show; real titles can start with `[` too. */
const YOUTUBE_PLACEHOLDER_TITLES: ReadonlyMap<string, UnavailableReason> = new Map([
  ['[Private video]', 'private'],
  ['[Deleted video]', 'unavailable'],
])
/** yt-dlp `availability` values that need an account (or a paid one). */
const LOGIN_AVAILABILITY = new Set(['needs_auth', 'subscriber_only', 'premium_only'])
/** A live stream or premiere has no finished audio to download yet. */
const NOT_YET_DOWNLOADABLE = new Set(['is_live', 'is_upcoming'])
/** Stand-in images, worse than no artwork in a DJ's library. */
const PLACEHOLDER_THUMBNAILS = [
  /^https?:\/\/i\.ytimg\.com\/img\/no_thumbnail\.jpg(?:[?#]|$)/,
  /^https?:\/\/a\d*\.sndcdn\.com\/images\/default_avatar_\w+\.(?:png|jpg)(?:[?#]|$)/,
]
/** SoundCloud's original file: only for a logged-in user, and only when the uploader allows it. */
const SOUNDCLOUD_ORIGINAL_FORMAT = 'download'

/** `yt-dlp -J --flat-playlist …` output → a track or a collection. Throws `InfoParseError`. */
export function normalizeInfo(info: unknown, context: NormalizeContext): Normalized {
  const { limit } = context
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`)
  }
  const parsed = parseInfo(info)
  if (isTrackInfo(parsed)) return { kind: 'track', track: toTrack(parsed, context.input) }
  if (parsed._type === 'playlist' || parsed._type === 'multi_video') {
    return { kind: 'collection', collection: toCollection(parsed, context) }
  }
  throw new InfoParseError(`unexpected _type ${describeType(parsed._type)}`)
}

/**
 * `yt-dlp -J --no-playlist -- <entry url>` output → a full Track, for `POST /api/resolve/entries`.
 * Throws `InfoParseError` when the JSON isn't a single track.
 */
export function normalizeEntry(info: unknown, input: ValidUrl): Track {
  const parsed = parseInfo(info)
  if (!isTrackInfo(parsed)) {
    throw new InfoParseError(`expected a single track, got _type ${describeType(parsed._type)}`)
  }
  return toTrack(parsed, input)
}

function parseInfo(info: unknown): Info {
  const parsed = InfoSchema.safeParse(info)
  if (!parsed.success) throw new InfoParseError('info JSON is not an object')
  return parsed.data
}

/** `_type` is `video` since 2023; older output marks a track only by having formats. */
function isTrackInfo(info: Info): boolean {
  return info._type === 'video' || (info._type === undefined && info.formats !== undefined)
}

/** Short and value-free enough for a log line. */
function describeType(type: string | undefined): string {
  return type === undefined ? '(none)' : JSON.stringify(type.slice(0, 40))
}

function toTrack(info: Info, input: ValidUrl): Track {
  const { id } = info
  if (id === undefined) throw new InfoParseError('track has no id')
  const platform = platformOf(info.extractor_key, input.platform)
  const { title, artist } = artistAndTitle(info, platform)
  if (title === undefined) throw new InfoParseError('track has no title')
  const status = trackStatus(info)
  const candidate = omitUndefined({
    id,
    platform,
    url: info.webpage_url ?? info.original_url ?? input.url,
    title,
    artist,
    uploader: info.uploader ?? info.channel,
    // A Go+ preview reports the 30 s snippet, not the track's length.
    durationSec: status.unavailableReason === 'preview_only' ? undefined : info.duration,
    thumbnailUrl: bestThumbnail(info),
    ...status,
    source: audioSource(info.formats ?? [], platform),
  })
  const checked = TrackSchema.safeParse(candidate)
  if (!checked.success) {
    throw new InfoParseError(`track off contract: ${describeIssues(checked.error)}`)
  }
  return checked.data
}

/**
 * What the listing says about each row. Rows past `limit`, rows that aren't tracks (sets on a
 * SoundCloud user page, playlists on a channel tab) and rows without an id or usable URL are left
 * out; repeats of a platform + id keep the first row.
 */
function toCollection(info: Info, { input, limit }: NormalizeContext): Collection {
  const { id } = info
  if (id === undefined) throw new InfoParseError('collection has no id')
  const platform = platformOf(info.extractor_key, input.platform)
  const kind = collectionKind(info, input, platform, id)
  const owner = info.uploader ?? info.channel
  // A channel tab lists only that channel's uploads, but its flat rows don't name the channel.
  const rowContext: RowContext = {
    platform,
    fallbackUploader: platform === 'youtube' && kind === 'channel' ? owner : undefined,
  }

  const rows = info.entries ?? []
  let skipped = 0
  let notTracks = 0
  const seen = new Set<string>()
  const entries: CollectionEntry[] = []
  for (const raw of rows.slice(0, limit)) {
    const entry = toEntry(raw, rowContext)
    if (entry === NOT_A_TRACK) notTracks++
    if (typeof entry === 'string') {
      skipped++
      continue
    }
    const key = `${entry.platform}:${entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }

  const candidate = omitUndefined({
    id,
    platform,
    url: info.webpage_url ?? info.original_url ?? input.url,
    kind,
    title: info.title ?? id,
    owner,
    thumbnailUrl: bestThumbnail(info),
    // yt-dlp reports the platform's count (YouTube playlists, SoundCloud sets), or the row count
    // when the listing ran out under the cap; null when capped. Rows that aren't tracks inflate it.
    trackCount: notTracks === 0 ? info.playlist_count : undefined,
    durationSec: info.duration,
    truncated: rows.length > limit,
    skippedEntries: skipped > 0 ? skipped : undefined,
    entries,
  })
  const checked = CollectionSchema.safeParse(candidate)
  if (!checked.success) {
    throw new InfoParseError(`collection off contract: ${describeIssues(checked.error)}`)
  }
  return checked.data
}

type RowContext = { platform: Platform; fallbackUploader: string | undefined }

const NOT_A_TRACK = 'not_a_track'
const UNUSABLE = 'unusable'

function toEntry(
  raw: unknown,
  context: RowContext,
): CollectionEntry | typeof NOT_A_TRACK | typeof UNUSABLE {
  const parsed = RowSchema.safeParse(raw)
  if (!parsed.success) return UNUSABLE
  const row = parsed.data
  if (!isTrackRow(row, context.platform)) return NOT_A_TRACK

  const { id } = row
  const url = row.url ?? row.webpage_url
  if (id === undefined || url === undefined) return UNUSABLE
  const platform = platformOf(row.ie_key, context.platform)
  const { title, artist } = artistAndTitle(row, platform)
  const candidate = omitUndefined({
    id,
    platform,
    url,
    title,
    artist,
    uploader: row.uploader ?? row.channel ?? context.fallbackUploader,
    durationSec: row.duration,
    thumbnailUrl: bestThumbnail(row),
    ...rowStatus(row, platform),
    // ADR-008: a per-track lookup can fill in what the listing lacks.
    partial: title === undefined || (platform === 'soundcloud' && row.duration === undefined),
  })
  const checked = CollectionEntrySchema.safeParse(candidate)
  return checked.success ? checked.data : UNUSABLE
}

/**
 * Track rows only. SoundCloud user pages list sets with the `ie_key` key absent, YouTube channel
 * tabs list playlists as `YoutubeTab` rows, and a channel root nests whole tab playlists.
 */
function isTrackRow(row: Row, collectionPlatform: Platform): boolean {
  if (row._type === 'playlist' || row._type === 'multi_video') return false
  const key = row.ie_key
  if (key === undefined) {
    if (collectionPlatform === 'soundcloud') return false
    const url = row.url ?? row.webpage_url
    if (url === undefined) return true
    const classified = classifyUrl(url)
    return !(classified.ok && classified.guess === 'collection')
  }
  if (key.startsWith('Youtube')) return key === 'Youtube'
  if (key.startsWith('Soundcloud')) return key === 'Soundcloud'
  return true
}

/** yt-dlp's extractor key names the site; without one, trust the URL we classified. */
function platformOf(extractorKey: string | undefined, fallback: Platform): Platform {
  if (extractorKey === undefined) return fallback
  if (extractorKey.startsWith('Youtube')) return 'youtube'
  if (extractorKey.startsWith('Soundcloud')) return 'soundcloud'
  return 'other'
}

/**
 * Platform metadata first (`track`, `artist`/`artists`); otherwise "Artist - Title" is split at
 * its first dash. YouTube's placeholder titles stay whole.
 */
function artistAndTitle(row: Row, platform: Platform): { title?: string; artist?: string } {
  const title = row.track ?? row.title
  const artist = row.artist ?? row.artists?.find((name) => name !== undefined)
  if (artist !== undefined || title === undefined) return { title, artist }
  if (platform === 'youtube' && YOUTUBE_PLACEHOLDER_TITLES.has(title)) return { title }
  return splitArtistTitle(title) ?? { title }
}

/**
 * A full extraction succeeded, so the track is available unless it's live or upcoming, or
 * SoundCloud only serves its 30 s Go+ preview to us.
 */
function trackStatus(info: Info): Status {
  if (info.live_status !== undefined && NOT_YET_DOWNLOADABLE.has(info.live_status)) {
    return unavailable('unavailable')
  }
  if (isPreviewOnly(info)) return unavailable('preview_only')
  return { availability: 'available' }
}

/** Flat rows don't say whether they download; only the signs that they won't count. */
function rowStatus(row: Row, platform: Platform): Status {
  const placeholder =
    platform === 'youtube' && row.title !== undefined
      ? YOUTUBE_PLACEHOLDER_TITLES.get(row.title)
      : undefined
  if (placeholder !== undefined) return unavailable(placeholder)
  if (row.availability === 'private') return unavailable('private')
  if (row.availability !== undefined && LOGIN_AVAILABILITY.has(row.availability)) {
    return unavailable('login_required')
  }
  if (row.live_status !== undefined && NOT_YET_DOWNLOADABLE.has(row.live_status)) {
    return unavailable('unavailable')
  }
  return { availability: 'unknown' }
}

const unavailable = (unavailableReason: UnavailableReason): Status => ({
  availability: 'unavailable',
  unavailableReason,
})

/** Go+ previews are `<protocol>_<preset>_preview` formats; yt-dlp still picks one when it's all there is. */
const isPreview = (format: Format) => format.format_id?.includes('preview') === true

function isPreviewOnly(info: Info): boolean {
  const audio = (info.formats ?? []).filter(
    (format): format is Format => format !== undefined && format.acodec !== 'none',
  )
  if (audio.length > 0) return audio.every(isPreview)
  return info.format_id?.includes('preview') === true
}

/**
 * The stream behind `-f ba`: yt-dlp sorts formats worst → best, so the last audio-only one, minus
 * previews, DRM and SoundCloud's login-only original. Its codec and bitrate as reported, or
 * nothing: never more quality than the stream has.
 */
function audioSource(formats: (Format | undefined)[], platform: Platform): AudioSource | undefined {
  for (let index = formats.length - 1; index >= 0; index--) {
    const format = formats[index]
    if (format === undefined || format.vcodec !== 'none') continue
    if (format.acodec === undefined || format.acodec === 'none') continue
    if (isPreview(format) || format.has_drm === true) continue
    if (platform === 'soundcloud' && format.format_id === SOUNDCLOUD_ORIGINAL_FORMAT) continue
    return omitUndefined({ codec: format.acodec, bitrateKbps: format.abr ?? format.tbr })
  }
  return undefined
}

/**
 * yt-dlp's own pick (`thumbnail`), else the best of `thumbnails` ranked the way yt-dlp ranks them:
 * preference, then width, then height, a later entry winning a tie. Placeholders don't count.
 */
function bestThumbnail(row: Row): string | undefined {
  if (row.thumbnail !== undefined && !isPlaceholder(row.thumbnail)) return row.thumbnail
  let best: { url: string; rank: number[] } | undefined
  for (const thumbnail of row.thumbnails ?? []) {
    if (thumbnail === undefined || thumbnail.url === undefined || isPlaceholder(thumbnail.url)) {
      continue
    }
    const rank = [thumbnail.preference ?? -1, thumbnail.width ?? -1, thumbnail.height ?? -1]
    if (best === undefined || compareRanks(rank, best.rank) >= 0)
      best = { url: thumbnail.url, rank }
  }
  return best?.url
}

const isPlaceholder = (url: string) => PLACEHOLDER_THUMBNAILS.some((pattern) => pattern.test(url))

function compareRanks(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The classified input knows best (it is what the user pasted); otherwise the resolved URL, the
 * extractor and the list id tell.
 */
function collectionKind(
  info: Info,
  input: ValidUrl,
  platform: Platform,
  id: string,
): CollectionKind {
  if (input.collectionKind !== undefined) return input.collectionKind
  for (const url of [info.webpage_url, info.original_url]) {
    if (url === undefined) continue
    const classified = classifyUrl(url)
    if (classified.ok && classified.collectionKind !== undefined) return classified.collectionKind
  }
  const key = info.extractor_key
  if (key === 'SoundcloudSet' || key === 'SoundcloudPlaylist') return 'set'
  if (key === 'SoundcloudUser') return 'channel'
  // The same list-id rules classifyUrl applies to pasted URLs.
  if (platform === 'youtube') return isYoutubeChannelId(id) ? 'channel' : youtubeListKind(id)
  return 'playlist'
}

/** Optional contract fields are omitted, not present with `undefined`. */
function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

/** Paths and messages only: issue values could carry titles or URLs. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}
