// `pnpm smoke --remixes`: the real remix finder (ADR-027) against live YouTube and SoundCloud.
//
// Each target is a song (a title and an artist) or a track link, resolved first with the real
// resolver and sent as the web sends it (its title, artist and uploader, the track excluded). Like
// the web, it asks for YouTube alone first, then for both platforms: the finder shares and caches
// each platform's search, so the second request costs only SoundCloud's. It prints the song, each
// platform's outcome, the timings and every suggestion. Uses the network; never part of
// `pnpm test` (test/smoke-remixes.test.ts runs it offline against the fake yt-dlp).

import {
  type RemixRequest,
  type RemixSuggestion,
  type RemixSuggestions,
  RemixSuggestionsSchema,
  type ResolveMode,
  type Track,
} from '@dj-scraper/shared'
import type { EngineEnv } from '../src/engine/binaries.ts'
import { ApiError } from '../src/http/errors.ts'
import { createRemixFinder } from '../src/remix/finder.ts'
import { remixQuery, songOf } from '../src/remix/suggest.ts'
import { createResolver } from '../src/resolve/resolver.ts'
import type { Logger } from '../src/resolve/ytdlp-call.ts'
import { productionPacing } from '../src/services.ts'
import { createSpotifyClient } from '../src/spotify/client.ts'

/** A song by its names, or a track link to resolve first. */
export type RemixTarget =
  | { label: string; title: string; artist?: string }
  | { label: string; url: string }

/** With no arguments: one song with many remixes across genres, and one with a different artist spelling. */
export const REMIX_SAMPLES: readonly RemixTarget[] = [
  { label: 'Moby – Porcelain', title: 'Porcelain', artist: 'Moby' },
  { label: 'RÜFÜS DU SOL – Innerbloom', title: 'Innerbloom', artist: 'RÜFÜS DU SOL' },
]

export type RemixSmokeOptions = {
  targets: readonly RemixTarget[]
  /** One JSON document per target on `print`, the human lines on `say`. */
  json: boolean
  /** How a track link resolves. */
  mode: ResolveMode
  engine: EngineEnv
  spotifyOrigin?: string
  say: (line: string) => void
  /** Where --json documents go: stdout. */
  print: (text: string) => void
  log: Logger
}

/**
 * Positionals → targets: a link is a track to resolve; any other text is a title, and the text
 * after it its artist ("'Porcelain' 'Moby'"). A title last, or before a link, has no artist.
 */
export function remixTargets(positionals: readonly string[]): RemixTarget[] {
  const targets: RemixTarget[] = []
  for (let i = 0; i < positionals.length; i++) {
    const text = positionals[i] ?? ''
    if (isLink(text)) {
      targets.push({ label: '', url: text })
      continue
    }
    const next = positionals[i + 1]
    if (next !== undefined && !isLink(next)) {
      targets.push({ label: '', title: text, artist: next })
      i++
    } else {
      targets.push({ label: '', title: text })
    }
  }
  return targets
}

function isLink(text: string): boolean {
  return /^https?:\/\//i.test(text.trim())
}

/** Runs the remix smoke; resolves with the number of targets that failed or had a failed search. */
export async function smokeRemixes(options: RemixSmokeOptions): Promise<number> {
  const { say, log, json } = options
  const pacing = productionPacing()
  const finder = createRemixFinder({
    engine: options.engine,
    // The production SoundCloud bucket, as the server shares it with lookups and downloads.
    ...(pacing.lookups.soundcloud.budget === undefined
      ? {}
      : { soundcloudBudget: pacing.lookups.soundcloud.budget }),
    log,
  })
  const resolver = createResolver({
    engine: options.engine,
    spotify: createSpotifyClient(
      options.spotifyOrigin === undefined ? {} : { origin: options.spotifyOrigin },
    ),
    log,
  })

  let failures = 0
  for (const target of options.targets) {
    const name = 'url' in target ? target.url : describeNames(target.title, target.artist)
    const heading = target.label ? `${target.label}: ${name}` : name
    const startedAt = performance.now()
    try {
      const request =
        'url' in target
          ? requestFor(await resolveTrack(resolver, target.url, options.mode))
          : {
              title: target.title,
              ...(target.artist === undefined ? {} : { artist: target.artist }),
            }
      const song = songOf(request)
      // The web's two requests: YouTube first, then both (YouTube's search comes from the cache).
      const youtubeFirst = await finder.find({ ...request, platforms: ['youtube'] })
      const youtubeMs = performance.now() - startedAt
      const answer = RemixSuggestionsSchema.parse(await finder.find(request))
      const totalMs = performance.now() - startedAt
      const failed = searchFailures(youtubeFirst, answer)
      if (failed.length > 0) failures++
      const timings = { youtubeMs: Math.round(youtubeMs), totalMs: Math.round(totalMs) }
      if (json) {
        options.print(
          JSON.stringify(
            {
              target: 'url' in target ? { url: target.url } : target,
              ok: failed.length === 0,
              request,
              query: song === undefined ? undefined : remixQuery(song),
              timings,
              answer,
            },
            null,
            2,
          ),
        )
      } else {
        say(`${failed.length === 0 ? '✅' : '❌'} ${heading} (${seconds(totalMs)})`)
        for (const line of describeAnswer(answer, song && remixQuery(song), timings)) {
          say(`   ${line}`)
        }
      }
    } catch (error) {
      failures++
      const failure =
        error instanceof ApiError
          ? { code: error.code, message: error.message }
          : { code: 'unexpected', message: error instanceof Error ? error.message : String(error) }
      if (json) {
        options.print(
          JSON.stringify(
            { target: 'url' in target ? { url: target.url } : target, ok: false, error: failure },
            null,
            2,
          ),
        )
      } else {
        say(`❌ ${heading} (${seconds(performance.now() - startedAt)})`)
        say(`   ${failure.code}: ${failure.message}`)
      }
      if (!(error instanceof ApiError)) console.error(error)
    }
    say('')
  }
  const total = options.targets.length
  say(`${total - failures}/${total} searched${failures > 0 ? ', see ❌ above' : ''}`)
  return failures
}

