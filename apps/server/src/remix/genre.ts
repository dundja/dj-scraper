import { containsRun, words } from '../util/words.ts'

/**
 * Pure: the genre a remix's own words name (ADR-027). No lookup and no guessing beyond the words:
 * SoundCloud's genre field, then the title, the tags and the description, matched against a fixed
 * list of the genres DJs sort by. A text that names none gets none.
 */

type Genre = { name: string; aliases: string[] }

/**
 * Each genre's display name and the phrases that name it (the name itself included). When a text
 * names several, the longest phrase wins: "melodic techno" over "techno", "afro house" over "house".
 */
const GENRES: readonly Genre[] = [
  { name: 'Melodic House & Techno', aliases: ['melodic house and techno', 'melodic house techno'] },
  { name: 'Afro House', aliases: ['afro house', 'afrohouse'] },
  { name: 'Afro Tech', aliases: ['afro tech', 'afrotech'] },
  { name: 'Amapiano', aliases: ['amapiano', 'piano amapiano'] },
  { name: 'Organic House', aliases: ['organic house', 'organic downtempo'] },
  { name: 'Melodic House', aliases: ['melodic house'] },
  { name: 'Melodic Techno', aliases: ['melodic techno'] },
  { name: 'Hard Techno', aliases: ['hard techno', 'hardtechno'] },
  { name: 'Peak Time Techno', aliases: ['peak time techno', 'peak time', 'peaktime'] },
  { name: 'Minimal', aliases: ['minimal', 'minimal techno', 'minimal deep tech', 'deep tech'] },
  { name: 'Techno', aliases: ['techno'] },
  { name: 'Tech House', aliases: ['tech house', 'techhouse'] },
  { name: 'Deep House', aliases: ['deep house', 'deephouse'] },
  { name: 'Progressive House', aliases: ['progressive house', 'progressive'] },
  { name: 'Bass House', aliases: ['bass house'] },
  { name: 'Future House', aliases: ['future house'] },
  { name: 'Electro House', aliases: ['electro house', 'electro'] },
  { name: 'Big Room', aliases: ['big room', 'bigroom'] },
  { name: 'Latin House', aliases: ['latin house'] },
  { name: 'Funky House', aliases: ['funky house'] },
  { name: 'Jackin House', aliases: ['jackin house', 'jacking house'] },
  { name: 'Slap House', aliases: ['slap house', 'brazilian bass'] },
  { name: 'Indie Dance', aliases: ['indie dance', 'dark disco'] },
  { name: 'Nu Disco', aliases: ['nu disco', 'nudisco', 'disco'] },
  { name: 'House', aliases: ['house', 'house music'] },
  { name: 'Drum & Bass', aliases: ['drum and bass', 'drum n bass', 'dnb', 'd and b', 'dandb'] },
  { name: 'Liquid DnB', aliases: ['liquid dnb', 'liquid drum and bass', 'liquid funk'] },
  { name: 'Jungle', aliases: ['jungle'] },
  { name: 'Dubstep', aliases: ['dubstep'] },
  { name: 'Breaks', aliases: ['breaks', 'breakbeat'] },
  { name: 'UK Garage', aliases: ['uk garage', 'ukg', 'garage', 'speed garage', '2 step', '2step'] },
  { name: 'Trance', aliases: ['trance', 'uplifting trance', 'vocal trance'] },
  { name: 'Psytrance', aliases: ['psytrance', 'psy trance', 'psy'] },
  { name: 'Hardstyle', aliases: ['hardstyle'] },
  { name: 'Hardcore', aliases: ['hardcore', 'gabber'] },
  { name: 'Trap', aliases: ['trap'] },
  { name: 'Future Bass', aliases: ['future bass'] },
  { name: 'Jersey Club', aliases: ['jersey club'] },
  { name: 'Baile Funk', aliases: ['baile funk', 'funk carioca'] },
  { name: 'Moombahton', aliases: ['moombahton'] },
  { name: 'Reggaeton', aliases: ['reggaeton'] },
  { name: 'Dancehall', aliases: ['dancehall'] },
  { name: 'Downtempo', aliases: ['downtempo', 'chillout', 'chill out'] },
  { name: 'Lo-Fi', aliases: ['lofi', 'lo fi'] },
  { name: 'Synthwave', aliases: ['synthwave', 'retrowave'] },
]

/** Each alias as words, longest first, so the first one found is the most specific. */
const ALIASES: readonly { words: string[]; name: string }[] = GENRES.flatMap(({ name, aliases }) =>
  aliases.map((alias) => ({ words: words(alias), name })),
).sort((a, b) => b.words.length - a.words.length)

/**
 * Single words that are a genre in a title ("Song (Jungle Remix)") but often something else in
 * prose ("a minimal video", "house party"): a description must name these genres in more words.
 */
const PROSE_WORDS = new Set([
  'minimal',
  'progressive',
  'electro',
  'garage',
  'disco',
  'house',
  'trap',
  'breaks',
  'psy',
  'jungle',
  'hardcore',
  'chillout',
])

/** Every genre name, for tests and the docs. */
export const GENRE_NAMES: readonly string[] = GENRES.map(({ name }) => name)

/**
 * The most specific genre a text names, or undefined. Phrases that the song's own title or artist
 * hold are ignored (`ignore`): "Techno Party" by someone names no genre. `prose` (a description)
 * skips the single words that prose uses for other things.
 */
export function genreIn(
  text: string | undefined,
  ignore: readonly string[] = [],
  options: { prose?: boolean } = {},
): string | undefined {
  return genrePhrase(text, ignore, options)?.name
}

/**
 * `genreIn`, with the words of the phrase that named the genre: "lofi" names Lo-Fi, "dnb" Drum &
 * Bass. A remixer's name drops these words, not the genre's display name's.
 */
export function genrePhrase(
  text: string | undefined,
  ignore: readonly string[] = [],
  { prose = false }: { prose?: boolean } = {},
): { name: string; words: readonly string[] } | undefined {
  if (text === undefined) return undefined
  const textWords = words(text)
  for (const alias of ALIASES) {
    if (prose && alias.words.length === 1 && PROSE_WORDS.has(alias.words[0] ?? '')) continue
    if (containsRun(textWords, alias.words) && !containsRun(ignore, alias.words)) return alias
  }
  return undefined
}

/** What a search result says about its genre. */
export type GenreClues = {
  /** SoundCloud's genre field, set by the uploader. */
  platformGenre?: string
  title: string
  tags?: readonly string[]
  description?: string
}

/**
 * An upload's genre: SoundCloud's own field when it names a genre on the list (`platform`), else the
 * first of the title, the tags and the description that names one (`text`). A field such as
 * "Electronic" or "Dance & EDM" names none, so a title's "afro house remix" can still tell.
 */
export function uploadGenre(
  clues: GenreClues,
  ignore: readonly string[],
): { name: string; source: 'platform' | 'text' } | undefined {
  const platform = genreIn(clues.platformGenre, ignore)
  if (platform !== undefined) return { name: platform, source: 'platform' }
  for (const text of [clues.title, ...(clues.tags ?? [])]) {
    const name = genreIn(text, ignore)
    if (name !== undefined) return { name, source: 'text' }
  }
  const described = genreIn(clues.description, ignore, { prose: true })
  return described === undefined ? undefined : { name: described, source: 'text' }
}
