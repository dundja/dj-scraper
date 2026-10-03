import {
  classifyUrl,
  type DownloadFormat,
  type FilenamePlaceholder,
  type JobOutput,
  type Platform,
  renderFilename,
  sanitizeFilename,
  type ValidUrl,
} from '@dj-scraper/shared'
import * as z from 'zod'
import { type DoneInfo, StepError } from '../jobs/types.ts'
import { lenient, omitUndefined } from '../util/fields.ts'
import type { Id3Tags } from './id3.ts'
import { trackNames } from './ytdlp-parse.ts'

/**
 * Pure: every decision finalize makes about a downloaded file (design D2, D3, D13-D15): its tags,
 * its name, how ffmpeg turns it into the target format, the argv for ffmpeg and ffprobe, and
 * whether ffmpeg's output is what was asked for. finalize.ts only runs the processes and moves bytes.
 */

// ---------------------------------------------------------------------------------------------
// Tags and names

/** The tags finalize writes. Every value went through `cleanTagValue`. */
export type Tags = Id3Tags

export const MAX_TAG_LENGTH = 1000
/** YouTube Music's auto-generated artist channels are named "<artist> - Topic". */
const TOPIC_SUFFIX = ' - Topic'

/**
 * A value fit for a tag (and an argv entry): controls (C0, DEL, C1) become spaces (a NUL would make
 * spawn throw, a newline would be written verbatim), whitespace collapses, lone surrogates become
 * U+FFFD, and the text is cut to `MAX_TAG_LENGTH` UTF-16 units without splitting a pair. Empty →
 * undefined (the tag is left out).
 */
export function cleanTagValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let text = value
    .toWellFormed()
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length > MAX_TAG_LENGTH) {
    const end = isHighSurrogate(text.charCodeAt(MAX_TAG_LENGTH - 1))
      ? MAX_TAG_LENGTH - 1
      : MAX_TAG_LENGTH
    text = text.slice(0, end).trimEnd()
  }
  return text === '' ? undefined : text
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** A four-digit year from `release_year`, else from `release_date` (YYYYMMDD); never upload_date. */
export function releaseYear(
  year: number | undefined,
  date: string | undefined,
): string | undefined {
  if (year !== undefined && Number.isInteger(year) && year >= 1000 && year <= 9999) {
    return String(year)
  }
  const fromDate = date?.slice(0, 4)
  return fromDate !== undefined && /^\d{4}$/.test(fromDate) && fromDate !== '0000'
    ? fromDate
    : undefined
}

/**
 * The URL for the comment tag (D2), or undefined. Only the track's own public page, and only when
 * nothing about it is a secret: yt-dlp's `webpage_url` (never our input URL as a fallback) on
 * YouTube or SoundCloud, classified to the same platform and not a secret link; the input not a
 * secret link or a SoundCloud short link (which may hide one); and yt-dlp's availability `public`
 * (missing counts as public only on SoundCloud, which reports none for public tracks).
 */
export function commentUrl(
  done: Pick<DoneInfo, 'webpageUrl' | 'availability'>,
  input: ValidUrl,
  platform: Platform,
): string | undefined {
  if (platform !== 'youtube' && platform !== 'soundcloud') return undefined
  if (input.secret === true || input.kind === 'soundcloud_short') return undefined
  const availability = done.availability ?? (platform === 'soundcloud' ? 'public' : undefined)
  if (availability !== 'public' || done.webpageUrl === undefined) return undefined
  const page = classifyUrl(done.webpageUrl)
  if (!page.ok || page.secret === true || page.platform !== platform) return undefined
  return page.url.length <= MAX_TAG_LENGTH ? page.url : undefined
}

export type TrackText = {
  tags: Tags
  /** The filename template's fields. */
  fields: Partial<Record<FilenamePlaceholder, string>>
  /** What the job shows: title and artist like a resolved row (no uploader as the artist). */
  display: { title?: string; artist?: string }
}

/**
 * Tags, filename fields and display names from the DONE line (D13). Title: `track`, else `title`.
 * Artist: the platform's `artist`/`artists`, else split from the title at its first dash (like
 * resolve), else the uploader (or channel) without " - Topic". Album and year only from the
 * release fields.
 */
