// `pnpm smoke [--json] [--mode auto|track|collection] [--entries N] [url ...]`
// `pnpm smoke --download [--format mp3|m4a|aiff|wav|flac|original]… [--keep] [--bare] [url ...]`
//
// A live check of the engine against real YouTube and SoundCloud, with the real yt-dlp and the
// same services the server uses: the resolver and enricher, or with --download the whole download
// pipeline into a temp dir (scripts/smoke-download.ts). This is the only code path that touches
// the network on purpose, so it is never part of `pnpm test`. Without URLs it runs the sample set
// from .claude/skills/smoke-test/SKILL.md (its shortest tracks with --download). Exits 1 if any
// URL (× format) failed.

import { parseArgs } from 'node:util'
import {
  type CollectionEntry,
  type DownloadFormat,
  DownloadFormatSchema,
  type EntryRef,
  type EntryResult,
  MAX_ENTRIES_PER_REQUEST,
  type ResolveMode,
  ResolveModeSchema,
  type ResolveResult,
  ResolveResultSchema,
  type Track,
} from '@dj-scraper/shared'
import { ConfigError, loadConfig } from '../src/config.ts'
import { checkYtdlp } from '../src/engine/binaries.ts'
import { killActiveGroups } from '../src/engine/run.ts'
import { ApiError } from '../src/http/errors.ts'
import { createEnricher, type Enricher } from '../src/resolve/enricher.ts'
import { createResolver } from '../src/resolve/resolver.ts'
import { DOWNLOAD_SAMPLES, smokeDownloads } from './smoke-download.ts'

/** The smoke-test skill's sample set (public URLs from yt-dlp's own extractor tests). */
const SAMPLES: readonly { label: string; url: string }[] = [
  { label: 'YouTube video (19 s)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  {
    label: 'YouTube playlist (small)',
    url: 'https://www.youtube.com/playlist?list=PLt5yu3-wZAlQAaPZ5Z-rJoTdbT-45Q7c0',
  },
  {
    label: 'YouTube empty playlist',
    url: 'https://www.youtube.com/playlist?list=PL4lCao7KL_QFodcLWhDpGCYnngnHtQ-Xf',
  },
  {
    label: 'YouTube Music album (50 tracks)',
    url: 'https://music.youtube.com/browse/MPREb_gTAcphH99wE',
  },
  {
    label: 'SoundCloud track',
    url: 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy',
  },
  {
    label: 'SoundCloud secret link (10 s)',
    url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
  },
  {
    label: 'SoundCloud set',
    url: 'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
  },
  { label: 'SoundCloud album set', url: 'https://soundcloud.com/leviryan/sets/out-of-spite' },
  {
    label: 'SoundCloud downloadable track',
    url: 'https://soundcloud.com/the80m/the-following',
  },
]

const USAGE = [
  'Usage: pnpm smoke [--json] [--mode auto|track|collection] [--entries N] [url ...]',
  '       pnpm smoke --download [--format mp3|m4a|aiff|wav|flac|original]… [--keep] [--bare] [url ...]',
].join('\n')
/** How many entries of a collection the summary lists. */
const SHOWN_ENTRIES = 3

// yt-dlp runs in its own process group, which the terminal's Ctrl-C doesn't reach: exit, and the
// exit hook kills what is still running.
process.on('exit', killActiveGroups)
process.on('SIGINT', () => process.exit(130))

type Options = {
  json: boolean
  mode: ResolveMode
  entries: number
  urls: string[]
  /** --download: run the download pipeline instead of resolve only. */
  download: boolean
  /** --format, repeatable: one batch per format. Default mp3. */
  formats: DownloadFormat[]
  keep: boolean
  bare: boolean
}

