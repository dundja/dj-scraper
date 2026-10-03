// `pnpm smoke --download`: the real download pipeline against live YouTube and SoundCloud.
//
// Each URL is resolved with the real resolver, turned into the TrackRef the web would send, and
// posted to the real `POST /downloads` route (in process, no socket): the real queue, gates,
// attempt (yt-dlp), finalize (ffmpeg/ffprobe, our ID3 writer) and publish. Everything happens in
// a fresh temp dir: its own data dir (never the user's) and its own target folder (never
// ~/Music). Each file is then read back with the real ffprobe and the test-side ID3 reader, and
// the temp dir is deleted unless --keep. Uses the network; never part of `pnpm test`.

import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AudioSource,
  CreateDownloadsResponseSchema,
  DEFAULT_FILENAME_TEMPLATE,
  type DownloadFormat,
  type DownloadRequest,
  type Job,
  type JobStatus,
  type ResolveMode,
  type ServerEvent,
  type Track,
  type TrackRef,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import * as z from 'zod'
import { defaultDownloadFolder } from '../src/config.ts'
import { lockDataDir, prepareDataDir } from '../src/data-dir.ts'
import type { EngineEnv } from '../src/engine/binaries.ts'
import { ffprobeArgs } from '../src/engine/finalize-plan.ts'
import { run } from '../src/engine/run.ts'
import { ApiError, onError } from '../src/http/errors.ts'
import type { Logger } from '../src/resolve/ytdlp-call.ts'
import { downloadRoutes } from '../src/routes/downloads.ts'
import { createServices } from '../src/services.ts'
import { createSettingsStore } from '../src/settings/store.ts'
import {
  type Id3Tag,
  readAiffTag,
  readComment,
  readMp3Tag,
  readPicture,
  readTextFrame,
} from '../test/id3-reader.ts'

