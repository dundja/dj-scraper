import {
  type CollectionEntry,
  CollectionSchema,
  type ResolveResult,
  spotifyUrl,
} from '@dj-scraper/shared'
import { ApiError } from '../http/errors.ts'
import { checkUrl } from './input.ts'

/**
 * Pure: Spotify track links pasted at once → one `links` collection (`POST /api/resolve/links`).
 * Spotify's embed page lists only the first 100 rows of a playlist (ADR-026), but its app copies
 * every selected track's link, so a long playlist comes in this way. Nothing is read here: each
 * row is partial (id and url) and fills in from its own embed page through
 * `POST /api/resolve/entries`, as it comes into view (ADR-022).
 */

export const LINKS_TITLE = 'Pasted Spotify tracks'

export const NO_SPOTIFY_TRACKS =
  'None of these links is a Spotify track. Paste track links, e.g. copied from a playlist in the Spotify app.'

/**
 * The collection of the pasted links that are Spotify tracks, in paste order, each track once.
 * Every other link (another platform, an album or playlist, text that isn't a link) is counted in
 * `skippedEntries`; a repeat of a track is dropped silently, as a playlist's listing drops it.
 * Throws `ApiError('unsupported_url')` when none is a Spotify track.
 */
export function linksCollection(urls: readonly string[]): ResolveResult {
  const entries: CollectionEntry[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const url of urls) {
    const checked = checkUrl(url)
    const id =
      checked.ok && checked.input.kind === 'spotify_track' ? checked.input.spotifyId : undefined
    if (id === undefined) {
      skipped++
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    entries.push({
      partial: true,
      id,
      platform: 'spotify',
      url: spotifyUrl('spotify_track', id),
      availability: 'unknown',
    })
  }
  const first = entries[0]
  if (first === undefined) throw new ApiError('unsupported_url', NO_SPOTIFY_TRACKS)
  const collection = CollectionSchema.parse({
    id: `links-${first.id}`,
    platform: 'spotify',
    // No page holds the list: the first track stands for it, and the web doesn't link it as one.
    url: first.url,
    kind: 'links',
    title: LINKS_TITLE,
    truncated: false,
    ...(skipped > 0 ? { skippedEntries: skipped } : {}),
    entries,
  })
  return { kind: 'collection', collection }
}
