import {
  classifyUrl,
  HttpUrlSchema,
  MAX_ID_LENGTH,
  MAX_REMIX_SUGGESTIONS,
  MAX_REMIX_UPLOADS,
  MAX_TRACK_TEXT_LENGTH,
  MAX_URL_LENGTH,
  type RemixKind,
  type RemixPlatform,
  type RemixRequest,
  type RemixSuggestion,
  type RemixUpload,
  splitArtistTitle,
} from '@dj-scraper/shared'
import * as z from 'zod'
import { bestThumbnail, ThumbnailSchema } from '../engine/ytdlp-parse.ts'
import { lenient, omitUndefined } from '../util/fields.ts'
import { containsRun, words } from '../util/words.ts'
import { genrePhrase, uploadGenre } from './genre.ts'

/**
 * Pure: a pasted track's names → the song and its search query, and the platforms' search results
 * → remix suggestions (ADR-027). A result is suggested only when it names the song and its artist
 * and is another version of it: someone's remix, rework, flip, VIP, dub, bootleg or edit, or the
 * artist's own extended or club mix. Covers, live takes, sped-up and other re-uploads are not. The
 * uploads of one version (the same remixer, on either platform) become one suggestion, and the
 * suggestions are sorted by their most-played upload.
 */

/**
 * Results per search. YouTube lists about 20 per page (30 took 2-3 s live); SoundCloud answers
 * one request, but 50 results took 13 s against 6-10 s for 30 (2026-10-25).
 */
export const SEARCH_COUNTS: Record<RemixPlatform, number> = { youtube: 30, soundcloud: 30 }
/** The longest query, in code points. */
export const MAX_QUERY_LENGTH = 200
/** Shorter is a snippet or an intro; longer is a DJ set, a loop or a full EP. */
export const MIN_DURATION_SEC = 90
export const MAX_DURATION_SEC = 15 * 60
/** A remixer's name longer than this is a sentence, not a name. */
const MAX_REMIXER_WORDS = 5

/** The song a pasted track is a version of. */
export type Song = {
  title: string
  /** The first artist, as shown and searched. */
  artist?: string
  titleWords: string[]
  /** Every artist's words; empty when only an uploader stood in for the artist. */
  artists: string[][]
}

/** A Spotify-style featured artist in a title: `(feat. X)`, `[with X]`, ` ft. X`. */
const FEATURING =
  /[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s(?:feat\.?|ft\.?|featuring)\s.*$/gi
/** A version note: ` - Radio Edit`, `(Official Video)`, `[Arty Remix]`, `| Lyrics`. */
const VERSION_NOTE = /\s[-–—|]\s.*$|[([【][^)\]】]*[)\]】]/g
/** Between the artists resolve and Spotify list: `A, B`, `A feat. B`. */
const ARTIST_LIST = /\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i
/** Inside one name that may be one act or two: `Above & Beyond`, `A x B`. */
const ARTIST_PAIR = /\s+(?:&|and|x|vs\.?)\s+/i
const TOPIC_SUFFIX = / - Topic$/

/**
 * The song behind the names resolve showed: the title without featured artists and version notes
 * (so a pasted remix finds the song's other remixes), and its artists. With no artist, an
 * "Artist - Title" title is split, and failing that the uploader is searched for but not required.
 * Undefined when nothing searchable is left.
 */
export function songOf(
  request: Pick<RemixRequest, 'title' | 'artist' | 'uploader'>,
): Song | undefined {
  let { title } = request
  let artist = request.artist
  const split = splitArtistTitle(title)
  if (artist === undefined && split !== undefined) {
    artist = split.artist
    title = split.title
  } else if (
    split !== undefined &&
    words(split.artist).join(' ') === words(artist ?? '').join(' ')
  ) {
    title = split.title
  }
  const name = clean(title.replace(FEATURING, ' ').replace(VERSION_NOTE, ' '))
  const titleWords = words(name)
  if (titleWords.length === 0) return undefined
  const names = (artist ?? '')
    .replace(FEATURING, ' ')
    .split(ARTIST_LIST)
    .map((part) => clean(part))
    .filter((part) => words(part).length > 0)
  // "Above & Beyond" is searched whole; "A & B" may be credited as either of them too.
  const artists = names.flatMap((part) => {
    const halves = part.split(ARTIST_PAIR).filter((half) => words(half).length > 0)
    return [part, ...(halves.length > 1 ? halves : [])].map(words)
  })
  const searched = names[0] ?? uploaderArtist(request.uploader, title)
  return {
    title: name,
    ...(searched === undefined || searched === '' ? {} : { artist: searched }),
    titleWords,
    artists,
  }
}

