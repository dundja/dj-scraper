import * as z from 'zod'

/** Where a binary came from: the YTDLP_PATH/FFMPEG_PATH override, or a PATH search. */
export const ToolSourceSchema = z.enum(['env', 'path'])
export type ToolSource = z.infer<typeof ToolSourceSchema>

const found = {
  status: z.literal('ok'),
  path: z.string().min(1),
  source: ToolSourceSchema,
  /** As the tool prints it, e.g. `2026.08.19`, `8.0`, `N-127085-g0eb6a369c69-tessus`. */
  version: z.string().min(1),
}

/** Not found. `message` says how to install it or fix the override. */
const MissingSchema = z.object({ status: z.literal('missing'), message: z.string().min(1) })

/** Found but unusable: not executable, won't start, timed out, failed, or printed no version. */
const BrokenSchema = z.object({
  status: z.literal('error'),
  path: z.string().min(1),
  source: ToolSourceSchema,
  message: z.string().min(1),
})

export const YtdlpHealthSchema = z.discriminatedUnion('status', [
  z.object({
    ...found,
    releaseDate: z.iso.date(),
    ageDays: z.int().nonnegative(),
    /** Older than 60 days, so it may miss YouTube fixes. A warning, not a failure. */
    stale: z.boolean(),
    /** At least 2025.11.12, the first release with `--js-runtimes`, which we always pass. */
    meetsMinimum: z.boolean(),
  }),
  MissingSchema,
  BrokenSchema,
])
export type YtdlpHealth = z.infer<typeof YtdlpHealthSchema>

const ffFound = {
  ...found,
  /** From the release number, or libavformat's for git builds; omitted when neither parses. */
  major: z.int().nonnegative().optional(),
  /** major >= 8 */
  meetsMinimum: z.boolean(),
}

export const FfmpegHealthSchema = z.discriminatedUnion('status', [
  /** `mp3`: built with libmp3lame, the encoder yt-dlp uses for MP3. */
  z.object({ ...ffFound, mp3: z.boolean() }),
  MissingSchema,
  BrokenSchema,
])
export type FfmpegHealth = z.infer<typeof FfmpegHealthSchema>

export const FfprobeHealthSchema = z.discriminatedUnion('status', [
  z.object(ffFound),
  MissingSchema,
  BrokenSchema,
])
export type FfprobeHealth = z.infer<typeof FfprobeHealthSchema>

/** A JS runtime yt-dlp can use for YouTube, in yt-dlp's priority order (deno, then our node). */
export const JsRuntimeSchema = z.object({
  name: z.enum(['deno', 'node']),
  path: z.string().min(1),
  version: z.string().min(1),
  /** deno >= 2.3.0, node >= 22: yt-dlp skips older ones. */
  supported: z.boolean(),
})
export type JsRuntime = z.infer<typeof JsRuntimeSchema>

/** `GET /api/health`: can the engine run, and what would the UI warn about. */
export const HealthSchema = z.object({
  /** yt-dlp, ffmpeg and ffprobe found and at their minimums, and a supported JS runtime exists. */
  ok: z.boolean(),
  checkedAt: z.iso.datetime(),
  ytdlp: YtdlpHealthSchema,
  ffmpeg: FfmpegHealthSchema,
  ffprobe: FfprobeHealthSchema,
  jsRuntimes: z.array(JsRuntimeSchema),
})
export type Health = z.infer<typeof HealthSchema>