export function describeTrack(
  done: DoneInfo,
  context: { platform: Platform; input: ValidUrl; sourceUrlComment: boolean },
): TrackText {
  const names = trackNames(
    {
      track: cleanTagValue(done.track),
      title: cleanTagValue(done.title),
      artist: cleanTagValue(done.artist),
      artists: done.artists?.map(cleanTagValue),
    },
    context.platform,
  )
  const title = cleanTagValue(names.title)
  const named = cleanTagValue(names.artist)
  const uploader = cleanTagValue(done.uploader)
  const artist = named ?? withoutTopic(uploader) ?? withoutTopic(cleanTagValue(done.channel))
  const tags: Tags = omitUndefined({
    title,
    artist,
    album: cleanTagValue(done.album),
    albumArtist: cleanTagValue(done.albumArtist),
    year: releaseYear(done.releaseYear, done.releaseDate),
    comment: context.sourceUrlComment
      ? commentUrl(done, context.input, context.platform)
      : undefined,
  })
  const fields = omitUndefined({
    artist,
    title,
    album: tags.album,
    year: tags.year,
    uploader,
    id: done.id,
    platform: context.platform,
  })
  return { tags, fields, display: omitUndefined({ title, artist: named }) }
}

function withoutTopic(name: string | undefined): string | undefined {
  if (name === undefined || !name.endsWith(TOPIC_SUFFIX)) return name
  return cleanTagValue(name.slice(0, -TOPIC_SUFFIX.length))
}

/**
 * The file name to publish as: the template rendered and sanitized, `<platform>-<id>` if empty, in
 * at most `maxBytes` UTF-8 bytes (what the folder's path leaves; FinalizeInput.nameMaxBytes).
 */
export function finalFileName(
  template: string,
  fields: TrackText['fields'],
  ext: string,
  fallback: { platform: Platform; id: string },
  maxBytes?: number,
): string {
  return sanitizeFilename(
    renderFilename(template, fields),
    ext,
    `${fallback.platform}-${fallback.id}`,
    maxBytes,
  )
}

// ---------------------------------------------------------------------------------------------
// ffprobe

export const PROBE_ENTRIES =
  'format=format_name,duration,bit_rate:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,bit_rate:stream_tags:stream_disposition=attached_pic'

/** ffprobe's JSON readback (D15); the file goes last. */
export function ffprobeArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-show_entries',
    PROBE_ENTRIES,
    '-of',
    'json',
    '-i',
    file,
  ]
}

export type ProbedStream = {
  index?: number
  type?: string
  codec?: string
  sampleRateHz?: number
  channels?: number
  /** Bits per second. */
  bitRate?: number
  attachedPic: boolean
  /** Keys lower-cased: containers differ (WebM reads back `title` but `ARTIST`). */
  tags: Record<string, string>
}

export type Probe = {
  /** ffprobe's demuxer list, e.g. `matroska,webm` or `mov,mp4,m4a,3gp,3g2,mj2`. */
  formatNames: string[]
  durationSec?: number
  /** Bits per second, of the whole file. */
  bitRate?: number
  /** Format-level tags, keys lower-cased. */
  tags: Record<string, string>
  streams: ProbedStream[]
  /** The first audio stream: the one `-map 0:a:0` takes. */
  audio?: ProbedStream
}

const Text = lenient(z.string().trim().min(1))
/** ffprobe prints most numbers as strings ("48000", "19.021000"). */
const Numeric = lenient(
  z
    .union([z.number(), z.string().trim().min(1)])
    .transform(Number)
    .pipe(z.number().nonnegative().finite()),
)
const TagsSchema = lenient(z.record(z.string(), z.unknown())).transform(lowerCaseTags)

const StreamSchema = z.looseObject({
  index: lenient(z.int().nonnegative()),
  codec_type: Text,
  codec_name: Text,
  sample_rate: Numeric,
  channels: lenient(z.int().positive()),
  bit_rate: Numeric,
  disposition: lenient(z.looseObject({ attached_pic: lenient(z.number()) })),
  tags: TagsSchema,
})

const ProbeSchema = z.looseObject({
  streams: lenient(z.array(lenient(StreamSchema))),
  format: lenient(
    z.looseObject({
      format_name: Text,
      duration: Numeric,
      bit_rate: Numeric,
      tags: TagsSchema,
    }),
  ),
})

