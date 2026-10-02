import * as z from 'zod'
import { ErrorCodeSchema } from './errors.ts'
import { PlatformSchema } from './platform.ts'
import { HttpUrlSchema } from './url.ts'

/**
 * `unknown` is normal in flat listings, where yt-dlp reports no availability, so treat it as
 * selectable. Only `unavailable` rows are greyed out.
 */
export const AvailabilitySchema = z.enum(['available', 'unavailable', 'unknown'])
export type Availability = z.infer<typeof AvailabilitySchema>

/** Why a track is unavailable; the web turns the code into human text. */
export const UnavailableReasonSchema = ErrorCodeSchema.extract([
  'unavailable',
  'private',
  'geo_blocked',
  'age_restricted',
  'login_required',
  'preview_only',
])
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>

/** The stream's own codec and bitrate, known after full extraction. Never the converted output. */
export const AudioSourceSchema = z
  .object({
    /** yt-dlp's `acodec` as reported, e.g. `opus`, `mp4a.40.2`, `mp3`. */
    codec: z.string().min(1).optional(),
    bitrateKbps: z.number().positive().optional(),
  })
  .refine((source) => source.codec !== undefined || source.bitrateKbps !== undefined, {
    message: 'Omit source when neither codec nor bitrate is known',
  })
export type AudioSource = z.infer<typeof AudioSourceSchema>

/**
 * The longest platform id the contract accepts. Real ids are far shorter (YouTube 11 characters,
 * SoundCloud about 10 digits); the cap bounds what a request can put into a log line.
 */
export const MAX_ID_LENGTH = 256

export const TrackSchema = z.object({
  /** Platform id from yt-dlp. */
  id: z.string().min(1).max(MAX_ID_LENGTH),
  platform: PlatformSchema,
  /** Canonical page URL. */
  url: HttpUrlSchema,
  title: z.string().min(1),
  /** Platform metadata, else parsed from the title. */
  artist: z.string().min(1).optional(),
  uploader: z.string().min(1).optional(),
  durationSec: z.number().nonnegative().optional(),
  thumbnailUrl: HttpUrlSchema.optional(),
  availability: AvailabilitySchema,
  /** Set only when `availability` is `unavailable`. */
  unavailableReason: UnavailableReasonSchema.optional(),
  source: AudioSourceSchema.optional(),
})
export type Track = z.infer<typeof TrackSchema>
