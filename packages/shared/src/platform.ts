import * as z from 'zod'

/**
 * `spotify` is a source of track lists and tags only: its streams are DRM-protected, so a Spotify
 * track's audio is matched on YouTube and downloaded from there (ADR-026).
 */
export const PlatformSchema = z.enum(['youtube', 'soundcloud', 'spotify', 'other'])
export type Platform = z.infer<typeof PlatformSchema>

/**
 * The platform whose download pacing, run order and pauses a track takes: a Spotify track is
 * searched and downloaded on YouTube (ADR-026), so YouTube's apply to it.
 */
export const pacingPlatform = (platform: Platform): Platform =>
  platform === 'spotify' ? 'youtube' : platform
