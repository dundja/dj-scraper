/**
 * Pure: options → yt-dlp argv. Every call starts with `baseArgs` (no user config, no self-update,
 * plain UTF-8 output) and ends with `--` and the URL, so a URL can never be read as an option.
 */

/** Per-socket stall limit; the run's own timeout bounds the whole call. */
export const SOCKET_TIMEOUT_SEC = 20

/**
 * Flags for every yt-dlp call. `jsRuntime` is our own Node (`process.execPath`), the fallback for
 * YouTube's JS challenges when deno is missing; it is never user input.
 */
export function baseArgs(jsRuntime: string): string[] {
  return [
    '--ignore-config',
    '--no-update',
    '--color',
    'never',
    '--encoding',
    'utf-8',
    '--js-runtimes',
    `node:${jsRuntime}`,
  ]
}

export type ResolveArgsOptions = {
  url: string
  /** `yes` lists the whole list behind `watch?v=…&list=…`, `no` takes only the track. */
  playlist?: 'yes' | 'no'
  /** The listing cap; one row more is requested, so getting `limit + 1` rows means truncated. */
  limit: number
  jsRuntime: string
}

/** `-J --flat-playlist`: one JSON document for a track or a whole listing, without per-row lookups. */
export function resolveArgs({ url, playlist, limit, jsRuntime }: ResolveArgsOptions): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`)
  }
  return [
    ...baseArgs(jsRuntime),
    '-J',
    '--flat-playlist',
    '-I',
    `1:${limit + 1}`,
    ...(playlist === undefined ? [] : [playlist === 'yes' ? '--yes-playlist' : '--no-playlist']),
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--',
    url,
  ]
}

/**
 * A full single-track lookup, to fill in a partial collection row. A track is extracted in full
 * either way; `--flat-playlist` only matters if the URL turns out to be a list (a short link, an
 * unknown site), which then comes back as one cheap flat page instead of a full extraction of every
 * row. The track fixtures were recorded with it (see the READMEs under test/fixtures).
 */
export function entryArgs({ url, jsRuntime }: { url: string; jsRuntime: string }): string[] {
  return [
    ...baseArgs(jsRuntime),
    '-J',
    '--flat-playlist',
    '--no-playlist',
    '--socket-timeout',
    String(SOCKET_TIMEOUT_SEC),
    '--',
    url,
  ]
}
