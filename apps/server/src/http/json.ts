import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type * as z from 'zod'
import { ApiError } from './errors.ts'

/** Our JSON requests are a URL or a screenful of row refs; anything bigger is a mistake or abuse. */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024

/** At most this many Zod issues go into the 400 message; the rest are counted. */
const MAX_ISSUES_SHOWN = 3

const KIB = 1024
const MIB = 1024 * KIB

/** `8 MiB`, `64 KiB` or `100 bytes`: the largest unit that divides the limit exactly. */
function formatLimit(bytes: number): string {
  if (bytes % MIB === 0) return `${bytes / MIB} MiB`
  if (bytes % KIB === 0) return `${bytes / KIB} KiB`
  return `${bytes} bytes`
}

/**
 * A body size limit for JSON routes; mount it before `readJson`. Over `maxBytes`, Hono throws an
 * HTTPException 413, which `onError` answers as `invalid_request` with this status and a message
 * naming the limit. Chunked bodies are cut off once they pass it.
 */
export function jsonBodyLimitOf(maxBytes: number): MiddlewareHandler {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`A body limit must be a positive whole number of bytes, not ${maxBytes}`)
  }
  const message = `The request body is larger than ${formatLimit(maxBytes)}`
  return bodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw new HTTPException(413, { message })
    },
  })
}

/** The limit for the routes whose bodies are small: JSON_BODY_LIMIT_BYTES (64 KiB). */
export const jsonBodyLimit: MiddlewareHandler = jsonBodyLimitOf(JSON_BODY_LIMIT_BYTES)

/**
 * Reads the body as JSON and validates it with a shared schema; returns the parsed output (defaults
 * applied). Malformed JSON, a body that isn't an object, or a failed check → 400 `invalid_request`.
 */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  // jsonBodyLimit(Of) has already enforced the size. Parse separately so malformed JSON maps to
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