/** The shortest samples of the smoke-test skill: the SoundCloud secret link, then the YouTube video. */
export const DOWNLOAD_SAMPLES: readonly { label: string; url: string }[] = [
  {
    label: 'SoundCloud secret link (10 s)',
    url: 'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
  },
  { label: 'YouTube video (19 s)', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
]

/** A batch that takes longer than this is canceled and counts as failed. */
const BATCH_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 30_000
/** MP4 stream tags every file has; they say nothing about our tagging. */
const BOILERPLATE_STREAM_TAGS = new Set(['handler_name', 'vendor_id', 'language'])
/** Tag values longer than this are cut in the summary. */
const SHOWN_TEXT = 90
/** D3: covers are scaled down to fit this square. */
const MAX_COVER_PX = 1000

export type DownloadSmokeOptions = {
  targets: readonly { label: string; url: string }[]
  formats: readonly DownloadFormat[]
  /** Keep the temp dir (files, data dir) and print where it is. */
  keep: boolean
  /** Send only platform, id and url, like an unenriched collection row (no availability). */
  bare: boolean
  mode: ResolveMode
  engine: EngineEnv
  say: (line: string) => void
  log: Logger
  /** Where the temp dir goes. Default the OS temp dir. */
  tempParent?: string
}

/** What one job's run looked like, from the events the bus emitted. */
type Watch = { statuses: JobStatus[]; progressEvents: number; maxPercent?: number; waited: boolean }

/** Runs the download smoke; resolves with the number of URLs × formats that didn't end done. */
export async function smokeDownloads(options: DownloadSmokeOptions): Promise<number> {
  const { say, log, keep } = options
  const root = await mkdtemp(path.join(options.tempParent ?? tmpdir(), 'djs-smoke-'))
  // Ctrl-C exits at once (smoke.ts); the files go with it unless --keep. Runs after the exit hook
  // that kills engine process groups, which smoke.ts registered first.
  const removeRoot = () => {
    if (!keep) rmSync(root, { recursive: true, force: true })
  }
  process.on('exit', removeRoot)

  const dataDir = await prepareDataDir(path.join(root, 'data'))
  const lock = await lockDataDir(dataDir, { log })
  const folder = path.join(root, 'folder')
  await mkdir(folder)
  // A default folder that is never the request's, so the route creates nothing outside root.
  const defaultFolder = defaultDownloadFolder(path.join(root, 'home'))
  say(`temp dir ${root}${keep ? ' (kept)' : ' (deleted at the end)'}`)
  say('')

  const settings = await createSettingsStore({ dataDir, defaultFolder, log })
  // The server's own services and pacing; every event is checked against the contract, as in dev.
  const { resolver, enricher, bus, queue, locate } = createServices({
    engine: options.engine,
    dataDirReal: dataDir,
    settings,
    assertContract: true,
    log,
  })
  const app = new Hono()
    .route(
      '/api',
      downloadRoutes({
        queue,
        settings,
        enricher,
        locateEngine: locate,
        dataDirReal: dataDir,
        defaultFolder,
        log,
      }),
    )
    .onError(onError)

  // Every job's statuses and progress, as an SSE client would see them.
  const watches = new Map<string, Watch>()
  const settled = new Set<() => void>()
  bus.subscribe((event) => {
    watchEvent(watches, event)
    for (const check of settled) check()
  })

  let failures = 0
  try {
    const bins = await locate()
    const refs: { label: string; url: string; ref?: TrackRef; error?: string }[] = []
    for (const { label, url } of options.targets) {
      refs.push({ label, url, ...(await refOf(url)) })
    }
    for (const { label, url, error } of refs) {
      if (error !== undefined) {
        failures += options.formats.length
        say(`❌ ${name(label, url)}\n   resolve: ${error}`)
        say('')
      }
    }
    const items = refs.flatMap(({ label, url, ref }) => (ref ? [{ label, url, ref }] : []))
    if (items.length === 0) return failures

    // One batch per format, one after the other: a format is a batch option.
    for (const format of options.formats) {
      const startedAt = performance.now()
      const request: DownloadRequest = {
        items: items.map(({ ref }) => ref),
        folder,
        options: {
          format,
          filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
          embedArtwork: true,
          sourceUrlComment: true,
        },
        label: `smoke ${format}`,
      }
      const response = await app.request('/api/downloads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        failures += items.length
        say(`❌ ${format}: POST /api/downloads answered ${response.status} ${JSON.stringify(body)}`)
        say('')
        continue
      }
      const { jobIds } = CreateDownloadsResponseSchema.parse(body)
      const jobs = await waitForJobs(jobIds)
      for (const [i, item] of items.entries()) {
        const job = jobs[i]
        if (job === undefined) continue
        const ok = await reportJob(item, job, format, startedAt, bins.ffprobe)
        if (!ok) failures++
        say('')
      }
    }
  } finally {
    await queue.close()
    await settings.flush()
    lock.release()
    if (keep) say(`kept: ${folder}`)
    else await rm(root, { recursive: true, force: true })
    process.off('exit', removeRoot)
  }
  return failures

  /** Resolves a URL as the web would and builds the ref it would post. */
  async function refOf(url: string): Promise<{ ref?: TrackRef; error?: string }> {
    try {
      const result = await resolver.resolve({ url, mode: options.mode })
      if (result.kind === 'collection') {
        return { error: `a ${result.collection.kind}: --download takes track links` }
      }
      const ref = trackRef(result.track)
      return {
        ref: options.bare ? { platform: ref.platform, id: ref.id, url: ref.url } : ref,
      }
    } catch (error) {
      if (error instanceof ApiError) return { error: `${error.code}: ${error.message}` }
      throw error
    }
  }

  /** Resolves once every job is finished; cancels them after BATCH_TIMEOUT_MS. */
  function waitForJobs(ids: readonly string[]): Promise<Job[]> {
    const current = () => ids.map((id) => queue.get(id)).filter((job) => job !== undefined)
    const finished = () =>
      current().length === ids.length && current().every((job) => isFinished(job.status))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`[smoke] the batch took over ${BATCH_TIMEOUT_MS / 60_000} min: canceling it`)
        for (const id of ids) queue.cancel(id)
      }, BATCH_TIMEOUT_MS)
      const check = () => {
        if (!finished()) return
        clearTimeout(timer)
        settled.delete(check)
        resolve(current())
      }
      settled.add(check)
      check()
    })
  }

  /** Prints one job and reads its file back; false when it didn't end done or its readback failed. */
  async function reportJob(
    item: { label: string; url: string; ref: TrackRef },
    job: Job,
    format: DownloadFormat,
    startedAt: number,
    ffprobe: string,
  ): Promise<boolean> {
    const watch = watches.get(job.id)
    const took = job.status === 'queued' ? '' : ` (${seconds(job, startedAt)})`
    const ok = job.status === 'done'
    say(`${ok ? '✅' : '❌'} ${name(item.label, item.url)} → ${format}: ${job.status}${took}`)
    if (watch !== undefined) {
      const progress =
        watch.progressEvents === 0
          ? 'no progress events'
          : `${watch.progressEvents} progress events, max ${watch.maxPercent === undefined ? '—' : watch.maxPercent.toFixed(1)} %`
      say(
        `   statuses  ${watch.statuses.join(' → ')} · ${progress}${watch.waited ? ' · waited' : ''}`,
      )
    }
    say(`   source    ${describeSource(job.source)}`)
    if (job.status === 'failed') {
      say(`   error     ${job.error.code}: ${job.error.message}`)
      return false
    }
    if (job.status === 'done') {
      const { output } = job
      say(
        `   output    ${[
          output.codec,
          output.bitrateKbps && `${Math.round(output.bitrateKbps)} kbps`,
          output.sampleRateHz && `${output.sampleRateHz} Hz`,
          output.channels && `${output.channels} ch`,
          output.encoded ? 'encoded' : 'copied',
        ]
          .filter(Boolean)
          .join(' · ')}`,
      )
    }
    if (job.status !== 'done' && job.status !== 'skipped') return false
    const size = await stat(job.outputPath).then(
      (info) => `${(info.size / 1024).toFixed(0)} KiB`,
      () => 'missing!',
    )
    say(`   file      ${path.basename(job.outputPath)} (${size})`)
    say(
      `   track     title ${quote(job.track.title)} · artist ${quote(job.track.artist)} · ref duration ${item.ref.durationSec ?? '—'} s`,
    )
    const readback = await readBack(job.outputPath, ffprobe)
    for (const line of readback.lines) say(`   ${line}`)
    return ok && readback.ok
  }
}

