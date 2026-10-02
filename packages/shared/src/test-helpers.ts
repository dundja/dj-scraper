// Test-only helpers for the schema tests. Not exported from index.ts; never import from runtime code.
import type * as z from 'zod'

/** Paths of the issues a failed parse reports; empty when the parse succeeds. */
export function issuePaths(schema: z.ZodType, input: unknown): PropertyKey[][] {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path)
}

/** A shallow copy of `value` without `key`. */
export function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))
}

/** The keys of `T` that may be omitted. */
export type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

/** Values every URL field must reject: script, local-file and non-http schemes, a relative path. */
export const nonHttpUrls = [
  'javascript:alert(document.cookie)',
  'file:///Users/dj/Music/',
  'ftp://ftp.example.com/track.mp3',
  '/watch?v=dQw4w9WgXcQ',
]
