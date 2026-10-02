import path from 'node:path'
import { parseArgs } from 'node:util'
import { PortSchema, SERVER_PORT } from '@dj-scraper/shared'
import * as z from 'zod'
import type { EngineEnv } from './engine/binaries.ts'

/** An empty variable counts as unset, so `YTDLP_PATH= pnpm dev` falls back to PATH. */
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value)

const BinPathSchema = z.preprocess(
  unsetIfEmpty,
  z
    .string()
    .refine((value) => path.isAbsolute(value), 'must be an absolute path (~ is not expanded)')
    .optional(),
)

const EnvSchema = z.object({
  PORT: z.preprocess(unsetIfEmpty, PortSchema.default(SERVER_PORT)),
  YTDLP_PATH: BinPathSchema,
  /** The ffmpeg binary, or a directory holding ffmpeg and ffprobe (like --ffmpeg-location). */
  FFMPEG_PATH: BinPathSchema,
  PATH: z.string().optional(),
})

export type Config = {
  port: number
  /** `--dev`: started by `pnpm dev`, so the Vite dev server (WEB_DEV_PORT) may call the API. */
  dev: boolean
  engine: EngineEnv
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  let dev: boolean
  try {
    dev = parseArgs({ args: [...argv], options: { dev: { type: 'boolean', default: false } } })
      .values.dev
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error))
  }
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success)
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  const { PORT, ...engine } = parsed.data
  return { port: PORT, dev, engine }
}
