import * as z from 'zod'
import { PlatformSchema } from './platform.ts'
import { TrackSchema } from './track.ts'
import { HttpUrlSchema } from './url.ts'

/**
 * `channel` covers a YouTube channel tab and a SoundCloud user page (all, tracks, reposts). `album`
 * also covers SoundCloud sets the uploader labelled album, EP, single or compilation.
 */
export const CollectionKindSchema = z.enum([
  'playlist',
  'album',
  'set',
  'channel',
  'likes',
  'mix',
  'other',
])
export type CollectionKind = z.infer<typeof CollectionKindSchema>

/**
 * A row of a collection. Flat listings can lack metadata (SoundCloud set entries carry only id +
 * url, and that url may be an API URL). Such rows are `partial` until the web enriches them through
 * `POST /api/resolve/entries`, which returns full Tracks; merge them by platform + id, not url.
 */
export const CollectionEntrySchema = z.discriminatedUnion('partial', [
  TrackSchema.extend({ partial: z.literal(false) }),
  TrackSchema.extend({
    partial: z.literal(true),
    title: z.string().min(1).optional(),
    /** Page URL, or an API URL until enriched: don't link to it. */
    url: HttpUrlSchema,
  }),
])
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>

/** Identified by its `url`: `id` repeats across a channel's or user's tabs. */
export const CollectionSchema = z.object({
  id: z.string().min(1),
  platform: PlatformSchema,
  url: HttpUrlSchema,
  kind: CollectionKindSchema,
  title: z.string().min(1),
  owner: z.string().min(1).optional(),
  thumbnailUrl: HttpUrlSchema.optional(),
  /** The platform's own track count when yt-dlp reports it; it can exceed `entries.length`. */
  trackCount: z.int().nonnegative().optional(),
  /** The total duration the platform reports (SoundCloud sets), in seconds. */
  durationSec: z.number().nonnegative().optional(),
  /** Our listing cap cut the list: the platform has more rows than `entries` holds. */
  truncated: z.boolean(),
  /** Rows left out because they aren't tracks, e.g. sets listed on a SoundCloud user page. */
  skippedEntries: z.int().positive().optional(),
  entries: z.array(CollectionEntrySchema),
})
export type Collection = z.infer<typeof CollectionSchema>