/**
 * The uploader standing in for a missing artist, unless a version note of the title names them: the
 * uploader of "Porcelain (Arty Remix)" is likely Arty, the remixer, not the song's artist.
 */
function uploaderArtist(uploader: string | undefined, title: string): string | undefined {
  const name = clean(uploader?.replace(TOPIC_SUFFIX, '') ?? '')
  const own = words(name)
  if (own.length === 0) return undefined
  const notes = title.match(VERSION_NOTE) ?? []
  return notes.some((note) => containsRun(words(note), own)) ? undefined : name
}

/** `<artist> <title> remix`; controls become spaces, as the query is one argv entry after `--`. */
export function remixQuery(song: Pick<Song, 'title' | 'artist'>): string {
  const text = clean(
    [song.artist, song.title, 'remix'].filter((part) => part !== undefined).join(' '),
  )
  // Cut by code points: a cut UTF-16 string could end in half an emoji.
  return Array.from(text).slice(0, MAX_QUERY_LENGTH).join('').trimEnd()
}

function clean(text: string): string {
  return text
    .toWellFormed()
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A search result, read tolerantly from yt-dlp's flat search JSON. */
export type RemixCandidate = RemixUpload & {
  /** SoundCloud's genre field. */
  platformGenre?: string
  tags?: string[]
  /** YouTube's description snippet. */
  description?: string
  /** SoundCloud's artist field. */
  artists?: string[]
}

const Text = lenient(z.string().trim().min(1))
const Url = lenient(HttpUrlSchema.max(MAX_URL_LENGTH))
const SearchSchema = z.looseObject({
  entries: lenient(
    z.array(
      lenient(
        z.looseObject({
          // Bounded as the contract bounds them: one junk result must not void the whole answer.
          id: lenient(
            z.union([
              z.string().trim().min(1).max(MAX_ID_LENGTH),
              z.int().nonnegative().transform(String),
            ]),
          ),
          url: Url,
          webpage_url: Url,
          title: Text,
          channel: Text,
          uploader: Text,
          duration: lenient(z.number().nonnegative()),
          view_count: lenient(z.number().nonnegative().max(Number.MAX_SAFE_INTEGER)),
          live_status: Text,
          description: Text,
          genre: Text,
          genres: lenient(z.array(Text)),
          tags: lenient(z.array(Text)),
          artists: lenient(z.array(Text)),
          thumbnail: Url,
          thumbnails: lenient(z.array(lenient(ThumbnailSchema))),
        }),
      ),
    ),
  ),
})

/**
 * The results of one platform's search that can be downloaded as tracks: YouTube videos (not
 * shorts, not live), SoundCloud tracks with a public page.
 */
export function parseSearchResults(platform: RemixPlatform, json: unknown): RemixCandidate[] {
  const parsed = SearchSchema.safeParse(json)
  if (!parsed.success) return []
  const candidates: RemixCandidate[] = []
  for (const entry of parsed.data.entries ?? []) {
    if (entry?.id === undefined || entry.title === undefined) continue
    const url = pageUrl(platform, entry.id, entry.webpage_url ?? entry.url)
    if (url === undefined) continue
    if (entry.live_status === 'is_live' || entry.live_status === 'is_upcoming') continue
    const tags = (entry.tags ?? []).filter((tag) => tag !== undefined)
    const artists = (entry.artists ?? []).filter((name) => name !== undefined)
    candidates.push({
      platform,
      id: entry.id,
      url,
      title: clip(entry.title),
      ...omitUndefined({
        uploader: clip(entry.channel ?? entry.uploader),
        durationSec: entry.duration,
        thumbnailUrl: bestThumbnail(entry),
        plays: entry.view_count === undefined ? undefined : Math.floor(entry.view_count),
        platformGenre: entry.genres?.find((genre) => genre !== undefined) ?? entry.genre,
        description: entry.description,
      }),
      ...(tags.length > 0 ? { tags } : {}),
      ...(artists.length > 0 ? { artists } : {}),
    })
  }
  return candidates
}

/**
 * The public page of a result, which a download classifies again: a YouTube video by its id (the
 * search's `url` may be a shorts link), a SoundCloud track's `webpage_url` (its `url` is the API's).
 */
function pageUrl(platform: RemixPlatform, id: string, url: string | undefined): string | undefined {
  if (platform === 'youtube') {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || url?.includes('/shorts/')) return undefined
    return `https://www.youtube.com/watch?v=${id}`
  }
  if (url === undefined) return undefined
  const classified = classifyUrl(url)
  return classified.ok && classified.kind === 'soundcloud_track' ? classified.url : undefined
}

