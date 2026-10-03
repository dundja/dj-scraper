import { MAX_URL_LENGTH } from '@dj-scraper/shared'

/**
 * Typographic punctuation that closes around a link and never belongs to one: smart quotes ‘’‚‛“”„‟
 * (macOS types them), the ellipsis …, guillemets «»‹›, and CJK and full-width punctuation such as
 * 。、「」（），, which needs no space before the next word. Letters of any script aren't in it.
 */
const TYPOGRAPHIC_PUNCTUATION = String.raw`\u2018-\u201f\u2026\u00ab\u00bb\u2039\u203a\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65`
/** Characters a link runs on: not whitespace, what URLs never hold unescaped, or the above. */
const LINK_BODY = String.raw`[^\s<>"'\x60{}|\\^${TYPOGRAPHIC_PUNCTUATION}]`
/** An http(s) link anywhere in the text. */
const HTTP_LINK = new RegExp(`https?://${LINK_BODY}+`, 'i')
/**
 * A link without its scheme (`youtu.be/…`, `soundcloud.com/…`): a dotted host name, then a path.
 * The path is required, so a word like "e.g." or a file name doesn't count.
 */
const SCHEMELESS_LINK = new RegExp(
  String.raw`(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/${LINK_BODY}*`,
  'i',
)
/** Punctuation that closes the sentence around a link rather than the link itself. */
const SENTENCE_END = new Set(['.', ',', ';', ':', '!', '?'])
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[' }

/**
 * The first link in pasted or dropped text, e.g. from "listen: https://youtu.be/… (so good)". An
 * http(s) link wins over a scheme-less one. Trailing punctuation and an unbalanced closing bracket
 * (a link in parentheses or a Markdown link) are left out. Undefined when the text has no link.
 */
export function findLink(text: string): string | undefined {
  const match = HTTP_LINK.exec(text) ?? SCHEMELESS_LINK.exec(text)
  return match === null ? undefined : clip(trimLinkEnd(match[0]))
}

/**
 * What a paste loads: its first link, else its first non-blank line (so the paste box can say
 * why that isn't a link). Undefined for blank text.
 */
export function pasteCandidate(text: string): string | undefined {
  return findLink(text) ?? firstLine(text)
}

/**
 * The link a drop carries: the first entry of a `text/uri-list` (lines starting with # are
 * comments), else the first link in its `text/plain`. Undefined for text without a link.
 */
export function dropLink(data: Pick<DataTransfer, 'getData'>): string | undefined {
  const uri = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'))
  return uri === undefined ? findLink(data.getData('text/plain')) : clip(uri)
}

/** What a drop loads: its link, else its text's first line the way a paste reads it. */
export function dropCandidate(data: Pick<DataTransfer, 'getData'>): string | undefined {
  return dropLink(data) ?? firstLine(data.getData('text/plain'))
}

/**
 * Whether a drag may carry a link: text or a URI list, and no files (see `carriesFiles`). Its
 * data can only be read on drop, so this goes by the types.
 */
export function carriesLink(types: readonly string[]): boolean {
  return !carriesFiles(types) && (types.includes('text/uri-list') || types.includes('text/plain'))
}

/**
 * Whether a drag carries files (from Finder). The page takes none, and the browser would open a
 * file dropped on it in place of the app.
 */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes('Files')
}

/** Input types that take typed text, where a paste belongs to the field. */
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
])

/**
 * Whether a paste or keystroke at `target` goes into a text field the user is editing (another
 * input, a textarea, rich text), so a page-wide paste handler should leave it alone. Read-only and
 * disabled fields don't count: a paste there would do nothing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled
  }
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '')
  return line === undefined ? undefined : clip(line)
}

/**
 * Pasted text can be huge. One character past the longest URL the server takes keeps the input
 * small and still too long, so the paste box says so.
 */
function clip(text: string): string {
  return text.length > MAX_URL_LENGTH ? text.slice(0, MAX_URL_LENGTH + 1) : text
}

function trimLinkEnd(link: string): string {
  let end = link.length
  while (end > 0) {
    const last = link.charAt(end - 1)
    const opening = CLOSING_BRACKETS[last]
    if (SENTENCE_END.has(last)) {
      end -= 1
    } else if (opening !== undefined && count(link, last, end) > count(link, opening, end)) {
      end -= 1
    } else {
      break
    }
  }
  return link.slice(0, end)
}

function count(text: string, character: string, end: number): number {
  let total = 0
  for (let index = 0; index < end; index += 1) if (text[index] === character) total += 1
  return total
}
