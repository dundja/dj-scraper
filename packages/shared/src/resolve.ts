import * as z from 'zod'
import { CollectionSchema } from './collection.ts'
import { TrackSchema } from './track.ts'
import { HttpUrlSchema } from './url.ts'

/**
 * `ambiguous` answers a `watch?v=…&list=…` URL: the user picks the track or the whole playlist at
 * `collectionUrl`.
 */
export const ResolveResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), track: TrackSchema }),
  z.object({ kind: z.literal('collection'), collection: CollectionSchema }),
  z.object({ kind: z.literal('ambiguous'), track: TrackSchema, collectionUrl: HttpUrlSchema }),
])
export type ResolveResult = z.infer<typeof ResolveResultSchema>