/** At most `MAX_TRACK_TEXT_LENGTH` UTF-16 units, cut between code points. */
function clip(text: string): string
function clip(text: string | undefined): string | undefined
function clip(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= MAX_TRACK_TEXT_LENGTH) return text
  let cut = ''
  for (const point of text) {
    if (cut.length + point.length > MAX_TRACK_TEXT_LENGTH) break
    cut += point
  }
  return cut
}

/** Words that make an upload something other than a version to play: a cover, a live take, a re-upload. */
const NOT_A_VERSION = new Set([
  'live',
  'cover',
  'covers',
  'karaoke',
  'instrumental',
  'acapella',
  'acappella',
  'acoustic',
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
  'piano',
  'orchestral',
  'stripped',
  'unplugged',
  'mashup',
  'mashups',
  'megamix',
  'medley',
  'demo',
  'snippet',
  'preview',
])

/** Words that make a note someone's remix: "(Arty Remix)". */
const REMIX_WORDS = new Set([
  'remix',
  'rmx',
  'rework',
  'flip',
  'vip',
  'refix',
  'remake',
  'rerub',
  'dub',
])
/** Words that make a note a bootleg or someone's edit. */
const BOOTLEG_WORDS = new Set(['bootleg', 'edit'])
/** Words that make a note the artist's own longer version. */
const EXTENDED_WORDS = new Set(['extended', 'club'])
/** Edits that are the original itself: "Radio Edit", "Original Edit". */
const PLAIN_EDITS = new Set(['radio', 'original', 'single', 'album', 'clean', 'short', 'explicit'])
/** Words of a note that name no one. */
const GENERIC_WORDS = new Set([
  ...REMIX_WORDS,
  ...BOOTLEG_WORDS,
  ...EXTENDED_WORDS,
  ...PLAIN_EDITS,
  'mix',
  'version',
  'by',
  'the',
  'and',
  'x',
  'vs',
  'feat',
  'ft',
  'official',
  'video',
  'audio',
  'music',
  'visualizer',
  'visualiser',
  'lyric',
  'lyrics',
  'free',
  'download',
  'dl',
  'out',
  'now',
  'premiere',
  'exclusive',
  'unofficial',
  'unoficial',
  'new',
  'hq',
  'hd',
  '4k',
])

/** One note of a title: what kind of version it names, and who made it. */
type Version = { kind: RemixKind; remixer?: string; note: string[] }

/**
 * The version a result is, or undefined when it isn't one to suggest: it must last a track's length,
 * name every word of the song's title and one of its artists (in its title, channel or SoundCloud
 * artist field), name no cover, live take or re-upload, and carry a note naming a remix, bootleg,
 * edit or extended mix.
 */
export function versionOf(candidate: RemixCandidate, song: Song): Version | undefined {
  const { durationSec } = candidate
  if (
    durationSec === undefined ||
    durationSec < MIN_DURATION_SEC ||
    durationSec > MAX_DURATION_SEC
  ) {
    return undefined
  }
  const titleWords = words(candidate.title)
  // The song's name outside the notes: "Other Song (X 'Song' Remix)" is a remix of another song.
  const named = new Set(words(candidate.title.replace(BRACKETED, ' ')))
  if (!song.titleWords.every((word) => named.has(word))) return undefined
  if (song.artists.length > 0) {
    const elsewhere = [candidate.uploader ?? '', ...(candidate.artists ?? [])].map(words)
    const credited = song.artists.some(
      (artist) =>
        containsRun(titleWords, artist) || elsewhere.some((text) => containsRun(text, artist)),
    )
    if (!credited) return undefined
  }
  const own = new Set([...song.titleWords, ...song.artists.flat()])
  if (titleWords.some((word) => NOT_A_VERSION.has(word) && !own.has(word))) return undefined

  for (const note of notes(candidate.title)) {
    const version = noteVersion(note, song)
    if (version !== undefined) return version
  }
  // "Song Remix" without a note: a remix by no one named.
  const rest = titleWords.filter((word) => !own.has(word))
  if (rest.some((word) => REMIX_WORDS.has(word))) return { kind: 'remix', note: [] }
  return undefined
}

/** Text in brackets: `(…)`, `[…]`, `{…}`, `【…】`. */
const BRACKETED = /[([【{]([^)\]】}]*)[)\]】}]/g

