import * as z from 'zod'
import { lenient } from '../util/fields.ts'
import type { SpotifyTrack } from './embed.ts'

/**
 * Pure: a Spotify track → a YouTube search, and the search's results → the upload to download
 * (ADR-026). A wrong match is worse than none, so a result must pass every check: the length
 * agrees, the title's words are there, an artist is named, and it isn't another version (live,
 * remix, cover, sped up, …) unless the Spotify title says so. The best of those wins.
 */

/** How many results to weigh: the right upload is nearly always among YouTube's first few. */
export const SEARCH_RESULTS = 10
/** Spotify and YouTube cut the same master within a second or two; a music video runs longer. */
export const MAX_DURATION_DELTA_SEC = 5
/** The longest query, in code points. */
export const MAX_QUERY_LENGTH = 200

/** One search result, read tolerantly from yt-dlp's flat `ytsearch` JSON. */
export type Candidate = {
  id: string
  title: string
  /** The channel. */
  uploader?: string
  durationSec?: number
}

export type Match = { candidate: Candidate; score: number }

/**
 * `<artists> - <title>`, as uploads are usually named. Controls become spaces: the query is one
 * argv entry after `--`, built from Spotify's page, never from the request.
 */
export function searchQuery(track: Pick<SpotifyTrack, 'title' | 'artists'>): string {
  const text = [track.artists.join(', '), track.title].filter((part) => part !== '').join(' - ')
  const clean = text
    .toWellFormed()
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
  // Cut by code points: a cut UTF-16 string could end in half an emoji.
  return Array.from(clean).slice(0, MAX_QUERY_LENGTH).join('').trimEnd()
}

const Text = lenient(z.string().trim().min(1))
const SearchSchema = z.looseObject({
  entries: lenient(
    z.array(
      lenient(
        z.looseObject({
          id: lenient(z.string().regex(/^[A-Za-z0-9_-]{11}$/)),
          title: Text,
          channel: Text,
          uploader: Text,
          duration: lenient(z.number().nonnegative()),
          url: Text,
          live_status: Text,
        }),
      ),
    ),
  ),
})

/** Videos with an id, a title and a length; shorts and live streams are no song's upload. */
export function parseSearchResults(json: unknown): Candidate[] {
  const parsed = SearchSchema.safeParse(json)
  if (!parsed.success) return []
  const candidates: Candidate[] = []
  for (const entry of parsed.data.entries ?? []) {
    if (entry?.id === undefined || entry.title === undefined) continue
    if (entry.url?.includes('/shorts/')) continue
    if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') continue
    const uploader = entry.channel ?? entry.uploader
    candidates.push({
      id: entry.id,
      title: entry.title,
      ...(uploader === undefined ? {} : { uploader }),
      ...(entry.duration === undefined ? {} : { durationSec: entry.duration }),
    })
  }
  return candidates
}

/**
 * Words that make an upload another version of the song. One in a result's title but not in the
 * Spotify title rules the result out.
 */
const VERSION_WORDS = new Set([
  'live',
  'cover',
  'covers',
  'karaoke',
  'instrumental',
  'acapella',
  'acoustic',
  'remix',
  'rmx',
  'bootleg',
  'mashup',
  'edit',
  'extended',
  'sped',
  'slowed',
  'reverb',
  'nightcore',
  '8d',
  'reaction',
  'reacts',
  'tutorial',
  'lesson',
  'hour',
  'hours',
  'loop',
  'concert',
  'session',
  'performance',
  'demo',
  'version',
  'piano',
  'orchestral',
  'stripped',
  'unplugged',
])
/**
 * Version words that a Spotify title's version note makes required: a result for "Song -
 * Instrumental" must say instrumental too. Edits, extended and radio versions are told apart by
 * length instead, since uploads often leave those words out.
 */
const DISTINCT_VERSION_WORDS = new Set([
  'live',
  'acoustic',
  'instrumental',
  'acapella',
  'remix',
  'rmx',
  'bootleg',
  'rework',
  'flip',
  'vip',
  'dub',
  'club',
  'mashup',
  'cover',
  'karaoke',
  'sped',
  'slowed',
  'nightcore',
  'reverb',
  '8d',
  'piano',
  'orchestral',
  'stripped',
  'unplugged',
  'demo',
])
/** A note with one of these names someone else's version: "(Remixer A Remix)". */
const REMIX_WORDS = new Set(['remix', 'rmx', 'rework', 'flip', 'bootleg'])
/** Words of such a note that name no one. */
const GENERIC_NOTE_WORDS = new Set([
  ...REMIX_WORDS,
  'mix',
  'original',
  'version',
  'edit',
  'radio',
  'extended',
  'club',
  'dub',
  'vip',
  'the',
  'and',
  'x',
  'vs',
])
/** Channel words that mean a channel only carries the artist's name. */
const NOT_THE_ARTIST = new Set(['lyrics', 'lyric', 'fan', 'fans', 'tribute', 'covers', 'karaoke'])
/** An uploader that is the artist's own art-track channel, e.g. `Rick Astley - Topic`. */
const TOPIC_SUFFIX = ' - topic'
/** A Spotify title's featured artists, `(feat. X)` or `[with X]`: uploads name them in many ways. */
const FEATURING = /[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi
/** Spotify's reissue suffixes (` - 2011 Remaster`, `(Remastered 2009)`) that uploads rarely carry. */
const REMASTER =
  /\s-\s(?:\d{4}\s)?remaster(?:ed)?(?:\s\d{4})?(?:\sversion)?$|[([]\s*(?:\d{4}\s)?remaster(?:ed)?(?:\s\d{4})?\s*[)\]]/gi

/** A version note after the name: ` - Radio Edit`, `(Extended Mix)`, `[Live]`. */
const VERSION_NOTE = /\s-\s.*$|[([][^)\]]*[)\]]/g

