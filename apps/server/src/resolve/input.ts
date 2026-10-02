import { classifyUrl, type ErrorInfo, urlRejectionMessage, type ValidUrl } from '@dj-scraper/shared'

/** Non-negotiable 7: DRM services are refused before yt-dlp starts. */
export const OUT_OF_SCOPE_MESSAGE =
  "DJ Scraper doesn't download from Spotify, Apple Music, Amazon Music, Tidal, Deezer or Beatport: their streams are DRM-protected."

/**
 * Classifies a URL from a request: rejected input → `invalid_url`, a DRM service →
 * `unsupported_url`; otherwise the classified URL to plan with.
 */
export function checkUrl(
  url: string,
):
  | { ok: true; input: ValidUrl }
  | { ok: false; kind: 'invalid' | 'out_of_scope'; error: ErrorInfo } {
  const classified = classifyUrl(url)
  if (!classified.ok) {
    return {
      ok: false,
      kind: 'invalid',
      error: { code: 'invalid_url', message: urlRejectionMessage(classified.reason) },
    }
  }
  if (classified.kind === 'out_of_scope') {
    return {
      ok: false,
      kind: 'out_of_scope',
      error: { code: 'unsupported_url', message: OUT_OF_SCOPE_MESSAGE },
    }
  }
  return { ok: true, input: classified }
}
