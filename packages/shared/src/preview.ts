import * as z from 'zod'
import { RemixPlatformSchema } from './remix.ts'
import { MAX_ID_LENGTH } from './track.ts'
import { HttpUrlSchema, MAX_URL_LENGTH } from './url.ts'

/**
 * Listening to a remix in the app (ADR-029): the server fetches the upload's audio stream as it is
 * into a small cache of its own (never the user's folder), and serves it back to an `<audio>`
 * element with range requests. Speed and pitch lock are the element's (`playbackRate`,
 * `preservesPitch`), so nothing is converted.
 */

/** `POST /api/previews`: the upload to listen to, as a remix row names it. */
export const PreviewRequestSchema = z.object({
  platform: RemixPlatformSchema,
  id: z.string().min(1).max(MAX_ID_LENGTH),
  url: HttpUrlSchema.max(MAX_URL_LENGTH),
})
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>

/** A cached preview's id: 32 lowercase hex characters, derived from the platform and the track id. */
export const PREVIEW_ID_PATTERN = /^[0-9a-f]{32}$/

/** The answer once the audio is ready: `src` is a same-origin path for `<audio src>`. */
export const PreviewReadySchema = z.object({
  id: z.string().regex(PREVIEW_ID_PATTERN),
  src: z.string().regex(/^\/api\/previews\/[0-9a-f]{32}$/),
  /** What the stream is, for the element's `type`: audio/mp4, audio/mpeg, audio/webm… */
  mime: z.string().min(1).max(100),
  sizeBytes: z.int().positive(),
})
export type PreviewReady = z.infer<typeof PreviewReadySchema>

/** The speeds the player offers as presets (1 = the upload's own speed). */
export const PREVIEW_RATE_PRESETS: readonly number[] = [0.75, 0.9, 1, 1.1, 1.25, 1.5]
/** The slider's range and step: the browsers' `playbackRate` is reliable in this range. */
export const PREVIEW_RATE_MIN = 0.5
export const PREVIEW_RATE_MAX = 1.5
export const PREVIEW_RATE_STEP = 0.01