/**
 * The results that pass every check, best first; ties keep YouTube's own order.
 * - Length: within `MAX_DURATION_DELTA_SEC` of Spotify's (an extended mix is minutes longer, so
 *   this tells versions apart where titles don't).
 * - Title: every word of the song's name appears (the Spotify title without featured artists,
 *   remaster notes and version notes, which uploads word in many ways).
 * - Artist: one of the Spotify artists appears in the result's title or channel.
 * - Version: no version word the Spotify title (or an artist's name: LIVE, Session Victim) lacks,
 *   and the Spotify title's own version (Instrumental, Acoustic, a remixer's name) is named too.
 * The score then prefers a closer length, the artist's own or Topic channel, "official audio" and
 * no "lyrics" re-upload.
 */
export function rankMatches(
  track: Pick<SpotifyTrack, 'title' | 'artists' | 'durationSec'>,
  candidates: readonly Candidate[],
): Match[] {
  if (track.durationSec === undefined) return []
  const plain = track.title.replace(FEATURING, ' ').replace(REMASTER, ' ')
  const name = words(plain.replace(VERSION_NOTE, ' '))
  const titleWords = name.length > 0 ? name : words(plain)
  const artists = track.artists.map(words).filter((artist) => artist.length > 0)
  const required = requiredVersionWords(plain, titleWords)
  // "Song - Acoustic" is often uploaded as "Song (Acoustic Version)".
  const allowed = new Set([
    ...words(track.title),
    ...artists.flat(),
    ...(required.length > 0 ? ['version'] : []),
  ])
  const wanted: Wanted = {
    durationSec: track.durationSec,
    titleWords,
    fullTitle: words(plain),
    required,
    allowed,
    artists,
  }
  const matches: Match[] = []
  candidates.forEach((candidate, rank) => {
    const score = scoreCandidate(candidate, rank, wanted)
    if (score !== undefined) matches.push({ candidate, score })
  })
  // Array sort is stable: equal scores keep YouTube's order.
  return matches.sort((a, b) => b.score - a.score)
}

/** The best result that passes every check (`rankMatches`), or undefined. */
export function pickMatch(
  track: Pick<SpotifyTrack, 'title' | 'artists' | 'durationSec'>,
  candidates: readonly Candidate[],
): Match | undefined {
  return rankMatches(track, candidates)[0]
}

/**
 * The words a result must have besides the song's name: the distinct version words of the title's
 * notes, and the names in a remix note ("Song - Remixer A Remix" needs "remixer").
 */
function requiredVersionWords(plain: string, name: readonly string[]): string[] {
  const required = new Set<string>()
  for (const note of plain.match(VERSION_NOTE) ?? []) {
    const noteWords = words(note)
    const remix = noteWords.some((word) => REMIX_WORDS.has(word))
    for (const word of noteWords) {
      if (DISTINCT_VERSION_WORDS.has(word)) required.add(word)
      else if (remix && !GENERIC_NOTE_WORDS.has(word) && !/^\d+$/.test(word)) required.add(word)
    }
  }
  for (const word of name) required.delete(word)
  return [...required]
}

type Wanted = {
  durationSec: number
  titleWords: string[]
  /** The title's words with its version note: a result that has them all is the likelier version. */
  fullTitle: string[]
  /** The version the Spotify title names, which the result must name too. */
  required: string[]
  /** Every word of the Spotify title and its artists' names, so their version words are allowed. */
  allowed: ReadonlySet<string>
  artists: string[][]
}

function scoreCandidate(candidate: Candidate, rank: number, wanted: Wanted): number | undefined {
  if (candidate.durationSec === undefined) return undefined
  const delta = Math.abs(candidate.durationSec - wanted.durationSec)
  if (delta > MAX_DURATION_DELTA_SEC) return undefined

  const title = words(candidate.title)
  const titleSet = new Set(title)
  if (!wanted.titleWords.every((word) => titleSet.has(word))) return undefined
  if (!wanted.required.every((word) => titleSet.has(word))) return undefined
  if (title.some((word) => VERSION_WORDS.has(word) && !wanted.allowed.has(word))) return undefined

  const channel = normalize(candidate.uploader ?? '')
  const channelName = channel.endsWith(TOPIC_SUFFIX)
    ? channel.slice(0, -TOPIC_SUFFIX.length)
    : channel
  const channelWords = words(channelName)
  const named = wanted.artists.some(
    (artist) => containsRun(title, artist) || containsRun(channelWords, artist),
  )
  if (!named) return undefined

  // The artist's channel, alone or shared ("Santan Dave and Tems", "Dom Dolla and Solomun
  // (Official)"), but not a fan or lyrics channel named after them.
  const ownChannel =
    !channelWords.some((word) => NOT_THE_ARTIST.has(word)) &&
    wanted.artists.some((artist) => containsRun(channelWords, artist))
  const text = title.join(' ')
  return (
    100 -
    delta * 4 -
    rank +
    (ownChannel ? 20 : 0) +
    (wanted.fullTitle.every((word) => titleSet.has(word)) ? 5 : 0) +
    (channel.endsWith(TOPIC_SUFFIX) || text.includes('official audio') ? 10 : 0) -
    (titleSet.has('lyrics') || titleSet.has('lyric') ? 5 : 0)
  )
}

/** Lowercase, accents and punctuation gone, `&` as `and`: "ADÉLA" and "adela" are one name. */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The words of a text; ` - ` separators and lone dashes aren't words. */
function words(text: string): string[] {
  return normalize(text)
    .split(' ')
    .flatMap((word) => word.split(/-+/))
    .filter((word) => word !== '')
}

/** Whether `haystack` holds `needle` as consecutive words. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true
  }
  return false
}
