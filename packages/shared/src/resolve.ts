import * as z from 'zod'
import { CollectionKindSchema, CollectionSchema } from './collection.ts'
import { ErrorInfoSchema } from './errors.ts'
import { PlatformSchema } from './platform.ts'
import { MAX_ID_LENGTH, TrackSchema } from './track.ts'
import { HttpUrlSchema, MAX_URL_LENGTH } from './url.ts'

/** Listing cap: YouTube's own playlist limit. Longer lists come back `truncated`. */
export const MAX_COLLECTION_ENTRIES = 5000

/** Listing cap for a YouTube Mix/Radio, which never ends. */
export const MAX_MIX_ENTRIES = 50

/** The most rows one `POST /api/resolve/entries` may ask for: about a screenful. */
export const MAX_ENTRIES_PER_REQUEST = 25

/**
 * How to treat a URL that is both a track and a list (`watch?v=…&list=…`): `auto` answers
 * `ambiguous`, `track` resolves only the track, `collection` lists the whole list.
 */
export const ResolveModeSchema = z.enum(['auto', 'track', 'collection'])
export type ResolveMode = z.infer<typeof ResolveModeSchema>

/** `POST /api/resolve`. The server validates `url` with `classifyUrl` (400 `invalid_url`). */
export const ResolveRequestSchema = z.object({
  url: z.string(),
  mode: ResolveModeSchema.default('auto'),
})
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>

/** The list behind an `ambiguous` result: a mix is capped at `MAX_MIX_ENTRIES` when listed. */
export const AmbiguousListKindSchema = CollectionKindSchema.extract(['playlist', 'album', 'mix'])
export type AmbiguousListKind = z.infer<typeof AmbiguousListKindSchema>

/**
 * `ambiguous` answers a `watch?v=…&list=…` URL in `auto` mode: the user picks the track or the
 * whole list at `collectionUrl` (resolve it again with `mode: 'collection'`).
 */
export const ResolveResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), track: TrackSchema }),
  z.object({ kind: z.literal('collection'), collection: CollectionSchema }),
  z.object({
    kind: z.literal('ambiguous'),
    track: TrackSchema,
    collectionUrl: HttpUrlSchema,
    collectionKind: AmbiguousListKindSchema,
  }),
])
export type ResolveResult = z.infer<typeof ResolveResultSchema>

/** A partial collection row to enrich, as listed in `Collection.entries`. */
export const EntryRefSchema = z.object({
  platform: PlatformSchema,
  id: z.string().min(1).max(MAX_ID_LENGTH),
  url: HttpUrlSchema.max(MAX_URL_LENGTH),
})
export type EntryRef = z.infer<typeof EntryRefSchema>

/** `POST /api/resolve/entries`: full Tracks for the partial rows in view. */
export const ResolveEntriesRequestSchema = z.object({
  entries: z.array(EntryRefSchema).min(1).max(MAX_ENTRIES_PER_REQUEST),
})
export type ResolveEntriesRequest = z.infer<typeof ResolveEntriesRequestSchema>

/**
 * One result per requested row, keyed by the request's platform + id (merge on those, not on
 * `track.id` or the url). A row fails on its own (removed track, 429) without failing the batch.
 */
export const EntryResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    platform: PlatformSchema,
    id: z.string().min(1).max(MAX_ID_LENGTH),
    track: TrackSchema,
  }),
  z.object({
    status: z.literal('error'),
    platform: PlatformSchema,
    id: z.string().min(1).max(MAX_ID_LENGTH),
    error: ErrorInfoSchema,
  }),
])
export type EntryResult = z.infer<typeof EntryResultSchema>

/** Results in request order, one per distinct platform + id. */
export const ResolveEntriesResponseSchema = z.object({
  results: z.array(EntryResultSchema),
})
export type ResolveEntriesResponse = z.infer<typeof ResolveEntriesResponseSchema>