async function resolveTrack(
  resolver: ReturnType<typeof createResolver>,
  url: string,
  mode: ResolveMode,
): Promise<Track> {
  const result = await resolver.resolve({ url, mode })
  if (result.kind === 'collection') {
    throw new ApiError('invalid_request', '--remixes takes track links, not lists')
  }
  return result.track
}

/** What the web sends for a pasted track. */
function requestFor(track: Track): RemixRequest {
  return {
    title: track.title,
    ...(track.artist === undefined ? {} : { artist: track.artist }),
    ...(track.uploader === undefined ? {} : { uploader: track.uploader }),
    exclude: { platform: track.platform, id: track.id },
  }
}

/** The platforms whose search failed, in either request. */
function searchFailures(...answers: RemixSuggestions[]): string[] {
  const failed = new Set<string>()
  for (const answer of answers) {
    for (const [platform, status] of Object.entries(answer.searches)) {
      if (status.status === 'error') failed.add(platform)
    }
  }
  return [...failed]
}

function describeAnswer(
  answer: RemixSuggestions,
  query: string | undefined,
  timings: { youtubeMs: number; totalMs: number },
): string[] {
  const statuses = Object.entries(answer.searches).map(([platform, status]) => {
    if (status.status === 'ok') return `${platform} ${status.found} found`
    if (status.status === 'error') {
      return `${platform} ❌ ${status.error.code}: ${status.error.message}`
    }
    return `${platform} skipped`
  })
  return [
    `song ${describeNames(answer.song.title, answer.song.artist)}${query ? ` · query ${quote(query)}` : ''}`,
    `${statuses.join(' · ')} · ${answer.suggestions.length} suggestions`,
    `timings: YouTube ${seconds(timings.youtubeMs)}, then SoundCloud ${seconds(timings.totalMs - timings.youtubeMs)} (YouTube's search cached)`,
    ...answer.suggestions.map((suggestion, index) => describeSuggestion(index + 1, suggestion)),
  ]
}

/** `3. 314,402 plays · remix · Pola & Bryson · Drum & Bass (SoundCloud) · youtube ×2, soundcloud ×1` */
function describeSuggestion(rank: number, suggestion: RemixSuggestion): string {
  const platforms = new Map<string, number>()
  for (const upload of suggestion.uploads) {
    platforms.set(upload.platform, (platforms.get(upload.platform) ?? 0) + 1)
  }
  const genre = suggestion.genre
    ? `${suggestion.genre.name} (${suggestion.genre.source === 'platform' ? 'SoundCloud genre' : 'named in text'})`
    : 'no genre'
  const top = suggestion.uploads[0]
  return [
    `${rank}. ${suggestion.plays === undefined ? '— plays' : `${suggestion.plays.toLocaleString('en-US')} plays`}`,
    suggestion.kind,
    suggestion.remixer ?? '(no remixer)',
    genre,
    [...platforms].map(([platform, count]) => `${platform} ×${count}`).join(', '),
    top === undefined ? '' : `${quote(top.title)} ${top.url}`,
  ].join(' · ')
}

function describeNames(title: string, artist: string | undefined): string {
  return artist === undefined ? quote(title) : `${quote(title)} by ${artist}`
}

function quote(text: string): string {
  return `“${text}”`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}