/**
 * A title's notes: the text in brackets, then the parts between ` - `, ` | ` and ` // `, each also
 * split at ` / ` ("[ pyxl8 remix / bass house / 2026 ]").
 */
function notes(title: string): string[] {
  const bracketed = Array.from(title.matchAll(BRACKETED), (match) => match[1] ?? '')
  const rest = title.replace(BRACKETED, ' ')
  return [...bracketed, ...rest.split(/\s[-–—|]\s|\s\/\/\s|\|/)]
    .flatMap((part) => part.split(/\s\/\s/))
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function noteVersion(note: string, song: Song): Version | undefined {
  const noteWords = words(note)
  const has = (set: ReadonlySet<string>) => noteWords.some((word) => set.has(word))
  const remixer = remixerIn(note, song)
  const by = remixer === undefined ? {} : { remixer }
  if (has(REMIX_WORDS)) return { kind: 'remix', ...by, note: noteWords }
  if (noteWords.includes('bootleg')) return { kind: 'bootleg', ...by, note: noteWords }
  const longer =
    noteWords.includes('mix') || noteWords.includes('version') || noteWords.includes('edit')
  if (has(EXTENDED_WORDS) && longer) {
    // "Extended Mix", "Moby Club Mix": the artist's own; "X Club Mix" is X's remix.
    const theArtist =
      remixer === undefined || song.artists.some((artist) => sameWords(words(remixer), artist))
    return theArtist
      ? { kind: 'extended', note: noteWords }
      : { kind: 'remix', ...by, note: noteWords }
  }
  if (has(PLAIN_EDITS)) return undefined
  // "(X Edit)" is X's edit; "(Above & Beyond Mix)" a remix; "(Edit)" or "(Mix)" alone names no one.
  if (remixer === undefined) return undefined
  if (noteWords.includes('edit')) return { kind: 'bootleg', remixer, note: noteWords }
  if (noteWords.includes('mix')) return { kind: 'remix', remixer, note: noteWords }
  return undefined
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index])
}

/** A token between two names in a note: "Pola & Bryson", "NIE x Gilla", "Above and Beyond". */
const REMIXER_JOINER = /^(?:&|\+|x|vs\.?|and)$/i

/**
 * Who a note names, with the note's own spelling: its words that aren't generic ("Remix", "Free
 * DL"), a genre ("jungle"), a year, or the song's title. "Pola & Bryson Remix" → "Pola & Bryson".
 * The original artist named in their own VIP counts as a remixer too. A "by" credits who follows
 * it: "Edit Version Video by Moises JR" → "Moises JR".
 */
function remixerIn(note: string, song: Song): string | undefined {
  const credited = /\sby\s+(\S.*)$/i.exec(note)?.[1]
  return (credited === undefined ? undefined : namedIn(credited, song)) ?? namedIn(note, song)
}

