import * as z from 'zod'
import { MAX_TRACK_TEXT_LENGTH } from './download.ts'
import { ErrorInfoSchema } from './errors.ts'
import { PlatformSchema } from './platform.ts'
import { MAX_ID_LENGTH } from './track.ts'
import { HttpUrlSchema, MAX_URL_LENGTH } from './url.ts'

/**
 * Remix suggestions for a pasted track (ADR-027): the server searches YouTube and SoundCloud for
 * the song's remixes, keeps the uploads that are another version of it, groups the uploads of one
 * version, tags a genre when the platforms or the titles name one, and sorts them by plays.
 */

/** The most suggestions one answer holds. */
export const MAX_REMIX_SUGGESTIONS = 20
/** The most uploads one suggestion lists (the same remix, uploaded by several channels). */
export const MAX_REMIX_UPLOADS = 5
/** The longest genre name: the server's names are short ("Melodic House & Techno"). */
export const MAX_GENRE_LENGTH = 40

const RemixText = z.string().min(1).max(MAX_TRACK_TEXT_LENGTH)

/** Where remixes are searched: each one's uploads download like any track of that platform. */
export const RemixPlatformSchema = PlatformSchema.extract(['youtube', 'soundcloud'])
export type RemixPlatform = z.infer<typeof RemixPlatformSchema>
export const REMIX_PLATFORMS: readonly RemixPlatform[] = RemixPlatformSchema.options

/**
 * `POST /api/remixes`: the pasted track's names, as resolve showed them. The server takes the song
 * out of them (version notes such as "(Official Video)" or "(X Remix)" dropped), so a pasted remix
 * finds the song's other remixes. `exclude` is the pasted track, left out of the answer.
 */
export const RemixRequestSchema = z.object({
  title: RemixText,
  artist: RemixText.optional(),
  /** Stands in for the artist when there is none (an upload titled with the song alone). */
  uploader: RemixText.optional(),
  exclude: z
    .object({ platform: PlatformSchema, id: z.string().min(1).max(MAX_ID_LENGTH) })
    .optional(),
  /**
   * The platforms to search, default both. YouTube answers in seconds and SoundCloud can take ten,
   * so the web asks for YouTube alone first, then for both: the server shares and caches each
   * platform's search, so the second request costs only SoundCloud's.
   */
  platforms: z.array(RemixPlatformSchema).min(1).max(REMIX_PLATFORMS.length).optional(),
})
export type RemixRequest = z.infer<typeof RemixRequestSchema>

/**
 * - `remix`: another producer's remix, rework, flip, VIP or dub ("(Arty Remix)").
 * - `bootleg`: an unofficial bootleg, or another producer's edit ("(X Bootleg)", "(X Edit)").
 * - `extended`: the original artist's own extended or club mix.
 */
export const RemixKindSchema = z.enum(['remix', 'bootleg', 'extended'])
export type RemixKind = z.infer<typeof RemixKindSchema>

/** One upload of a suggested version: a track to download as it is. */
export const RemixUploadSchema = z.object({
  platform: RemixPlatformSchema,
  id: z.string().min(1).max(MAX_ID_LENGTH),
  /** Its public page: what a download takes. */
  url: HttpUrlSchema.max(MAX_URL_LENGTH),
  title: RemixText,
  /** The channel or account that uploaded it. */
  uploader: RemixText.optional(),
  durationSec: z.number().nonnegative().optional(),
  thumbnailUrl: HttpUrlSchema.max(MAX_URL_LENGTH).optional(),
  /** YouTube's views or SoundCloud's plays, as the search reported them. */
  plays: z.int().nonnegative().optional(),
})
export type RemixUpload = z.infer<typeof RemixUploadSchema>

/**
 * Where the genre came from: `platform` is the genre a SoundCloud uploader chose; `text` is a genre
 * named in an upload's title, tags or description (a guess, shown as one).
 */
export const GenreSourceSchema = z.enum(['platform', 'text'])
export type GenreSource = z.infer<typeof GenreSourceSchema>

/** One version of the song, with its uploads on YouTube and SoundCloud, most played first. */
export const RemixSuggestionSchema = z.object({
  kind: RemixKindSchema,
  /** Who made it, as the titles name them ("Arty"). Absent when no title names anyone. */
  remixer: RemixText.optional(),
  genre: z
    .object({ name: z.string().min(1).max(MAX_GENRE_LENGTH), source: GenreSourceSchema })
    .optional(),
  /** The most plays among its uploads (YouTube's views and SoundCloud's plays aren't added up). */
  plays: z.int().nonnegative().optional(),
  /** The first is the one to download by default: the most played. */
  uploads: z.array(RemixUploadSchema).min(1).max(MAX_REMIX_UPLOADS),
})
export type RemixSuggestion = z.infer<typeof RemixSuggestionSchema>

/**
 * How one platform's search went: a failed search leaves the other platform's suggestions, and a
 * platform the request didn't ask for is `skipped`.
 */
export const RemixSearchStatusSchema = z.discriminatedUnion('status', [
  /** `found`: the search results that were another version of the song, before grouping. */
  z.object({ status: z.literal('ok'), found: z.int().nonnegative() }),
  z.object({ status: z.literal('error'), error: ErrorInfoSchema }),
  z.object({ status: z.literal('skipped') }),
])
export type RemixSearchStatus = z.infer<typeof RemixSearchStatusSchema>

export const RemixSuggestionsSchema = z.object({
  /** The song the server searched for. */
  song: z.object({ title: RemixText, artist: RemixText.optional() }),
  /** Most played first. */
  suggestions: z.array(RemixSuggestionSchema).max(MAX_REMIX_SUGGESTIONS),
  searches: z.object({ youtube: RemixSearchStatusSchema, soundcloud: RemixSearchStatusSchema }),
})
export type RemixSuggestions = z.infer<typeof RemixSuggestionsSchema>
