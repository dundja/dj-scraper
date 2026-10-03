import {
  type AmbiguousListKind,
  classifyUrl,
  type ErrorCode,
  type ResolveMode,
} from '@dj-scraper/shared'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-text.ts'

/** A failed resolve as shown: a title (the server's message), and a next step that may hold `commands`. */
export type FailureView = { title: string; detail?: string }

/**
 * Words for a failed resolve, or undefined for an abort (a newer paste or Cancel). The server's
 * message is already written for humans; no answer at all means our server is offline.
 */
export function failureView(error: unknown): FailureView | undefined {
  const described = describeError(error)
  if (described === undefined) return undefined
  if (error instanceof ApiError && error.kind === 'unreachable') {
    const detail = [described.message, described.hint].filter(Boolean).join(' ')
    return { title: 'Server offline', detail }
  }
  const view: FailureView = { title: described.message }
  if (described.hint !== undefined) view.detail = described.hint
  return view
}

/**
 * Failures of the track lookup itself, after which its list may still load: the track is private,
 * removed, age-restricted…, or that one lookup was refused or broke. A bad link or a refused
 * request would fail the list too.
 */
const TRACK_FAILURES = new Set<ErrorCode>([
  'unavailable',
  'private',
  'geo_blocked',
  'age_restricted',
  'login_required',
  'preview_only',
  'bot_check',
  'rate_limited',
  'network',
  'not_found',
  'unknown',
])

/**
 * The list to offer after a `watch?v=…&list=…` link failed in `auto` mode, which looks up only
 * the track: loading the same URL with `mode: 'collection'` lists the list instead. Undefined when
 * there is no such way out (another kind of link, another mode, the server offline).
 */
export function listFallback(
  url: string,
  mode: ResolveMode,
  error: unknown,
): AmbiguousListKind | undefined {
  if (mode !== 'auto') return undefined
  if (!(error instanceof ApiError) || error.kind !== 'api') return undefined
  if (error.code === undefined || !TRACK_FAILURES.has(error.code)) return undefined
  const classified = classifyUrl(url)
  if (!classified.ok || classified.kind !== 'youtube_watch_list') return undefined
  const kind = classified.collectionKind
  return kind === 'album' || kind === 'mix' ? kind : 'playlist'
}