function parseOptions(argv: readonly string[]): Options {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'auto' },
      entries: { type: 'string', default: '0' },
      download: { type: 'boolean', default: false },
      format: { type: 'string', multiple: true },
      keep: { type: 'boolean', default: false },
      bare: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const mode = ResolveModeSchema.safeParse(values.mode)
  if (!mode.success) throw new Error(`--mode must be auto, track or collection`)
  if (!/^\d+$/.test(values.entries)) throw new Error('--entries must be a whole number')
  const formats = (values.format ?? ['mp3']).map((format) => {
    const parsed = DownloadFormatSchema.safeParse(format)
    if (!parsed.success) throw new Error('--format must be mp3, m4a, aiff, wav, flac or original')
    return parsed.data
  })
  const download = values.download
  if (!download && (values.format !== undefined || values.keep || values.bare)) {
    throw new Error('--format, --keep and --bare go with --download')
  }
  if (download && (values.json || values.entries !== '0')) {
    throw new Error('--json and --entries are for resolving, not --download')
  }
  return {
    json: values.json,
    mode: mode.data,
    entries: Number(values.entries),
    urls: positionals,
    download,
    formats: [...new Set(formats)],
    keep: values.keep,
    bare: values.bare,
  }
}

let options: Options
let config: ReturnType<typeof loadConfig>
try {
  options = parseOptions(process.argv.slice(2))
  config = loadConfig(process.env, [])
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : String(error))
  console.error(USAGE)
  process.exit(2)
}

const { json, mode } = options
/** Human output; with --json it moves to stderr so stdout stays parseable. */
const say = json ? console.error : console.log
/** The services' own log lines (kind, outcome, duration), dimmed on stderr. */
const log = {
  info: (line: string) => console.error(`\x1b[2m${line}\x1b[0m`),
  warn: (line: string) => console.error(`\x1b[2m${line}\x1b[0m`),
  error: (line: string) => console.error(line),
}

const ytdlp = await checkYtdlp(config.engine, new Date())
if (ytdlp.status !== 'ok') {
  say(`❌ yt-dlp: ${ytdlp.message}`)
  process.exit(1)
}
say(`yt-dlp ${ytdlp.version}, ${ytdlp.ageDays} days old (${ytdlp.path})`)
if (!ytdlp.meetsMinimum) {
  say('⚠️  This yt-dlp is older than the minimum (2025.11.12). Run `brew upgrade yt-dlp`.')
} else if (ytdlp.stale) {
  say(
    '⚠️  yt-dlp is stale. If YouTube fails, run `brew upgrade yt-dlp` or point YTDLP_PATH at a nightly build.',
  )
}
say('')

const given = options.urls.map((url) => ({ label: '', url }))
process.exitCode = (options.download ? await smokeDownload() : await smokeResolve()) > 0 ? 1 : 0

/** --download: the download pipeline per URL × format; returns how many failed. */
async function smokeDownload(): Promise<number> {
  const targets = given.length > 0 ? given : DOWNLOAD_SAMPLES
  const failures = await smokeDownloads({
    targets,
    formats: options.formats,
    keep: options.keep,
    bare: options.bare,
    mode,
    engine: config.engine,
    say,
    log,
  })
  const total = targets.length * options.formats.length
  say(`${total - failures}/${total} downloaded${failures > 0 ? ', see ❌ above' : ''}`)
  return failures
}

/** Resolves each URL (and enriches partial rows with --entries); returns how many failed. */
async function smokeResolve(): Promise<number> {
  const resolver = createResolver({ engine: config.engine, log })
  const enricher = createEnricher({ engine: config.engine, log })
  const targets = given.length > 0 ? given : SAMPLES

  let failures = 0
  for (const { label, url } of targets) {
    const startedAt = performance.now()
    try {
      const result = ResolveResultSchema.parse(await resolver.resolve({ url, mode }))
      const enriched =
        options.entries > 0 ? await enrichPartialRows(enricher, result, options.entries) : []
      if (json) {
        console.log(JSON.stringify({ url, ok: true, result, enriched }, null, 2))
      } else {
        say(`✅ ${label ? `${label}: ` : ''}${url} (${seconds(startedAt)})`)
        for (const line of describeResult(result)) say(`   ${line}`)
        if (enriched.length > 0) say(`   enriched ${enriched.length} partial rows:`)
        for (const entry of enriched) say(`     ${describeEntryResult(entry)}`)
      }
    } catch (error) {
      failures++
      const failure =
        error instanceof ApiError
          ? { code: error.code, message: error.message }
          : { code: 'unexpected', message: error instanceof Error ? error.message : String(error) }
      if (json) console.log(JSON.stringify({ url, ok: false, error: failure }, null, 2))
      else
        say(
          `❌ ${label ? `${label}: ` : ''}${url} (${seconds(startedAt)})\n   ${failure.code}: ${failure.message}`,
        )
      if (!(error instanceof ApiError)) console.error(error)
    }
    say('')
  }

  say(
    `${targets.length - failures}/${targets.length} resolved${failures > 0 ? ', see ❌ above' : ''}`,
  )
  return failures
}