/** ffprobe's `-of json` output → Probe; undefined when it isn't such a document. */
export function parseProbe(stdout: string): Probe | undefined {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const parsed = ProbeSchema.safeParse(json)
  if (!parsed.success) return undefined
  const { streams = [], format } = parsed.data
  const probed = streams.flatMap((stream): ProbedStream[] =>
    stream === undefined
      ? []
      : [
          {
            ...omitUndefined({
              index: stream.index,
              type: stream.codec_type,
              codec: stream.codec_name,
              sampleRateHz: positiveInt(stream.sample_rate),
              channels: stream.channels,
              bitRate: positive(stream.bit_rate),
            }),
            attachedPic: stream.disposition?.attached_pic === 1,
            tags: stream.tags,
          },
        ],
  )
  return {
    formatNames: format?.format_name?.split(',') ?? [],
    tags: format?.tags ?? {},
    streams: probed,
    ...omitUndefined({
      durationSec: format?.duration,
      bitRate: positive(format?.bit_rate),
      audio: probed.find((stream) => stream.type === 'audio' && !stream.attachedPic),
    }),
  }
}

function lowerCaseTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags ?? {})) {
    const name = key.toLowerCase()
    if (typeof value === 'string' && !Object.hasOwn(out, name)) out[name] = value
  }
  return out
}

const positive = (value: number | undefined): number | undefined =>
  value !== undefined && value > 0 ? value : undefined
const positiveInt = (value: number | undefined): number | undefined =>
  value !== undefined && value > 0 ? Math.round(value) : undefined

/**
 * Demuxers that read other files or URLs named inside the input (playlists, concat lists): a
 * downloaded "audio file" must never be one of them, even with `-protocol_whitelist file`.
 */
const REFERENCING_DEMUXERS = new Set(['hls', 'dash', 'concat', 'ffconcat', 'image2'])

// ---------------------------------------------------------------------------------------------
// The codec plan (D14)

export type Muxer = 'mp3' | 'ipod' | 'flac' | 'wav' | 'aiff' | 'webm' | 'opus' | 'ogg'

type Container = {
  ext: string
  /** `id3`: ffmpeg writes no tags; ours (id3.ts) go in afterwards. */
  tags: 'ffmpeg' | 'id3'
  /** Where a cover goes: an attached picture in ffmpeg's pass, our APIC frame, or nowhere. */
  cover: 'ffmpeg' | 'id3' | 'none'
  /** Muxer options that say "no tags" or arrange the file. */
  options: readonly string[]
}

/** The muxer table: our output containers, their extensions and how they get tags and covers. */
export const CONTAINERS: Readonly<Record<Muxer, Container>> = {
  mp3: {
    ext: 'mp3',
    tags: 'id3',
    cover: 'id3',
    options: ['-id3v2_version', '0', '-write_id3v1', '0'],
  },
  ipod: { ext: 'm4a', tags: 'ffmpeg', cover: 'ffmpeg', options: ['-movflags', '+faststart'] },
  flac: { ext: 'flac', tags: 'ffmpeg', cover: 'ffmpeg', options: [] },
  wav: { ext: 'wav', tags: 'ffmpeg', cover: 'none', options: [] },
  aiff: { ext: 'aiff', tags: 'id3', cover: 'id3', options: ['-write_id3v2', '0'] },
  webm: { ext: 'webm', tags: 'ffmpeg', cover: 'none', options: [] },
  opus: { ext: 'opus', tags: 'ffmpeg', cover: 'none', options: [] },
  ogg: { ext: 'ogg', tags: 'ffmpeg', cover: 'none', options: [] },
}

/** Codecs whose bitrate is worth showing; PCM and FLAC are as big as they are. */
const LOSSY_CODECS = new Set(['mp3', 'aac', 'opus', 'vorbis'])

export type AudioPlan = {
  muxer: Muxer
  ext: string
  /** `-c:a copy`, or an encoder and its options. */
  codecArgs: string[]
  /** The codec ffprobe must report for the output. */
  codec: string
  /** False when the stream is copied as is (JobOutput.encoded). */
  encoded: boolean
  /**
   * Pass `-xerror`: the pass decodes, and the source isn't MP3. ffmpeg skips the junk an MP3 can
   * carry mid-stream (another file's ID3 tag in a stitched podcast, "Header missing") unless
   * `-xerror` makes it fatal; the output's duration check judges such a file (ADR-015).
   */
  xerror: boolean
  /** More than two channels, mixed down to stereo (forces an encode). */
  downmix: boolean
  tags: Container['tags']
  cover: Container['cover']
}

