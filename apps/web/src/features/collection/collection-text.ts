import {
  type Collection,
  type CollectionKind,
  type CollectionLink,
  type CreateDownloadsResponse,
  classifyUrl,
} from '@dj-scraper/shared'
import { formatTotalDuration } from '@/lib/format.ts'
import type { SelectionSummary, TableRow } from './rows.ts'

// Words for the collection view: header facts and notes, the selection line, the download result.

/** "5,000": grouped the same way whatever the browser's language, like the rest of the UI's English. */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US')
}

/** "1 track", "5,000 tracks". */
export function countOf(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`
}

const KIND_LABELS: Record<CollectionKind, string> = {
  playlist: 'Playlist',
  album: 'Album',
  set: 'Set',
  channel: 'Channel',
  likes: 'Likes',
  mix: 'Mix',
  other: 'List',
}

/** What the list is: "Playlist", "Set"; a SoundCloud user page is a "Profile", not a channel. */
export function kindLabel(collection: Pick<Collection, 'kind' | 'platform'>): string {
  if (collection.kind === 'channel' && collection.platform === 'soundcloud') return 'Profile'
  return KIND_LABELS[collection.kind]
}

/** "30 tracks", or "50 of 214 tracks" when the platform counts more than the listing holds. */
export function trackCountText(collection: Pick<Collection, 'entries' | 'trackCount'>): string {
  const listed = collection.entries.length
  const { trackCount } = collection
  if (trackCount === undefined || trackCount === listed) return countOf(listed, 'track')
  return `${formatCount(listed)} of ${countOf(trackCount, 'track')}`
}

/**
 * The list's length: the platform's own total when it reports one (SoundCloud sets), else the sum
 * of the rows' known durations, "≈" when a downloadable row's duration is still unknown (partial
 * rows fill in as they load). Unavailable rows don't count. Undefined while nothing is known.
 */
export function totalDurationText(
  collection: Pick<Collection, 'durationSec'>,
  rows: readonly TableRow[],
): string | undefined {
  if (collection.durationSec !== undefined && collection.durationSec > 0) {
    return formatTotalDuration(collection.durationSec)
  }
  let sum = 0
  let unknown = false
  for (const { entry } of rows) {
    if (entry.availability === 'unavailable') continue
    if (entry.durationSec === undefined || entry.durationSec === 0) unknown = true
    else sum += entry.durationSec
  }
  if (sum === 0) return undefined
  return unknown ? `≈ ${formatTotalDuration(sum)}` : formatTotalDuration(sum)
}

/** Why the table holds fewer rows than the platform has, when our listing cap cut it. */
export function truncatedNote(
  collection: Pick<Collection, 'truncated' | 'kind' | 'entries'>,
): string | undefined {
  if (!collection.truncated) return undefined
  const listed = formatCount(collection.entries.length)
  return collection.kind === 'mix'
    ? `A mix never ends: showing its first ${listed} tracks.`
    : `Showing the first ${listed} tracks.`
}

/**
 * What a linked list is called: SoundCloud keeps sets and albums under `/sets/`, so only an Albums
 * tab says "album"; elsewhere they are playlists.
 */
export function listNoun(collection: Pick<Collection, 'platform' | 'url'>, count: number): string {
  const path = new URL(collection.url).pathname.replace(/\/+$/, '')
  const noun = path.endsWith('/albums')
    ? 'album'
    : collection.platform === 'soundcloud'
      ? 'set'
      : 'playlist'
  return countOf(count, noun)
}

/** "This page also lists 2 sets", for a page with tracks that links to lists too. */
export function listsNote(
  collection: Pick<Collection, 'platform' | 'url' | 'lists'>,
): string | undefined {
  const count = collection.lists?.length ?? 0
  return count === 0 ? undefined : `This page also lists ${listNoun(collection, count)}.`
}

/**
 * The skipped rows that aren't lists we can open: "2 rows aren't tracks", or with lists "1 other
 * row isn't a track".
 */
export function skippedNote(
  collection: Pick<Collection, 'skippedEntries' | 'lists'>,
): string | undefined {
  const lists = collection.lists?.length ?? 0
  const others = (collection.skippedEntries ?? 0) - lists
  if (others <= 0) return undefined
  const other = lists > 0 ? 'other ' : ''
  return others === 1
    ? `1 ${other}row isn't a track.`
    : `${formatCount(others)} ${other}rows aren't tracks.`
}

/** "28 selected", or "None selected": what the toolbar announces when the selection changes. */
export function selectionCountText(count: number): string {
  return count === 0 ? 'None selected' : `${formatCount(count)} selected`
}

/** "28 selected · 2 h 51 min · 1 without a duration", or "None selected". */
export function selectionText(summary: SelectionSummary): string {
  if (summary.count === 0) return selectionCountText(0)
  const parts = [selectionCountText(summary.count)]
  if (summary.durationSec > 0) parts.push(formatTotalDuration(summary.durationSec))
  if (summary.withoutDuration > 0) {
    parts.push(`${formatCount(summary.withoutDuration)} without a duration`)
  }
  return parts.join(' · ')
}

/** The primary button: "Download 28 tracks", "Download 1 track". */
export function downloadButtonText(count: number): string {
  return count === 0 ? 'Select tracks' : `Download ${countOf(count, 'track')}`
}

/**
 * What a download request did. The server maps a track that is already queued or running (same
 * folder and format) to its job instead of adding one: `duplicates` counts those.
 */
export function queuedText(response: CreateDownloadsResponse): string {
  const requested = response.jobIds.length
  const added = requested - response.duplicates
  if (added <= 0) {
    return requested === 1
      ? 'This track is already in the queue — see Downloads.'
      : `All ${formatCount(requested)} tracks are already in the queue — see Downloads.`
  }
  const queued = `Queued ${countOf(added, 'track')} — see Downloads.`
  if (response.duplicates === 0) return queued
  return response.duplicates === 1
    ? `${queued} 1 was already in the queue.`
    : `${queued} ${formatCount(response.duplicates)} were already in the queue.`
}

/**
 * A linked list's name: its title, else the last part of its URL ("royal-ep"). A secret
 * SoundCloud set (`/<user>/sets/<set>/s-<token>`) is named by its set's part, never by the token:
 * that is the link's credential, and says nothing about the set.
 */
export function listTitle(link: CollectionLink): string {
  if (link.title !== undefined) return link.title
  const segments = new URL(link.url).pathname.split('/').filter(Boolean)
  const classified = classifyUrl(link.url)
  const secretSet =
    classified.ok &&
    classified.secret === true &&
    classified.kind === 'soundcloud_set' &&
    segments.length === 4
  const name = secretSet ? segments[2] : segments.at(-1)
  if (name === undefined) return link.url
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}
