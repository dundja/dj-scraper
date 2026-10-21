import {
  classifyUrl,
  type ErrorInfo,
  type TrackMatch,
  TrackMatchSchema,
  type ValidUrl,
} from '@dj-scraper/shared'
import { cleanTagValue } from '../engine/finalize-plan.ts'
import { run } from '../engine/run.ts'
import { searchArgs } from '../engine/ytdlp-args.ts'
import { ApiError } from '../http/errors.ts'
import { LIST_URL } from '../jobs/attempt.ts'
import { callYtdlp, type Logger } from '../resolve/ytdlp-call.ts'
import { type SpotifyClient, SpotifyError } from './client.ts'
import type { SpotifyTrack } from './embed.ts'
import {
  type Candidate,
  parseSearchResults,
  rankMatches,
  SEARCH_RESULTS,
  searchQuery,
} from './match.ts'

/**
 * A Spotify job's first step (ADR-026): the track's names from Spotify's embed page, a YouTube
 * search for them, and the result `pickMatch` trusts. The attempt then downloads that video like
 * any YouTube track and tags the file with Spotify's names and cover.
 */

/** A search page is about 20 kB of JSON. */
const SEARCH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const SEARCH_TIMEOUT_MS = 60_000

export const NO_MATCH: ErrorInfo = {
  code: 'no_match',
  message: "No YouTube upload matches this Spotify track's artist, title and length.",
}
/** How many matches a job gets: the best, then the ones to try if YouTube refuses it. */
const MAX_MATCHES = 3

export type SpotifyMatched = {
  /** Spotify's names, for the tags. */
  track: SpotifyTrack
  /** What the job shows. */
  match: TrackMatch
  /** The matched video, classified: the only URL the download gets. */
  input: ValidUrl
  /** The next-best matches, best first: tried when YouTube refuses the one before (blocked, private). */
  alternatives?: { match: TrackMatch; input: ValidUrl }[]
}

export type SpotifyDownloads = {
  /** Never rejects for anything it expects; an aborted signal may end it with `canceled`. */
  match: (
    input: ValidUrl,
    ytdlp: string,
    signal: AbortSignal,
    jobId: string,
    /** The attempt's job dir, named in the search's argv so the startup sweep finds it. */
    jobDir?: string,
  ) => Promise<{ ok: true; matched: SpotifyMatched } | { ok: false; error: ErrorInfo }>
  /** The Spotify cover's bytes, or undefined (the download keeps YouTube's thumbnail then). */
  cover: SpotifyClient['cover']
}

export type SpotifyMatcherDeps = {
  client: SpotifyClient
  run?: typeof run
  /** Our Node for `--js-runtimes`: `process.execPath`, never user input. */
  jsRuntime?: string
  log?: Logger
}

export function createSpotifyDownloads({
  client,
  run: runFn = run,
  jsRuntime = process.execPath,
  log = console,
}: SpotifyMatcherDeps): SpotifyDownloads {
  return {
    cover: client.cover,

    async match(input, ytdlp, signal, jobId, jobDir) {
      const id = jobId.slice(0, 8)
      if (input.kind !== 'spotify_track') return { ok: false, error: LIST_URL }

      let track: SpotifyTrack
      try {
        const entity = await client.entity(input, signal)
        if (entity.type !== 'track') return { ok: false, error: LIST_URL }
        track = entity.track
      } catch (error) {
        if (!(error instanceof SpotifyError)) throw error
        log.warn(`[match] ${id}: Spotify → ${error.info.code} (${error.detail ?? 'no detail'})`)
        // Spotify's rate limit is no YouTube strike: as `rate_limited`, the queue would pause
        // every YouTube download for it. `network` keeps the message and stays retryable.
        const info =
          error.info.code === 'rate_limited'
            ? { ...error.info, code: 'network' as const }
            : error.info
        return { ok: false, error: info }
      }

      const query = searchQuery(track)
      if (query === '' || track.durationSec === undefined) return { ok: false, error: NO_MATCH }
      let outcome: Awaited<ReturnType<typeof callYtdlp>>
      try {
        outcome = await callYtdlp(
          ytdlp,
          searchArgs({ query, count: SEARCH_RESULTS, jsRuntime, ...(jobDir ? { jobDir } : {}) }),
          {
            run: runFn,
            timeoutMs: SEARCH_TIMEOUT_MS,
            signal,
            maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES,
          },
        )
      } catch (error) {
        if (error instanceof ApiError)
          return { ok: false, error: { code: error.code, message: error.message } }
        throw error
      }
      if (!outcome.ok) {
        if (outcome.cause) log.warn(`[match] ${id}: the search failed: ${outcome.cause}`)
        return { ok: false, error: outcome.error }
      }

      const candidates = parseSearchResults(outcome.json)
      const ranked = rankMatches(track, candidates).flatMap(({ candidate, score }) => {
        const found = toMatch(candidate)
        return found === undefined ? [] : [{ ...found, candidate, score }]
      })
      const [best, ...rest] = ranked
      if (best === undefined) {
        log.info(`[match] ${id}: none of ${candidates.length} results matches`)
        return { ok: false, error: NO_MATCH }
      }
      const delta = Math.abs((best.candidate.durationSec ?? 0) - track.durationSec)
      log.info(
        `[match] ${id}: result ${candidates.indexOf(best.candidate) + 1} of ${candidates.length} (score ${best.score.toFixed(0)}, ${delta.toFixed(1)} s apart)`,
      )
      const alternatives = rest
        .slice(0, MAX_MATCHES - 1)
        .map(({ match, input }) => ({ match, input }))
      return {
        ok: true,
        matched: {
          track,
          match: best.match,
          input: best.input,
          ...(alternatives.length > 0 ? { alternatives } : {}),
        },
      }
    },
  }
}

/** A result as the job shows it and the download gets it, or undefined if it's off-contract. */
function toMatch(candidate: Candidate): { match: TrackMatch; input: ValidUrl } | undefined {
  const page = classifyUrl(`https://www.youtube.com/watch?v=${candidate.id}`)
  if (!page.ok || page.kind !== 'youtube_video') return undefined
  const match = TrackMatchSchema.safeParse({
    platform: 'youtube',
    id: candidate.id,
    url: page.url,
    title: cleanTagValue(candidate.title),
    uploader: cleanTagValue(candidate.uploader),
    durationSec: candidate.durationSec,
  })
  return match.success ? { match: match.data, input: page } : undefined
}
