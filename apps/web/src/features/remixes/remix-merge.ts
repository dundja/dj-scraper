import {
  type ErrorInfo,
  REMIX_PLATFORMS,
  type RemixPlatform,
  type RemixSearchStatus,
  type RemixSuggestions,
} from '@dj-scraper/shared'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-text.ts'

/** One remix query, as far as the view cares. */
export type RemixQueryState =
  | { status: 'pending' }
  | { status: 'success'; data: RemixSuggestions }
  | { status: 'error'; error: unknown }

/**
 * What the remix section shows:
 * - `pending`: no answer yet (the skeleton).
 * - `error`: nothing succeeded (the error with Try again), with the full search's error.
 * - `ready`: an answer to show, and the platforms still being searched (their "Searching…" note).
 */
export type RemixView =
  | { status: 'pending' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; remixes: RemixSuggestions; searching: RemixPlatform[] }

/**
 * Merges the two searches the section runs at once (ADR-027): a quick one on YouTube alone (a few
 * seconds) and the full one on both platforms (SoundCloud can take ten). The full answer wins as
 * soon as it is in. Until then the quick one shows, with the platforms it skipped as `searching`.
 * When the full search fails after the quick one succeeded, the quick rows stay and the skipped
 * platforms show the failure as their own search's. The whole search failed only when both did.
 */
export function mergeRemixes(quick: RemixQueryState, full: RemixQueryState): RemixView {
  if (full.status === 'success') return { status: 'ready', remixes: full.data, searching: [] }
  if (quick.status !== 'success') {
    // A quick search still running may yet succeed, and so may a full one.
    if (quick.status === 'error' && full.status === 'error') {
      return { status: 'error', error: full.error }
    }
    return { status: 'pending' }
  }
  const skipped = REMIX_PLATFORMS.filter(
    (platform) => quick.data.searches[platform].status === 'skipped',
  )
  if (full.status === 'pending') return { status: 'ready', remixes: quick.data, searching: skipped }

  const failed: RemixSearchStatus = { status: 'error', error: errorInfo(full.error) }
  const searches = { ...quick.data.searches }
  for (const platform of skipped) searches[platform] = failed
  return { status: 'ready', remixes: { ...quick.data, searches }, searching: [] }
}

/** A failed request as a platform's search error: the server's code and words, or ours. */
function errorInfo(error: unknown): ErrorInfo {
  const description = describeError(error)
  if (description === undefined) return { code: 'canceled', message: 'The search was canceled.' }
  const code = error instanceof ApiError && error.code !== undefined ? error.code : 'unknown'
  return { code, message: description.message }
}