type Target = { muxer: Muxer; codec: string; encoder: string[] }

const TARGETS: Readonly<Record<Exclude<DownloadFormat, 'original'>, Target>> = {
  // An MP3 source stays at its own bitrate (ADR-004 as amended by D1).
  mp3: { muxer: 'mp3', codec: 'mp3', encoder: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
  m4a: { muxer: 'ipod', codec: 'aac', encoder: ['-c:a', 'aac', '-b:a', '256k'] },
  // 16-bit: yt-dlp's own FLAC from Opus is 24-bit, more than any lossy source holds.
  flac: { muxer: 'flac', codec: 'flac', encoder: ['-c:a', 'flac', '-sample_fmt', 's16'] },
  wav: { muxer: 'wav', codec: 'pcm_s16le', encoder: ['-c:a', 'pcm_s16le'] },
  aiff: { muxer: 'aiff', codec: 'pcm_s16be', encoder: ['-c:a', 'pcm_s16be'] },
}

/** WAV and AIFF store sizes in 32 bits. */
const MAX_PCM_BYTES = 2 ** 32

/**
 * How the downloaded stream becomes the target format: copied when it already has the target
 * codec (and at most two channels), encoded otherwise, at its native sample rate. "Original" copies
 * into a container from a closed table. Throws StepError(postprocess_failed) when the download has
 * no audio, is a playlist, can't be kept as "original", or is too long for WAV/AIFF.
 */
export function planAudio(format: DownloadFormat, source: Probe): AudioPlan {
  if (source.formatNames.some((name) => REFERENCING_DEMUXERS.has(name))) {
    throw new StepError('postprocess_failed', "The download isn't an audio file.")
  }
  const audio = source.audio
  if (audio === undefined) {
    throw new StepError('postprocess_failed', 'The download has no audio.')
  }
  const sourceCodec = audio.codec ?? ''

  if (format === 'original') {
    const muxer = originalMuxer(source.formatNames, sourceCodec)
    if (muxer === undefined) {
      throw new StepError(
        'postprocess_failed',
        `DJ Scraper can't keep this audio (${sourceCodec || 'unknown codec'}) as the original. Choose MP3, M4A, FLAC, WAV or AIFF.`,
      )
    }
    return plan(muxer, sourceCodec, ['-c:a', 'copy'], { encoded: false, downmix: false })
  }

  const target = TARGETS[format]
  const downmix = audio.channels !== undefined && audio.channels > 2
  const copy = sourceCodec === target.codec && !downmix
  const result = copy
    ? plan(target.muxer, target.codec, ['-c:a', 'copy'], { encoded: false, downmix: false })
    : plan(target.muxer, target.codec, target.encoder, {
        encoded: true,
        downmix,
        lenientDecode: sourceCodec === 'mp3',
      })

  if (result.muxer === 'wav' || result.muxer === 'aiff') {
    const channels = downmix ? 2 : (audio.channels ?? 2)
    const bytes = (source.durationSec ?? 0) * (audio.sampleRateHz ?? 48_000) * channels * 2
    if (bytes >= MAX_PCM_BYTES) {
      throw new StepError(
        'postprocess_failed',
        `This track is too long for ${format.toUpperCase()} (4 GB at most). Choose FLAC instead.`,
      )
    }
  }
  return result
}

function plan(
  muxer: Muxer,
  codec: string,
  codecArgs: string[],
  how: { encoded: boolean; downmix: boolean; lenientDecode?: boolean },
): AudioPlan {
  const container = CONTAINERS[muxer]
  return {
    muxer,
    ext: container.ext,
    codecArgs,
    codec,
    encoded: how.encoded,
    xerror: how.encoded && how.lenientDecode !== true,
    downmix: how.downmix,
    tags: container.tags,
    cover: container.cover,
  }
}

/** The container a copied stream goes into for "original"; undefined when there is none. */
export function originalMuxer(formatNames: readonly string[], codec: string): Muxer | undefined {
  const isIn = (...names: string[]) => names.some((name) => formatNames.includes(name))
  if (isIn('matroska', 'webm') && (codec === 'opus' || codec === 'vorbis')) return 'webm'
  if (isIn('mov', 'mp4', 'm4a') && codec === 'aac') return 'ipod'
  if (isIn('ogg') && codec === 'opus') return 'opus'
  if (isIn('ogg') && codec === 'vorbis') return 'ogg'
  switch (codec) {
    case 'mp3':
      return 'mp3'
    case 'flac':
      return 'flac'
    case 'aac':
      return 'ipod'
    case 'opus':
      return 'webm'
    case 'vorbis':
      return 'ogg'
    default:
      return undefined
  }
}

/**
 * D3: whether the file a download makes can hold a cover, as far as is known before yt-dlp picks
 * the stream, so the thumbnail is fetched only when it can be used. WAV can't. "Original" keeps the
 * stream's own codec (`originalMuxer`): YouTube's best audio (`ba`) is its Opus stream, kept in
 * WebM, which can't either; elsewhere it is usually an MP3, AAC or FLAC, which gets its cover.
 */
export function canHoldCover(format: DownloadFormat, platform: Platform): boolean {
  if (format === 'original') return platform !== 'youtube'
  return CONTAINERS[TARGETS[format].muxer].cover !== 'none'
}

// ---------------------------------------------------------------------------------------------
// ffmpeg argv

/** Every pass: quiet, never asks, never overwrites. */
export const FFMPEG_HEAD = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n'] as const
/** Only local files: a downloaded file can't make ffmpeg fetch URLs. */
const LOCAL_ONLY = ['-protocol_whitelist', 'file'] as const

export type ImageDemuxer = 'jpeg_pipe' | 'png_pipe' | 'webp_pipe'

/** Down-scales to fit 1000×1000, never up. */
export const COVER_SCALE =
  "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease"

/** The cover pass (D3): the written thumbnail → a baseline JPEG of at most 1000 px. */
export function coverArgs(source: string, demuxer: ImageDemuxer, output: string): string[] {
  return [
    ...FFMPEG_HEAD,
    '-xerror',
    ...LOCAL_ONLY,
    '-f',
    demuxer,
    '-i',
    source,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    COVER_SCALE,
    '-c:v',
    'mjpeg',
    '-q:v',
    '2',
    '-pix_fmt',
    'yuvj420p',
    '-f',
    'image2',
    '-update',
    '1',
    output,
  ]
}

/** An attached front cover; without the disposition M4A fails and FLAC drops it (facts). */
const PICTURE_ARGS = [
  '-c:v',
  'copy',
  '-disposition:v:0',
  'attached_pic',
  '-metadata:s:v:0',
  'title=Album cover',
  '-metadata:s:v:0',
  'comment=Cover (front)',
] as const

const METADATA_KEYS = [
  ['title', 'title'],
  ['artist', 'artist'],
  ['album', 'album'],
  ['albumArtist', 'album_artist'],
  ['year', 'date'],
  ['comment', 'comment'],
] as const satisfies readonly (readonly [keyof Tags, string])[]

export type AudioPass = {
  plan: AudioPlan
  input: string
  /** Our cover.jpg; only used when the container takes the cover from ffmpeg (m4a, flac). */
  cover?: string
  output: string
  tags: Tags
}

/**
 * The audio pass (D14): only the first audio stream (+ the cover), the source's tags and chapters
 * dropped, ours written where ffmpeg can (m4a ©cmt, WAV ICMT, WebM COMMENT, FLAC/Ogg DESCRIPTION),
 * none for MP3/AIFF. `-xerror` as the plan says. Never `-vn`: it silently drops a mapped cover (§9).
 */
export function audioArgs({ plan, input, cover, output, tags }: AudioPass): string[] {
  const withCover = cover !== undefined && plan.cover === 'ffmpeg'
  const args: string[] = [...FFMPEG_HEAD]
  if (plan.xerror) args.push('-xerror')
  args.push(...LOCAL_ONLY, '-i', input)
  if (withCover) args.push(...LOCAL_ONLY, '-f', 'jpeg_pipe', '-i', cover)
  args.push('-map', '0:a:0')
  if (withCover) args.push('-map', '1:v:0')
  args.push(...plan.codecArgs)
  if (plan.downmix) args.push('-ac', '2')
  if (withCover) args.push(...PICTURE_ARGS)
  args.push('-map_metadata', '-1', '-map_chapters', '-1')
  if (plan.tags === 'ffmpeg') {
    for (const [key, name] of METADATA_KEYS) {
      const value = tags[key]
      if (value !== undefined) args.push('-metadata', `${name}=${value}`)
    }
  }
  args.push(...CONTAINERS[plan.muxer].options, '-f', plan.muxer, output)
  return args
}

// ---------------------------------------------------------------------------------------------
// The measured duration of an MP3

/**
 * Whether ffprobe's duration may be a guess: for an MP3 without a Xing/Info header (VBR podcasts,
 * files stitched together), the mp3 demuxer estimates it from the first frame's bitrate ("Estimating
 * duration from bitrate", only at `-v warning`): a 600 s VBR file probed as 2,413 s. Such a source
 * is measured (`measureArgs`) before any duration check.
 */
export const needsMeasuredDuration = (probe: Probe): boolean => probe.formatNames.includes('mp3')

/**
 * The measuring pass: the first audio stream's packets copied to the null muxer, which decodes
 * nothing (~150 MB/s) and reports the real end time on stdout (`-progress pipe:1`).
 */
export function measureArgs(file: string): string[] {
  return [
    ...FFMPEG_HEAD,
    '-nostats',
    '-progress',
    'pipe:1',
    ...LOCAL_ONLY,
    '-i',
    file,
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-f',
    'null',
    '-',
  ]
}

/**
 * The duration the measuring pass found, in seconds: the last `out_time_us` of a report that ended
 * (`progress=end`). Undefined without one, or when it is not a positive number of microseconds.
 */
export function parseMeasuredDuration(stdout: string): number | undefined {
  let micros: string | undefined
  let ended = false
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const [key, value] = line.trim().split('=', 2)
    if (key === 'out_time_us') micros = value
    if (key === 'progress') ended = value === 'end'
  }
  if (!ended || micros === undefined || !/^\d{1,15}$/.test(micros)) return undefined
  const seconds = Number(micros) / 1_000_000
  return seconds > 0 ? seconds : undefined
}

