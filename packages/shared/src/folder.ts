import * as z from 'zod'

/**
 * The longest folder path the API accepts, in UTF-16 units. macOS limits a whole path to 1024 bytes,
 * so the server also checks the byte budget of the folder plus the longest file name it may write.
 */
export const MAX_PATH_LENGTH = 1024

/**
 * Pure: a typed or picked folder → the form the API accepts, or undefined when it can't be one.
 * Only absolute POSIX paths: no `~`, no `.`, `..` or empty segments, no C0/C1 control characters. One
 * trailing slash is dropped, because the macOS folder picker returns `/Volumes/USB/`; the root stays
 * `/`. The server still resolves the real path and checks that it is a writable folder.
 */
export function normalizeFolderPath(input: string): string | undefined {
  if (!input.startsWith('/')) return undefined
  for (let i = 0; i < input.length; i++) {
    if (isControl(input.charCodeAt(i))) return undefined
  }
  if (input === '/') return input
  const path = input.endsWith('/') ? input.slice(0, -1) : input
  if (path.length > MAX_PATH_LENGTH) return undefined
  const segments = path.slice(1).split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }
  return path
}

/** C0 and C1 control characters and DEL: never part of a folder or file name we accept. */
export const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f)

/** A folder path already in `normalizeFolderPath` form. Normalize user input before sending it. */
export const FolderPathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .refine((path) => normalizeFolderPath(path) === path, {
    message: 'Must be an absolute folder path without ~, . or .. segments, or a trailing slash',
  })
export type FolderPath = z.infer<typeof FolderPathSchema>
