import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type * as z from 'zod'
import { ApiError } from './errors.ts'

/** Our JSON requests are a URL or a screenful of row refs; anything bigger is a mistake or abuse. */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024

/** At most this many Zod issues go into the 400 message; the rest are counted. */
const MAX_ISSUES_SHOWN = 3

/**
 * Mount before `readJson` on JSON routes. Over the limit, Hono throws an HTTPException 413, which
 * `onError` answers as `invalid_request` with this status.
 */
export const jsonBodyLimit: MiddlewareHandler = bodyLimit({
  maxSize: JSON_BODY_LIMIT_BYTES,
  onError: () => {
    throw new HTTPException(413, {
      message: `The request body is larger than ${JSON_BODY_LIMIT_BYTES / 1024} KiB`,
    })
  },
})

/**
 * Reads the body as JSON and validates it with a shared schema; returns the parsed output (defaults
 * applied). Malformed JSON, a body that isn't an object, or a failed check → 400 `invalid_request`.
 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  // jsonBodyLimit has already enforced the size. Parse separately so malformed JSON maps to
  // invalid_request.
  const text = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError('invalid_request', 'The request body must be JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('invalid_request', 'The request body must be a JSON object')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new ApiError('invalid_request', describeIssues(parsed.error.issues))
  return parsed.data
}

/** `entries[0].url: Invalid URL; mode: Invalid option…`: short enough for a toast. */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => {
    const at = formatPath(issue.path)
    return at === '' ? issue.message : `${at}: ${issue.message}`
  })
  const more = issues.length - shown.length
  return more > 0 ? `${shown.join('; ')} (and ${more} more)` : shown.join('; ')
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`
    else out += out === '' ? String(key) : `.${String(key)}`
  }
  return out
}