/** The TrackRef the web builds from a resolved Track. */
function trackRef(track: Track): TrackRef {
  return {
    platform: track.platform,
    id: track.id,
    url: track.url,
    title: track.title,
    ...(track.artist === undefined ? {} : { artist: track.artist }),
    ...(track.uploader === undefined ? {} : { uploader: track.uploader }),
    ...(track.durationSec === undefined ? {} : { durationSec: track.durationSec }),
    ...(track.thumbnailUrl === undefined ? {} : { thumbnailUrl: track.thumbnailUrl }),
    availability: track.availability,
    ...(track.unavailableReason === undefined
      ? {}
      : { unavailableReason: track.unavailableReason }),
  }
}

function watchEvent(watches: Map<string, Watch>, event: ServerEvent): void {
  const watch = (id: string): Watch => {
    let found = watches.get(id)
    if (found === undefined) {
      found = { statuses: [], progressEvents: 0, waited: false }
      watches.set(id, found)
    }
    return found
  }
  if (event.type === 'jobs.added' || event.type === 'jobs.updated') {
    for (const job of event.jobs) {
      const seen = watch(job.id)
      if (seen.statuses.at(-1) !== job.status) seen.statuses.push(job.status)
      if (job.status === 'downloading' && job.progress?.waitingUntil !== undefined)
        seen.waited = true
    }
  } else if (event.type === 'job.progress') {
    const seen = watch(event.jobId)
    seen.progressEvents++
    const { percent, waitingUntil } = event.progress
    if (waitingUntil !== undefined) seen.waited = true
    if (percent !== undefined) seen.maxPercent = Math.max(seen.maxPercent ?? 0, percent)
  }
}

const isFinished = (status: JobStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'canceled' || status === 'skipped'

// ffprobe's answer, tolerantly: only the fields the summary shows.
const Tags = z.record(z.string(), z.string()).optional()
const ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        sample_rate: z.string().optional(),
        channels: z.number().optional(),
        bit_rate: z.string().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).optional(),
        tags: Tags,
      }),
    )
    .default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      tags: Tags,
    })
    .optional(),
})

