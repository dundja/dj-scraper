import type { ErrorInfo, ValidUrl } from '@dj-scraper/shared'
import { CANCELED } from '../resolve/ytdlp-call.ts'
import { EmbedParseError, embedPath, parseEmbedPage, type SpotifyEntity } from './embed.ts'

/**
 * Reads Spotify's public embed pages and cover images over HTTPS (ADR-026). This is the only code
 * that talks to Spotify: never its streams (DRM), never its API, never with an account. The URL is
 * built from the classified id alone, and only Spotify's own image hosts are fetched for covers.
 */

export const SPOTIFY_ORIGIN = 'https://open.spotify.com'
/** A page is about 10 kB for a track and under 200 kB for 100 rows. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024
/** Spotify's covers are JPEGs of at most 640 px, well under 1 MB. */
const MAX_COVER_BYTES = 5 * 1024 * 1024
export const SPOTIFY_TIMEOUT_MS = 20_000
/** The embed page answers a desktop browser; a bare client may get a different page. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
/** Spotify's image CDNs; subdomains count too. */
const COVER_DOMAINS = ['scdn.co', 'spotifycdn.com']

/** A failure with a message for the user; `cause` is a log-safe detail (no URL, no page text). */
export class SpotifyError extends Error {
  override name = 'SpotifyError'
  readonly info: ErrorInfo
  readonly detail: string | undefined

  constructor(info: ErrorInfo, detail?: string) {
    super(info.message)
    this.info = info
    this.detail = detail
  }
}

export const SPOTIFY_NOT_FOUND: ErrorInfo = {
  code: 'unavailable',
  message: "Spotify doesn't show this link: it may be private, removed or mistyped.",
}
export const SPOTIFY_RATE_LIMITED: ErrorInfo = {
  code: 'rate_limited',
  message: 'Spotify is limiting requests. Wait a minute, then try again.',
}
export const SPOTIFY_UNREACHABLE: ErrorInfo = {
  code: 'network',
  message: "Spotify can't be reached. Check the internet connection.",
}
export const SPOTIFY_UNREADABLE: ErrorInfo = {
  code: 'unknown',
  message: "Spotify's page has changed, and DJ Scraper can't read it.",
}

export type SpotifyClientDeps = {
  /**
   * `https://open.spotify.com`. Tests point it at a local fixture server (`DJS_SPOTIFY_ORIGIN`); its
   * host then also serves covers.
   */
  origin?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export type SpotifyClient = {
  /** The track, album or playlist a classified Spotify URL names. Throws SpotifyError. */
  entity: (input: ValidUrl, signal?: AbortSignal) => Promise<SpotifyEntity>
  /** A cover image's bytes, or undefined when it can't be had: a cover is never worth a failure. */
  cover: (url: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>
}

export function createSpotifyClient({
  origin = SPOTIFY_ORIGIN,
  fetch: fetchFn = fetch,
  timeoutMs = SPOTIFY_TIMEOUT_MS,
}: SpotifyClientDeps = {}): SpotifyClient {
  const base = new URL(origin)
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new RangeError('The Spotify origin must be an http(s) URL')
  }

  async function get(url: URL, maxBytes: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await fetchFn(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      throw fetchFailure(error, signal, timeout)
    }
    if (response.status === 404) throw new SpotifyError(SPOTIFY_NOT_FOUND, 'HTTP 404')
    if (response.status === 429) throw new SpotifyError(SPOTIFY_RATE_LIMITED, 'HTTP 429')
    if (!response.ok) {
      throw new SpotifyError(
        { code: 'network', message: `Spotify answered with an error (HTTP ${response.status}).` },
        `HTTP ${response.status}`,
      )
    }
    try {
      return {
        body: await readCapped(response, maxBytes),
        type: response.headers.get('content-type'),
      }
    } catch (error) {
      if (error instanceof SpotifyError) throw error
      throw fetchFailure(error, signal, timeout)
    }
  }

  return {
    async entity(input, signal) {
      const { body } = await get(new URL(embedPath(input), base), MAX_PAGE_BYTES, signal)
      try {
        return parseEmbedPage(new TextDecoder().decode(body))
      } catch (error) {
        if (!(error instanceof EmbedParseError)) throw error
        throw new SpotifyError(SPOTIFY_UNREADABLE, error.message)
      }
    },

    async cover(url, signal) {
      if (!URL.canParse(url)) return undefined
      const target = new URL(url)
      const host = target.hostname
      const spotifyCdn =
        target.protocol === 'https:' &&
        COVER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
      if (!spotifyCdn && target.origin !== base.origin) return undefined
      try {
        const { body, type } = await get(target, MAX_COVER_BYTES, signal)
        return type?.startsWith('image/') ? body : undefined
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error instanceof SpotifyError) return undefined
        throw error
      }
    },
  }
}

function fetchFailure(error: unknown, signal: AbortSignal | undefined, timeout: AbortSignal) {
  if (signal?.aborted) return new SpotifyError(CANCELED, 'aborted')
  if (timeout.aborted) {
    return new SpotifyError(
      { code: 'network', message: "Spotify didn't answer in time. Try again." },
      'timeout',
    )
  }
  // fetch's TypeError holds the URL in its cause; only its name goes to the log.
  return new SpotifyError(SPOTIFY_UNREACHABLE, error instanceof Error ? error.name : 'fetch failed')
}

/** The body, refused as soon as it grows past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new SpotifyError(SPOTIFY_UNREADABLE, `the answer is over ${maxBytes} bytes`)
  }
  if (response.body === null) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maxBytes) {
      throw new SpotifyError(SPOTIFY_UNREADABLE, `the answer is over ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
