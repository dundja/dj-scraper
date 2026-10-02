/**
 * A hyphen, en dash or em dash with whitespace on both sides, so hyphenated names ("Jay-Z",
 * "Lo-Fi Dub") never split.
 */
const SEPARATOR = /\s[-–—]\s/

/** A left side that is only a track number, as in "01 - Intro". */
const TRACK_NUMBER = /^\d+$/

/**
 * Splits an "Artist - Title" upload title at its FIRST dash, so "Artist - Title - Extended Mix"
 * keeps the mix name in the title (yt-dlp's `--parse-metadata` recipe splits at the last dash).
 * Undefined when there is no dash with spaces around it, a side is empty, or the left side is only
 * a track number. Used when the platform reports no artist: by the server's normalizer, and later
 * by finalize.
 */
export function splitArtistTitle(title: string): { artist: string; title: string } | undefined {
  const separator = SEPARATOR.exec(title)
  if (separator === null) return undefined
  const artist = title.slice(0, separator.index).trim()
  const rest = title.slice(separator.index + separator[0].length).trim()
  if (artist === '' || rest === '' || TRACK_NUMBER.test(artist)) return undefined
  return { artist, title: rest }
}