/** An independent look at the published file: the real ffprobe, and our ID3 tag for MP3/AIFF. */
async function readBack(file: string, ffprobe: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = []
  let ok = true
  // Finalize's own probe argv (D15): the fields it checks are the ones worth showing.
  const probe = await run(ffprobe, ffprobeArgs(file), { timeoutMs: PROBE_TIMEOUT_MS })
  const parsed = probe.exitCode === 0 ? parseJson(probe.stdout) : undefined
  const info = parsed === undefined ? undefined : ProbeSchema.safeParse(parsed)
  if (info === undefined || !info.success) {
    ok = false
    lines.push(`ffprobe   ❌ exit ${probe.exitCode}: ${lastLine(probe.stderr)}`)
  } else {
    const { format, streams } = info.data
    const parts = [
      format?.format_name,
      format?.duration && `${Number(format.duration).toFixed(2)} s`,
      format?.bit_rate && kbps(format.bit_rate),
    ]
    for (const stream of streams) {
      if (stream.codec_type === 'audio') {
        parts.push(
          [
            'audio',
            stream.codec_name,
            stream.sample_rate && `${stream.sample_rate} Hz`,
            stream.channels && `${stream.channels} ch`,
            stream.bit_rate && kbps(stream.bit_rate),
          ]
            .filter(Boolean)
            .join(' '),
        )
      } else if (stream.codec_type === 'video') {
        const cover = stream.disposition?.attached_pic === 1 ? 'cover' : 'VIDEO (not a cover!)'
        if (stream.disposition?.attached_pic !== 1) ok = false
        parts.push(`${cover} ${stream.codec_name ?? '?'}`)
      }
    }
    lines.push(`ffprobe   ${parts.filter(Boolean).join(' · ')}`)
    // Container tags as they are; stream tags (Ogg comments, the cover's title) prefixed a:/v:.
    const shown = Object.entries(format?.tags ?? {}).map(([key, value]) => `${key}=${clip(value)}`)
    for (const stream of streams) {
      const prefix = stream.codec_type === 'video' ? 'v:' : 'a:'
      for (const [key, value] of Object.entries(stream.tags ?? {})) {
        if (!BOILERPLATE_STREAM_TAGS.has(key)) shown.push(`${prefix}${key}=${clip(value)}`)
      }
    }
    lines.push(`tags      ${shown.length === 0 ? '(none)' : shown.join(' · ')}`)
  }

  const ext = path.extname(file).toLowerCase()
  if (ext === '.mp3' || ext === '.aiff') {
    try {
      const { tag } = ext === '.mp3' ? await readMp3Tag(file) : await readAiffTag(file)
      lines.push(`ID3v2.${tag.version[0]}   ${describeId3(tag)}`)
      const cover = checkCover(tag)
      if (cover !== undefined) {
        lines.push(`cover     ${cover.text}`)
        if (!cover.ok) ok = false
      }
    } catch (error) {
      ok = false
      lines.push(`ID3       ❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok, lines }
}

function describeId3(tag: Id3Tag): string {
  const frames = tag.frames.map((frame) => {
    if (frame.id === 'COMM') {
      const comment = readComment(frame)
      return `COMM(${comment.language},${quote(comment.description)}) ${quote(clip(comment.text))}`
    }
    if (frame.id === 'APIC') {
      const picture = readPicture(frame)
      return `APIC ${picture.mime} type ${picture.type} ${(picture.data.length / 1024).toFixed(0)} KiB`
    }
    if (frame.id.startsWith('T')) return `${frame.id} ${quote(clip(readTextFrame(frame).text))}`
    return `${frame.id} (${frame.data.length} B)`
  })
  return [...frames, `padding ${tag.padding}`].join(' · ')
}

/**
 * D3: the cover we embed is a baseline JPEG no larger than MAX_COVER_PX. A JPEG whose frame
 * header can't be found is only a warning (the fake engine's covers have none).
 */
function checkCover(tag: Id3Tag): { ok: boolean; text: string } | undefined {
  const frame = tag.frames.find((candidate) => candidate.id === 'APIC')
  if (frame === undefined) return undefined
  const jpeg = jpegFrame(readPicture(frame).data)
  if (jpeg === undefined) return { ok: true, text: '⚠️  no JPEG frame header found' }
  const size = `${jpeg.width}x${jpeg.height} ${jpeg.baseline ? 'baseline' : 'progressive'} JPEG`
  const ok = jpeg.baseline && Math.max(jpeg.width, jpeg.height) <= MAX_COVER_PX
  return { ok, text: ok ? size : `❌ ${size}: expected baseline, ≤ ${MAX_COVER_PX} px` }
}

/** A JPEG's size from its first SOF segment; SOF0 is baseline. Undefined if none is found. */
function jpegFrame(
  bytes: Uint8Array,
): { width: number; height: number; baseline: boolean } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  const word = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined
    const marker = bytes[at + 1] ?? 0
    if (marker === 0xff) {
      at++ // a fill byte
      continue
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: word(at + 5), width: word(at + 7), baseline: marker === 0xc0 }
    }
    at += 2 + word(at + 2)
  }
  return undefined
}

function describeSource(source: AudioSource | undefined): string {
  if (source === undefined) return '—'
  return [source.codec, source.bitrateKbps && `${Math.round(source.bitrateKbps)} kbps`]
    .filter(Boolean)
    .join(' ')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function seconds(job: Job, fallbackStart: number): string {
  if (job.startedAt === undefined && isFinished(job.status)) return 'never started'
  if ('finishedAt' in job && job.startedAt !== undefined) {
    return `${((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1)} s`
  }
  return `${((performance.now() - fallbackStart) / 1000).toFixed(1)} s since the batch started`
}

const name = (label: string, url: string): string => (label ? `${label}: ${url}` : url)
const kbps = (bps: string): string => `${Math.round(Number(bps) / 1000)} kbps`
const quote = (text: string | undefined): string => (text === undefined ? '—' : `“${text}”`)
const clip = (text: string): string =>
  text.length > SHOWN_TEXT ? `${text.slice(0, SHOWN_TEXT - 1)}…` : text
const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''