// ---------------------------------------------------------------------------------------------
// Covers (D3)

const PLACEHOLDER_THUMBNAILS = [
  /^https?:\/\/i\.ytimg\.com\/img\/no_thumbnail\.jpg(?:[?#]|$)/,
  /^https?:\/\/a\d*\.sndcdn\.com\/images\/default_avatar_\w+\.(?:png|jpg)(?:[?#]|$)/,
  // A track without artwork shows its uploader's profile photo: not a cover.
  /^https?:\/\/[a-z0-9-]+\.sndcdn\.com\/avatars-/,
]

/** A stand-in image: worse than no artwork in a DJ's library. */
export function isPlaceholderThumbnail(url: string | undefined): boolean {
  return url !== undefined && PLACEHOLDER_THUMBNAILS.some((pattern) => pattern.test(url))
}

/** The image demuxer for a file's first bytes (at least 12), or undefined if it isn't one we take. */
export function sniffImage(head: Uint8Array): ImageDemuxer | undefined {
  const starts = (bytes: readonly number[], at = 0) =>
    bytes.every((byte, i) => head[at + i] === byte)
  if (starts([0xff, 0xd8, 0xff])) return 'jpeg_pipe'
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png_pipe'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp_pipe'
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Verification (D15)

/** Durations agree within max(2 s, min(1 %, 10 s)) of `reference`. */
export function sameDuration(reference: number, other: number): boolean {
  const tolerance = Math.max(2, Math.min(reference * 0.01, 10))
  return Math.abs(reference - other) <= tolerance
}

/**
 * Whether the downloaded file is all there: its probed duration against the one yt-dlp reported.
 * A problem here is a network failure (an HLS fragment lost, a cut connection), not ffmpeg's.
 */
export function downloadProblem(
  source: Probe,
  reportedSec: number | undefined,
): string | undefined {
  if (reportedSec === undefined || reportedSec <= 0 || source.durationSec === undefined) {
    return undefined
  }
  return sameDuration(reportedSec, source.durationSec)
    ? undefined
    : 'The download is incomplete. Try again.'
}

/**
 * Whether ffmpeg's output is what the plan asked for: ffmpeg exits 0 on truncated input and on an
 * existing output, so its exit code alone proves nothing. Undefined when it is; else the problem.
 */
export function outputProblem(
  plan: AudioPlan,
  check: { source: Probe; output: Probe; tags: Tags; coverPlanned: boolean },
): string | undefined {
  const { source, output } = check
  const audio = output.audio
  if (audio === undefined) return 'The converted file has no audio.'
  if (audio.codec !== plan.codec) return 'The converted file has the wrong format.'
  if (plan.tags === 'ffmpeg') {
    // Ogg keeps its tags on the stream; WebM reads keys back in upper case.
    const written = { ...audio.tags, ...output.tags }
    if (
      (check.tags.title !== undefined && written.title === undefined) ||
      (check.tags.artist !== undefined && written.artist === undefined)
    ) {
      return 'The converted file is missing its tags.'
    }
  }
  if (check.coverPlanned && plan.cover === 'ffmpeg' && !output.streams.some((s) => s.attachedPic)) {
    return 'The converted file is missing its cover.'
  }
  if (source.durationSec !== undefined) {
    if (output.durationSec === undefined || !sameDuration(source.durationSec, output.durationSec)) {
      // A truncated WebM still probes with its full declared duration: this is what catches it.
      return 'The converted file is incomplete: the download may be damaged. Try again.'
    }
  }
  return undefined
}

/** What the job reports about the file, read back from it (never from the requested format). */
export function outputInfo(plan: AudioPlan, output: Probe): JobOutput {
  const audio = output.audio
  const codec = audio?.codec ?? plan.codec
  const bitRate = LOSSY_CODECS.has(codec) ? (audio?.bitRate ?? output.bitRate) : undefined
  const kbps = bitRate !== undefined ? Math.round(bitRate / 1000) : undefined
  return {
    ext: plan.ext,
    codec,
    ...omitUndefined({
      bitrateKbps: kbps !== undefined && kbps > 0 ? kbps : undefined,
      sampleRateHz: audio?.sampleRateHz,
      channels: audio?.channels,
    }),
    encoded: plan.encoded,
  }
}

// ---------------------------------------------------------------------------------------------
// ffmpeg's stderr

/** ffmpeg 8 nests contexts: `[aist#0:0/mp3 @ 0x…] [dec:mp3float @ 0x…] Terminating thread …`. */
const CONTEXT_PREFIX = /^(?:\[[^\]]* @ 0x[0-9a-f]+\] )+/
/** ffmpeg 8 prints this for every Opus-in-WebM read, also for good files (facts). */
const OPUS_NOISE = /Error parsing Opus packet header/
/** ffmpeg 8's trailers after the line that says what failed: they only repeat its error code. */
const TRAILER =
  /^(?:Terminating thread with return code|Task finished with error code|Last message repeated)\b/
const DISK_FULL = /\bNo space left on device\b|\bDis[ck] quota exceeded\b/i
const MAX_ERROR_TEXT = 300

/**
 * The line that says why ffmpeg failed: the last non-empty stderr line without its `[name @ 0x…] `
 * prefixes, skipping the Opus noise and the thread trailers (unless nothing else is left).
 * `jobDir` is cut out: messages never carry paths.
 */
export function ffmpegErrorText(stderr: string, jobDir?: string): string | undefined {
  const lines = stderr
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(CONTEXT_PREFIX, ''))
    .filter((line) => line !== '' && !OPUS_NOISE.test(line))
  const chosen = lines.findLast((line) => !TRAILER.test(line)) ?? lines.at(-1)
  if (chosen === undefined) return undefined
  let text = chosen
  if (jobDir !== undefined && jobDir !== '') text = text.split(jobDir).join('…')
  return Array.from(text).slice(0, MAX_ERROR_TEXT).join('')
}

/**
 * Whether ffmpeg failed for a full drive (ENOSPC, EDQUOT): it writes only into the job dir, whose
 * path (cut out first) can't count as the reason.
 */
export function ffmpegDiskFull(stderr: string, jobDir?: string): boolean {
  const text = jobDir === undefined || jobDir === '' ? stderr : stderr.split(jobDir).join('…')
  return DISK_FULL.test(text)
}
