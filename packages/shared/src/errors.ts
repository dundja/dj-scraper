import * as z from 'zod'

export const ErrorCodeSchema = z.enum([
  'invalid_url',
  'unsupported_url',
  'unavailable',
  'private',
  'geo_blocked',
  'age_restricted',
  'login_required',
  'bot_check',
  'rate_limited',
  'preview_only',
  'network',
  'engine_missing',
  'postprocess_failed',
  'canceled',
  'invalid_request',
  'forbidden',
  'not_found',
  'unknown',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

/** A failure as the user sees it. Reused by API errors and, later, jobs. */
export const ErrorInfoSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
})
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>

/** Body of every API error response, sent with a matching HTTP status. */
export const ApiErrorBodySchema = z.object({
  error: ErrorInfoSchema,
})
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>
