// Optional fields, as the contract wants them: omitted, never present with `undefined`, and a value
// a tool reported in a shape we don't expect counts as missing.
import type * as z from 'zod'

/**
 * A field of a tool's JSON (yt-dlp, ffprobe) read tolerantly: a value the schema rejects becomes
 * undefined instead of failing the whole document.
 */
export const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

/**
 * `value` without its undefined fields. Every field comes back optional: spread the result next to
 * the fields that are always there, e.g. `{ id, ...omitUndefined({ title, artist }) }`.
 */
export function omitUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key in value) {
    if (Object.hasOwn(value, key) && value[key] !== undefined) result[key] = value[key]
  }
  return result
}