function namedIn(note: string, song: Song): string | undefined {
  // The words of the phrase that named the genre: "Lofi Remix" names no one.
  const genreWords = new Set(genrePhrase(note)?.words ?? [])
  // A note that holds the song's name is the title itself ("Moby Porcelain Remix"): the artist
  // there is the song's credit, not the remixer.
  const credit = new Set(
    containsRun(words(note), song.titleWords)
      ? [...song.artists.flat(), ...words(song.artist ?? '')]
      : [],
  )
  const tokens = note.split(/\s+/).filter((token) => {
    // A joiner between two names: `normalize` reads `&` as "and", and "x", "vs" are generic.
    if (REMIXER_JOINER.test(token)) return true
    const tokenWords = words(token)
    return tokenWords.some(
      (word) =>
        !GENERIC_WORDS.has(word) &&
        !genreWords.has(word) &&
        !credit.has(word) &&
        !/^(?:19|20)\d\d$/.test(word) &&
        !song.titleWords.includes(word),
    )
  })
  // Joiners at either end name no one: "& Remix" → "".
  while (tokens.length > 0 && REMIXER_JOINER.test(tokens[0] ?? '')) tokens.shift()
  while (tokens.length > 0 && REMIXER_JOINER.test(tokens.at(-1) ?? '')) tokens.pop()
  const name = tokens
    .join(' ')
    .replace(/^by\s+/i, '')
    // "Torsten Stenzel's Remix" is Torsten Stenzel's, the same remix as "Torsten Stenzel Remix".
    .replace(/['’]s$/i, '')
    .trim()
  const count = words(name).length
  return count === 0 || count > MAX_REMIXER_WORDS ? undefined : name
}

const JOINERS = new Set(['and', 'x', 'vs'])

/** One group's key: the kind and who made it, else the note, else the upload itself. */
function groupKey(candidate: RemixCandidate, version: Version): string {
  if (version.remixer !== undefined) {
    // "A & B", "A, B" and "A and B" are one pair; their VIP is another track than their remix.
    const name = words(version.remixer).filter((word) => !JOINERS.has(word))
    const vip = version.note.includes('vip') ? ':vip' : ''
    // Their extended mix is another file than their remix's short edit: a DJ downloads the longer.
    const extended = version.note.some((word) => EXTENDED_WORDS.has(word)) ? ':extended' : ''
    return `${version.kind}${vip}${extended}:${name.join(' ')}`
  }
  if (version.kind === 'extended') return `extended:${version.note.join(' ')}`
  return `${candidate.platform}:${candidate.id}`
}

export type RemixFound = {
  suggestions: RemixSuggestion[]
  /** The results that were a version of the song, per platform, before grouping. */
  found: Record<RemixPlatform, number>
}

/**
 * The suggestions for `song` from each platform's results: versions only, `exclude` (the pasted
 * track) left out, one suggestion per version with its uploads most played first, then the
 * suggestions most played first (ties keep the search's order, YouTube's first).
 */
export function suggestRemixes(
  song: Song,
  results: Partial<Record<RemixPlatform, readonly RemixCandidate[]>>,
  exclude?: { platform: string; id: string },
): RemixFound {
  const found: Record<RemixPlatform, number> = { youtube: 0, soundcloud: 0 }
  const ignore = [...song.titleWords, ...song.artists.flat()]
  type Group = {
    uploads: RemixCandidate[]
    versions: Version[]
  }
  const groups = new Map<string, Group>()
  const seen = new Set<string>()
  for (const platform of ['youtube', 'soundcloud'] as const) {
    for (const candidate of results[platform] ?? []) {
      const id = `${candidate.platform}:${candidate.id}`
      if (seen.has(id)) continue
      seen.add(id)
      if (
        exclude !== undefined &&
        exclude.platform === candidate.platform &&
        exclude.id === candidate.id
      )
        continue
      const version = versionOf(candidate, song)
      if (version === undefined) continue
      found[platform]++
      const key = groupKey(candidate, version)
      const group = groups.get(key) ?? { uploads: [], versions: [] }
      group.uploads.push(candidate)
      group.versions.push(version)
      groups.set(key, group)
    }
  }

  const suggestions = Array.from(groups.values(), ({ uploads, versions }) => {
    const order = uploads.map((_, index) => index).sort((a, b) => byPlays(uploads[a], uploads[b]))
    const sorted = order.map((index) => uploads[index] as RemixCandidate)
    const remixer = order
      .map((index) => versions[index]?.remixer)
      .find((name) => name !== undefined)
    const kind = (versions[order[0] ?? 0] as Version).kind
    const genres = sorted.map((upload) =>
      uploadGenre(
        {
          title: upload.title,
          ...omitUndefined({
            platformGenre: upload.platformGenre,
            tags: upload.tags,
            description: upload.description,
          }),
        },
        ignore,
      ),
    )
    const genre =
      genres.find((found) => found?.source === 'platform') ??
      genres.find((found) => found !== undefined)
    const plays = sorted[0]?.plays
    return {
      kind,
      ...(remixer === undefined ? {} : { remixer }),
      ...(genre === undefined ? {} : { genre }),
      ...(plays === undefined ? {} : { plays }),
      uploads: sorted.slice(0, MAX_REMIX_UPLOADS).map(toUpload),
    } satisfies RemixSuggestion
  })
  // Array sort is stable: equal plays keep the order the versions were found in.
  suggestions.sort((a, b) => byPlays(a, b))
  return { suggestions: suggestions.slice(0, MAX_REMIX_SUGGESTIONS), found }
}

/** Most plays first; unknown plays last. */
function byPlays(a: { plays?: number } | undefined, b: { plays?: number } | undefined): number {
  return (b?.plays ?? -1) - (a?.plays ?? -1)
}

/** The contract's fields of a candidate: the search's genre clues stay on the server. */
function toUpload({
  platform,
  id,
  url,
  title,
  uploader,
  durationSec,
  thumbnailUrl,
  plays,
}: RemixCandidate): RemixUpload {
  return {
    platform,
    id,
    url,
    title,
    ...omitUndefined({ uploader, durationSec, thumbnailUrl, plays }),
  }
}
