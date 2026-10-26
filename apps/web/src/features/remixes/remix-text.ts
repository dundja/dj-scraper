import {
  formatDuration,
  type GenreSource,
  REMIX_PLATFORMS,
  type RemixPlatform,
  type RemixSuggestion,
  type RemixSuggestions,
  type RemixUpload,
} from '@dj-scraper/shared'
import { formatCount } from '@/lib/format.ts'

// Wording and grouping for the remix suggestions (ADR-027).

export const REMIX_PLATFORM_NAMES: Record<RemixPlatform, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
}

/** "YouTube and SoundCloud", "YouTube": the platforms in a sentence. */
function platformList(platforms: readonly RemixPlatform[], joiner: 'and' | 'or'): string {
  const names = platforms.map((platform) => REMIX_PLATFORM_NAMES[platform])
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}`
}

/** What was searched: "Remixes of Moby – Porcelain on YouTube and SoundCloud". */
export function searchedText(song: RemixSuggestions['song']): string {
  const name = song.artist === undefined ? song.title : `${song.artist} – ${song.title}`
  return `Remixes of ${name} on ${platformList(REMIX_PLATFORMS, 'and')}`
}

/** The upload Download takes: the most played. The contract guarantees one. */
export function defaultUpload(suggestion: RemixSuggestion): RemixUpload {
  const upload = suggestion.uploads[0]
  if (upload === undefined) throw new Error('A remix suggestion has at least one upload')
  return upload
}

/** A suggestion's identity in its list: its default upload's `platform:id`. */
export function suggestionKey(suggestion: RemixSuggestion): string {
  const { platform, id } = defaultUpload(suggestion)
  return `${platform}:${id}`
}

/** "Remix by Arty", "Bootleg by X", "Remix" when no title names the remixer, "Extended mix". */
export function kindText({ kind, remixer }: Pick<RemixSuggestion, 'kind' | 'remixer'>): string {
  switch (kind) {
    case 'remix':
      return remixer === undefined ? 'Remix' : `Remix by ${remixer}`
    case 'bootleg':
      return remixer === undefined ? 'Bootleg' : `Bootleg by ${remixer}`
    case 'extended':
      return 'Extended mix'
  }
}

/** Where a genre came from, for its tooltip and screen readers. */
export function genreSourceText(source: GenreSource): string {
  return source === 'platform' ? 'Genre set on SoundCloud' : 'Genre named in the title or tags'
}

/** "908K views" on YouTube, "382K plays" on SoundCloud. */
export function playsText(platform: RemixPlatform, plays: number): string {
  const noun = platform === 'youtube' ? 'view' : 'play'
  return `${formatCount(plays)} ${noun}${plays === 1 ? '' : 's'}`
}

/** Each platform's most played upload of a suggestion (uploads come most played first). */
export function uploadsByPlatform(suggestion: RemixSuggestion): RemixUpload[] {
  return REMIX_PLATFORMS.flatMap((platform) => {
    const upload = suggestion.uploads.find((candidate) => candidate.platform === platform)
    return upload === undefined ? [] : [upload]
  })
}

/** One upload in the "Choose upload" menu: "YouTube · Anjunabeats · 908K views · 3:34". */
export function uploadText(upload: RemixUpload): string {
  const parts = [REMIX_PLATFORM_NAMES[upload.platform]]
  if (upload.uploader !== undefined) parts.push(upload.uploader)
  if (upload.plays !== undefined) parts.push(playsText(upload.platform, upload.plays))
  if (upload.durationSec !== undefined) parts.push(formatDuration(upload.durationSec))
  return parts.join(' · ')
}

export type GenreCount = { name: string; count: number }

/** The genres the suggestions name, most suggestions first, then by name. */
export function genreCounts(suggestions: readonly RemixSuggestion[]): GenreCount[] {
  const counts = new Map<string, number>()
  for (const { genre } of suggestions) {
    if (genre !== undefined) counts.set(genre.name, (counts.get(genre.name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export type SearchFailure = { platform: RemixPlatform; text: string }

/** A note per platform whose search failed: "SoundCloud search failed: <message>". */
export function searchFailures(searches: RemixSuggestions['searches']): SearchFailure[] {
  return REMIX_PLATFORMS.flatMap((platform) => {
    const search = searches[platform]
    if (search.status !== 'error') return []
    const text = `${REMIX_PLATFORM_NAMES[platform]} search failed: ${search.error.message}`
    return [{ platform, text }]
  })
}

/**
 * What an answer without suggestions says, for the platforms whose search went fine: "No remixes
 * found on YouTube or SoundCloud." Undefined when none did (their notes say why).
 */
export function emptyText(searches: RemixSuggestions['searches']): string | undefined {
  const searched = REMIX_PLATFORMS.filter((platform) => searches[platform].status === 'ok')
  if (searched.length === 0) return undefined
  return `No remixes found on ${platformList(searched, 'or')}.`
}

/** "Searching SoundCloud…": the note of a platform the quick answer skipped. */
export function searchingText(platforms: readonly RemixPlatform[]): string {
  return `Searching ${platformList(platforms, 'and')}…`
}

/** "1 remix", "12 remixes": the count for the heading and the status line. */
export function remixCount(count: number): string {
  return `${count} ${count === 1 ? 'remix' : 'remixes'}`
}
