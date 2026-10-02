import path from 'node:path'
import { parseArgs } from 'node:util'
import { PortSchema, SERVER_PORT } from '@dj-scraper/shared'
import * as z from 'zod'
import type { EngineEnv } from './engine/binaries.ts'

/**
 * The web app's build output, found from this file: the server runs from the repo (ADR-009), so
 * it is apps/web/dist whatever the cwd.
 */
export const DEFAULT_WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist')

/** An empty variable counts as unset, so `YTDLP_PATH= pnpm dev` falls back to PATH. */
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value)

const AbsolutePathSchema = z.preprocess(
  unsetIfEmpty,
  z
    .string()
    .refine((value) => path.isAbsolute(value), 'must be an absolute path (~ is not expanded)')
    .optional(),
)

const EnvSchema = z.object({
  PORT: z.preprocess(unsetIfEmpty, PortSchema.default(SERVER_PORT)),
  YTDLP_PATH: AbsolutePathSchema,
  /** The ffmpeg binary, or a directory holding ffmpeg and ffprobe (like --ffmpeg-location). */
  FFMPEG_PATH: AbsolutePathSchema,
  /** The built UI to serve instead of apps/web/dist (tests, the e2e server). */
  DJS_WEB_DIST: AbsolutePathSchema,
  PATH: z.string().optional(),
})

export type Config = {
  port: number
  /** `--dev`: started by `pnpm dev`, so the Vite dev server (WEB_DEV_PORT) may call the API. */
  dev: boolean
  /** `--open`: open the UI in the default browser once listening (`pnpm start`). Not with --dev. */
  open: boolean
  /** The built UI, served when not in dev mode. */
  webDist: string
  engine: EngineEnv
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const FLAGS = {
  dev: { type: 'boolean', default: false },
  open: { type: 'boolean', default: false },
} as const

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  let flags: { dev: boolean; open: boolean }
  try {
    flags = parseArgs({ args: [...argv], options: FLAGS }).values
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error))
  }
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success)
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  const { PORT, DJS_WEB_DIST, ...engine } = parsed.data
  return { port: PORT, ...flags, webDist: DJS_WEB_DIST ?? DEFAULT_WEB_DIST, engine }
}
