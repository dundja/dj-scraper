import { FILENAME_PLACEHOLDERS, type FilenamePlaceholder } from './download.ts'

/**
 * Pure: a filename template + a track's fields → one safe file name (design D13). The rules suit
 * macOS, Windows and the FAT/exFAT USB sticks CDJs read: no path separators or reserved characters,
 * no hidden or reserved names, and a length every one of them accepts.
 */

/** The longest name we write, extension included, in UTF-16 units (the volumes allow 255). */
export const MAX_FILENAME_LENGTH = 180
/** HFS+ counts the decomposed (NFD) form against its 255-unit limit. */
const MAX_NFD_LENGTH = 255
/** Our muxer table's extensions; never one from the title or from yt-dlp. */
const EXTENSION = /^[a-z0-9]{1,5}$/

const PLACEHOLDER = /\{([^{}]*)\}/g
const KNOWN_PLACEHOLDERS: readonly string[] = FILENAME_PLACEHOLDERS
const isPlaceholder = (name: string): name is FilenamePlaceholder =>
  KNOWN_PLACEHOLDERS.includes(name)
/**
 * One separator: a dash with whitespace on both sides (or an end of the text on one), an
 * underscore or a comma. Dashes inside words ("Jay-Z", "-5 dB") are not separators.
 */
const SEPARATOR = String.raw`(?:(?<=^|\s)[-–—](?=\s|$)|[_,])`
const SEPARATOR_RUN = new RegExp(String.raw`\s*${SEPARATOR}(?:\s*${SEPARATOR})*\s*`, 'gu')
const SEPARATOR_CHAR = /[-–—_,]/u
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g
const OPENING = new Set(['(', '['])
const CLOSING = new Set([')', ']'])

/**
 * Renders `template` (already valid: see `filenameTemplateProblem`) with the known fields; an
 * unknown field renders empty. Then cleans what the empty ones leave behind: runs of separators
 * (` - `, ` – `, ` — `, `_`, `,`) become their first one, runs at either end or just inside a
 * bracket go (underscores inside brackets stay: `[{id}]` with a YouTube id like `_x0…`), and empty
 * `()` and `[]` go. `{artist} - {title} ({year})` without a year → `Artist - Title`. Returns `''`
 * when nothing is left; `sanitizeFilename` then uses its fallback.
 */
export function renderFilename(
  template: string,
  fields: Partial<Record<FilenamePlaceholder, string>>,
): string {
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) =>
    isPlaceholder(name) ? (fields[name] ?? '') : '',
  )
  let current = rendered.replace(/\s+/gu, ' ').trim()
  for (;;) {
    const next = current
      .replace(SEPARATOR_RUN, collapseSeparators)
      .replace(EMPTY_BRACKETS, '')
      .replace(/\s+/gu, ' ')
      .trim()
    if (next === current) return next
    current = next
  }
}

function collapseSeparators(run: string, offset: number, text: string): string {
  const before = text[offset - 1]
  const after = text[offset + run.length]
  if (before === undefined || after === undefined) return ''
  const first = SEPARATOR_CHAR.exec(run)?.[0] ?? ''
  if (first !== '_' && (OPENING.has(before) || CLOSING.has(after))) return ''
  // A comma hugs the word before it.
  const lead = first !== ',' && /^\s/u.test(run) ? ' ' : ''
  const trail = /\s$/u.test(run) ? ' ' : ''
  return `${lead}${first}${trail}`
}

/**
 * `base` + `.ext` as a safe single file name, at most `MAX_FILENAME_LENGTH` UTF-16 units, 255 NFD
 * units and `maxBytes` UTF-8 bytes (what the folder's path leaves of the volume's path limit: a CJK
 * character is 3 bytes); `fallback` (e.g. `youtube-<id>`) when nothing usable is left of `base`.
 * `ext` must be 1-5 lowercase letters or digits, and `maxBytes` must leave room for it and one
 * character. The extension is appended after truncating, so it is never cut.
 */
export function sanitizeFilename(
  base: string,
  ext: string,
  fallback: string,
  maxBytes = Number.POSITIVE_INFINITY,
): string {
  if (!EXTENSION.test(ext)) throw new Error('Invalid file extension')
  const suffix = `.${ext}`
  if (!(maxBytes > suffix.length)) throw new RangeError('No room for a file name')
  const limit = { suffix, maxBytes }
  const name =
    sanitizeName(base, limit) || sanitizeName(fallback, limit) || sanitizeName('Untitled', limit)
  return `${name}${suffix}`
}

/**
 * A subfolder name (e.g. a playlist title) made safe like a file name, without an extension; always
 * one path component. Undefined when nothing usable is left.
 */
export function sanitizeFolderName(name: string): string | undefined {
  const safe = sanitizeName(name, { suffix: '', maxBytes: Number.POSITIVE_INFINITY })
  return safe === '' || safe === '.' || safe === '..' ? undefined : safe
}

/** What a name must fit with: the suffix that follows it, and the most UTF-8 bytes of both. */
type Limit = { suffix: string; maxBytes: number }

/** Controls separate words (a newline in a title): they become spaces. */
const CONTROLS = /\p{Cc}/gu
/**
 * Private use (incl. the SFM characters macOS maps `:` and friends to on FAT), lone surrogates,
 * and invisible format characters (bidi overrides, zero-width space, BOM) are removed. ZWNJ/ZWJ
 * (emoji sequences) and tag characters (subdivision flags such as Scotland's) stay.
 */
const INVISIBLE = /[\p{Co}\p{Cs}]|(?!\u{200c}|\u{200d}|[\u{E0020}-\u{E007F}])\p{Cf}/gu
/** Windows device names, also with an extension (`NUL.tar.gz`); COM0, LPT0 and CONIN$/CONOUT$ to be safe. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/iu
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** The safe name without the suffix, or `''`. */
function sanitizeName(base: string, limit: Limit): string {
  const mapped = base
    .normalize('NFC')
    .replace(CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s*:\s+/gu, ' - ')
    .replace(/[/\\|:]/g, '-')
    .replace(/"/g, "'")
    .replace(/[<>?*]/g, '')
    .replace(/\s+/gu, ' ')
    // Removing a character can leave a combining mark next to its base.
    .normalize('NFC')
  return fitName(mapped, limit)
}

function fitName(text: string, limit: Limit): string {
  let name = trimEdges(text)
  if (name === '') return ''
  if (RESERVED.test((name.split('.')[0] ?? '').trimEnd())) name = `_${name}`
  if (fits(name, limit)) return name
  // Truncating shortens it for good, and re-trimming may leave a reserved name: check again.
  return fitName(truncate(name, limit), limit)
}

/** Leading dots hide a file on macOS (and look like `._` sidecars); Windows drops trailing ones. */
function trimEdges(text: string): string {
  return text.replace(/^[\s.]+/u, '').replace(/[\s.\-–—]+$/u, '')
}

function fits(name: string, { suffix, maxBytes }: Limit): boolean {
  const full = `${name}${suffix}`
  return (
    full.length <= MAX_FILENAME_LENGTH &&
    full.normalize('NFD').length <= MAX_NFD_LENGTH &&
    utf8Length(full) <= maxBytes
  )
}

/** The longest prefix of whole graphemes (emoji, flags and accents never split) that fits. */
function truncate(name: string, limit: Limit): string {
  let kept = ''
  for (const { segment } of segmenter.segment(name)) {
    if (!fits(`${kept}${segment}`, limit)) break
    kept += segment
  }
  return kept
}

/** UTF-8 length counted by hand (no TextEncoder here); a lone surrogate counts as U+FFFD. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
