import { createHash } from 'node:crypto'
import type { Platform } from '@dj-scraper/shared'

/**
 * Pure decisions of the preview cache (ADR-029): the id of an upload, what a stream's extension
 * says it is, which cached files go when the cache is full, and what a `Range` header asks for.
 */

/** At most this many files stay in the cache, and this many bytes between them. */
export const PREVIEW_CACHE_MAX_FILES = 20
export const PREVIEW_CACHE_MAX_BYTES = 400 * 1024 * 1024
/** No preview is bigger than `--max-filesize` says (HLS ignores that option, so it is checked too). */
export const PREVIEW_MAX_BYTES = 200 * 1024 * 1024

/** The first 32 hex characters of sha256(`<platform>:<track id>`). */
export function previewId(platform: Platform, trackId: string): string {
  return createHash('sha256').update(`${platform}:${trackId}`).digest('hex').slice(0, 32)
}

/** The streams a browser's `<audio>` plays, by file extension. Anything else is refused. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
}
export const PREVIEW_EXTENSIONS: readonly string[] = Object.keys(MIME_BY_EXTENSION)

/** The Content-Type of a cached stream, or undefined when its extension isn't one we serve. */
export function previewMime(extension: string): string | undefined {
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : undefined
}

/** `<id>.<ext>`: the name of a cached file, as the store writes it. */
const CACHED_NAME = /^([0-9a-f]{32})\.([a-z0-9]{1,8})$/

/** The id and extension a cache file name holds; undefined for anything that isn't ours. */
export function parseCachedName(name: string): { id: string; extension: string } | undefined {
  const match = CACHED_NAME.exec(name)
  const id = match?.[1]
  const extension = match?.[2]
  if (id === undefined || extension === undefined || previewMime(extension) === undefined) {
    return undefined
  }
  return { id, extension }
}

export type CachedFile = { name: string; size: number; mtimeMs: number }

/**
 * The files to delete so the cache holds at most `maxFiles` files and `maxBytes` bytes: the least
 * recently used first (oldest mtime; ties by name). `keep` (the file just made) is never chosen.
 */
export function planEviction(
  files: readonly CachedFile[],
  limits: { maxFiles: number; maxBytes: number },
  keep?: string,
): string[] {
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  let count = ordered.length
  let bytes = ordered.reduce((sum, file) => sum + file.size, 0)
  const doomed: string[] = []
  for (const file of ordered) {
    if (count <= limits.maxFiles && bytes <= limits.maxBytes) break
    if (file.name === keep) continue
    doomed.push(file.name)
    count--
    bytes -= file.size
  }
  return doomed
}

export type ByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/**
 * A single `Range: bytes=…` header against a file of `size` bytes (RFC 9110 §14): `a-b`, `a-` (to
 * the end) and `-n` (the last n bytes); an end past the file is cut to it. A header that isn't a
 * single bytes range (another unit, several ranges, garbage) is ignored, which answers the whole
 * file; a start past the end, or `-0`, is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined || size <= 0) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { kind: 'full' }
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return { kind: 'full' }
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }
  if (last === '') return { kind: 'partial', start, end: size - 1 }
  const end = Number(last)
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'full' }
  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}
