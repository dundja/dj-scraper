import type { ErrorCode, UnavailableReason } from '@dj-scraper/shared'
import { CancelledError } from '@tanstack/react-query'
import { startCommand } from '@/features/engine/start-command.ts'
import { ApiError } from '@/lib/api.ts'

const SIGN_INS_LATER = 'DJ Scraper has no sign-ins yet; they come in a later version.'

/**
 * A short next step per error code, shown under the server's message (which already says what went
 * wrong, and sometimes how to fix it: "… Run `brew install yt-dlp` …"). So a hint adds what the
 * message can't know: where to click, how long to wait, what comes later. Codes the user can't act
 * on (removed, private, geo-blocked, canceled) have none. Commands are wrapped in backticks:
 * render a hint with `ProblemText` (features/engine/problem-text.tsx) to show them as code.
 */
const HINTS: Record<ErrorCode, string | (() => string) | undefined> = {
  invalid_url: undefined,
  unsupported_url: undefined,
  unavailable: undefined,
  private: undefined,
  geo_blocked: undefined,
  age_restricted: SIGN_INS_LATER,
  login_required: SIGN_INS_LATER,
  preview_only: SIGN_INS_LATER,
  bot_check: 'Updating yt-dlp usually fixes this: `brew upgrade yt-dlp`.',
  rate_limited: 'Limits usually lift within a few minutes, at most an hour.',
  network: undefined,
  engine_missing:
    'Once it is installed (`brew install yt-dlp ffmpeg`), check the engine again in the top right.',
  postprocess_failed:
    'Retry; if it keeps failing, pick another format or update ffmpeg: `brew upgrade ffmpeg`.',
  // The message says which drive: the target folder's, or the one with the app's work files.
  disk_full: 'Free up some space there, then retry.',
  folder_unavailable: 'You can pick another folder in the header.',
  canceled: undefined,
  invalid_request: undefined,
  // The host and origin checks refuse a page served from an unexpected address. A function: the
  // start command is read when shown, so tests can stub the build mode.
  forbidden: () => `Open DJ Scraper at the address \`${startCommand()}\` prints.`,
  not_found: undefined,
  // Mostly yt-dlp failing in a way we don't recognize (an HTTP 403, an extractor YouTube broke).
  unknown: 'If it keeps happening, update yt-dlp: `brew upgrade yt-dlp`.',
}

/** A short next step for an error code, or undefined when there is nothing to add. */
export function errorHint(code: ErrorCode): string | undefined {
  const hint = HINTS[code]
  return typeof hint === 'function' ? hint() : hint
}

/** What to show for a failure: the message, an optional next step, and the server's code if any. */
export type ErrorDescription = { message: string; hint?: string; code?: ErrorCode }

/**
 * Words for anything a call can throw, or undefined for an abort, which callers show nothing for
 * (the user or a newer request canceled it).
 * - The server's error: its message (already written for humans), the code's hint and the code.
 * - No answer from our server: say so, and how to start it.
 * - An answer that breaks the contract: usually an app and server from different versions.
 */
export function describeError(error: unknown): ErrorDescription | undefined {
  if (isAbortError(error)) return undefined
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'api': {
        const code = error.code ?? 'unknown'
        return withHint({ message: error.message, code }, errorHint(code))
      }
      case 'unreachable':
        return {
          message: "Can't reach the DJ Scraper server.",
          hint: `Start it with \`${startCommand()}\` in the project folder.`,
        }
      case 'invalid_response':
        return {
          message: 'Unexpected answer from the server.',
          hint: `If you just updated, restart \`${startCommand()}\`.`,
        }
    }
  }
  if (error instanceof Error && error.message !== '') return { message: error.message }
  return { message: 'Something went wrong.' }
}

/**
 * Whether `error` is a canceled request rather than a failure: an aborted fetch rejects with the
 * signal's reason (an AbortError unless the caller gave another), and TanStack Query rejects a
 * canceled query's fetch with a CancelledError.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof CancelledError) return true
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
}

function withHint(description: ErrorDescription, hint: string | undefined): ErrorDescription {
  return hint === undefined ? description : { ...description, hint }
}

const UNAVAILABLE_LABELS: Record<UnavailableReason, string> = {
  unavailable: 'Unavailable',
  private: 'Private',
  geo_blocked: 'Not in your country',
  age_restricted: 'Age-restricted',
  login_required: 'Needs a login',
  preview_only: 'Preview only (Go+)',
}

/** A short label for an unavailable track, e.g. in a greyed-out row: "Private", "Needs a login". */
export function unavailableLabel(reason: UnavailableReason | undefined): string {
  return reason === undefined ? 'Unavailable' : UNAVAILABLE_LABELS[reason]
}
