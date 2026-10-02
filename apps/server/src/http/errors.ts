import type { ApiErrorBody, ErrorCode } from '@dj-scraper/shared'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** HTTP status per error code. Total on purpose: a new ErrorCode doesn't compile until mapped. */
export const ERROR_STATUS = {
  invalid_url: 400,
  unsupported_url: 422,
  unavailable: 422,
  private: 422,
  geo_blocked: 422,
  age_restricted: 422,
  login_required: 422,
  bot_check: 422,
  preview_only: 422,
  rate_limited: 429,
  network: 502,
  engine_missing: 503,
  postprocess_failed: 500,
  canceled: 409,
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  unknown: 500,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>

/** Throw from routes and services; `onError` turns it into `{ error: { code, message } }`. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export const errorResponse = (
  c: Context,
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode = ERROR_STATUS[code],
) => c.json({ error: { code, message } } satisfies ApiErrorBody, status)

export const onError: ErrorHandler = (error, c) => {
  if (error instanceof ApiError) return errorResponse(c, error.code, error.message)
  // Hono's own middleware (e.g. bodyLimit) throws HTTPException: keep its status, use our body.
  if (error instanceof HTTPException && error.status < 500) {
    return errorResponse(c, 'invalid_request', error.message || 'Bad request', error.status)
  }
  console.error(`[server] ${c.req.method} ${c.req.path} failed:`, error)
  return errorResponse(c, 'unknown', 'Internal server error')
}

export const onNotFound: NotFoundHandler = (c) => errorResponse(c, 'not_found', 'Not found')