/** Fills the first `count` partial rows through the enricher, as the web does for rows in view. */
async function enrichPartialRows(
  enricher: Enricher,
  result: ResolveResult,
  count: number,
): Promise<EntryResult[]> {
  if (result.kind !== 'collection') return []
  const refs: EntryRef[] = result.collection.entries
    .filter((entry) => entry.partial)
    .slice(0, count)
    .map(({ platform, id, url }) => ({ platform, id, url }))
  const results: EntryResult[] = []
  for (let i = 0; i < refs.length; i += MAX_ENTRIES_PER_REQUEST) {
    const batch = await enricher.enrich({ entries: refs.slice(i, i + MAX_ENTRIES_PER_REQUEST) })
    results.push(...batch.results)
  }
  return results
}

function describeResult(result: ResolveResult): string[] {
  if (result.kind === 'track')
    return [`track · ${result.track.platform}`, ...describeTrack(result.track)]
  if (result.kind === 'ambiguous') {
    return [
      `ambiguous · ${result.track.platform}`,
      ...describeTrack(result.track),
      `list: ${result.collectionKind} ${result.collectionUrl} (resolve with --mode collection)`,
    ]
  }
  const c = result.collection
  const partial = c.entries.filter((entry) => entry.partial).length
  return [
    `collection · ${c.platform} · ${c.kind} · ${quote(c.title)}${c.owner ? ` · by ${c.owner}` : ''}`,
    [
      `entries ${c.entries.length}`,
      `partial ${partial}`,
      `trackCount ${c.trackCount ?? '—'}`,
      `durationSec ${c.durationSec ?? '—'}`,
      `truncated ${c.truncated ? 'yes' : 'no'}`,
      `skippedEntries ${c.skippedEntries ?? 0}`,
    ].join(' · '),
    ...c.entries.slice(0, SHOWN_ENTRIES).map((entry, i) => `${i + 1}. ${describeEntry(entry)}`),
    ...(c.entries.length > SHOWN_ENTRIES ? [`… ${c.entries.length - SHOWN_ENTRIES} more`] : []),
  ]
}

function describeTrack(track: Track): string[] {
  const source = track.source
    ? [
        track.source.codec,
        track.source.bitrateKbps && `${Math.round(track.source.bitrateKbps)} kbps`,
      ]
        .filter(Boolean)
        .join(' ')
    : '—'
  return [
    quote(track.title),
    [
      `artist ${track.artist ?? '—'}`,
      `uploader ${track.uploader ?? '—'}`,
      duration(track.durationSec),
      `source ${source}`,
      track.availability === 'unavailable'
        ? `unavailable (${track.unavailableReason ?? 'unknown reason'})`
        : track.availability,
    ].join(' · '),
  ]
}

function describeEntry(entry: CollectionEntry): string {
  const title = entry.title === undefined ? `(id ${entry.id})` : quote(entry.title)
  const who = entry.artist ?? entry.uploader
  return [
    entry.partial ? `[partial] ${title}` : title,
    ...(who ? [who] : []),
    duration(entry.durationSec),
    entry.availability,
  ].join(' · ')
}

function describeEntryResult(result: EntryResult): string {
  if (result.status === 'error')
    return `❌ ${result.id}: ${result.error.code}: ${result.error.message}`
  return `✅ ${result.id}: ${describeTrack(result.track).join(' · ')}`
}

function quote(text: string): string {
  return `“${text}”`
}

function duration(sec: number | undefined): string {
  if (sec === undefined) return '—:—'
  const total = Math.round(sec)
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function seconds(startedAt: number): string {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)} s`
}
