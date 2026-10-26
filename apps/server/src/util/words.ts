// Word matching for names and titles: the Spotify matcher (ADR-026) and remix suggestions (ADR-027).

/** Lowercase, accents and punctuation gone, `&` as `and`: "ADÉLA" and "adela" are one name. */
export function normalize(text: string): string {
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
export function words(text: string): string[] {
  return normalize(text)
    .split(' ')
    .flatMap((word) => word.split(/-+/))
    .filter((word) => word !== '')
}

/** Whether `haystack` holds `needle` as consecutive words. */
export function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, i) => haystack[start + i] === word)) return true
  }
  return false
}
