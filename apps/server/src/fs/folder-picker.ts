import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises'
import path from 'node:path'
import { FolderPathSchema, type FolderPickResponse } from '@dj-scraper/shared'
import { type RunResult, run as runProcess, SpawnError } from '../engine/run.ts'
import { ApiError } from '../http/errors.ts'
import type { Logger } from '../resolve/ytdlp-call.ts'

/**
 * The macOS folder picker: `choose folder` run by osascript itself, with no `tell` block, so it
 * needs no Automation consent and killing osascript closes the dialog. The start folder arrives as
 * argv (never interpolated into the script); a missing one would fail the `as alias` coercion, so
 * the `try` leaves it out. The user's Cancel (-128) becomes an empty answer.
 */
export const PICK_SCRIPT = [
  'on run argv',
  'set startIn to missing value',
  'if (count of argv) > 0 then',
  'try',
  'set startIn to (POSIX file (item 1 of argv)) as alias',
  'end try',
  'end if',
  'activate',
  'try',
  'if startIn is missing value then',
  'set chosen to choose folder with prompt "Choose a download folder"',
  'else',
  'set chosen to choose folder with prompt "Choose a download folder" default location startIn',
  'end if',
  'on error number -128',
  'return ""',
  'end try',
  'return POSIX path of chosen',
  'end run',
] as const

/** The user may take their time, but a dialog nobody answers mustn't block the picker forever. */
export const PICKER_TIMEOUT_MS = 300_000

const FAILED = 'The folder picker failed'

export type FolderPicker = {
  /**
   * Opens the picker in `startIn` when that is an existing folder. Resolves `{ canceled: true }`
   * when the user cancels, the time runs out or `signal` aborts. Throws ApiError: 409
   * invalid_request while another pick is open, folder_unavailable or unknown otherwise.
   */
  pick(startIn: string | undefined, signal?: AbortSignal): Promise<FolderPickResponse>
}

export type FolderPickerDeps = {
  bin?: string
  run?: typeof runProcess
  timeoutMs?: number
  stat?: (file: string) => Promise<{ isDirectory(): boolean }>
  realpath?: (file: string) => Promise<string>
  log?: Logger
}

/** osascript's argv: the script line by line, then `--` and the start folder, if any. */
export function pickerArgv(startIn: string | undefined): string[] {
  const start = startIn === undefined ? [] : [startIn]
  return [...PICK_SCRIPT.flatMap((line) => ['-e', line]), '--', ...start]
}

export function createFolderPicker(deps: FolderPickerDeps = {}): FolderPicker {
  const {
    bin = '/usr/bin/osascript',
    run = runProcess,
    timeoutMs = PICKER_TIMEOUT_MS,
    stat = fsStat,
    realpath = fsRealpath,
    log = console,
  } = deps
  let open = false

  const isDirectory = async (file: string): Promise<boolean> => {
    if (!path.isAbsolute(file)) return false
    try {
      return (await stat(file)).isDirectory()
    } catch {
      return false
    }
  }

  /** osascript's answer: one line with the folder's POSIX path, which ends in `/`. */
  async function chosen(stdout: string): Promise<FolderPickResponse> {
    // Strip exactly one newline: a folder name may contain (or end in) one.
    const answer = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
    if (answer === '') return { canceled: true }
    if (!answer.startsWith('/')) {
      log.warn('[folders] the folder picker answered something other than a path')
      throw new ApiError('unknown', FAILED)
    }
    const picked = answer.length > 1 && answer.endsWith('/') ? answer.slice(0, -1) : answer
    let real: string | undefined
    try {
      if (await isDirectory(picked)) real = await realpath(picked)
    } catch {
      real = undefined
    }
    if (real === undefined) {
      throw new ApiError('folder_unavailable', 'The chosen folder is no longer available')
    }
    if (!FolderPathSchema.safeParse(real).success) {
      throw new ApiError(
        'folder_unavailable',
        "DJ Scraper can't use this folder: its path is too long or has a control character in it",
      )
    }
    return { path: real }
  }

  function outcome(result: RunResult): Promise<FolderPickResponse> | FolderPickResponse {
    if (result.timedOut || result.aborted) return { canceled: true }
    if (result.exitCode === 0) return chosen(result.stdout)
    if (/\(-128\)/.test(result.stderr)) return { canceled: true }
    if (/\(-1713\)\s*$/.test(result.stderr)) {
      throw new ApiError('unknown', 'The folder picker needs the Mac desktop session')
    }
    // The AppleScript error number only: stderr may quote paths.
    const number = /\((-?\d+)\)\s*$/.exec(result.stderr)?.[1]
    const exit = result.signal ?? `exit ${result.exitCode}`
    log.warn(`[folders] the folder picker failed (${exit}${number ? `, error ${number}` : ''})`)
    throw new ApiError('unknown', FAILED)
  }

  return {
    async pick(startIn, signal) {
      if (open) {
        throw new ApiError('invalid_request', 'A folder picker is already open', { status: 409 })
      }
      open = true
      try {
        const start = startIn !== undefined && (await isDirectory(startIn)) ? startIn : undefined
        let result: RunResult
        try {
          result = await run(bin, pickerArgv(start), { timeoutMs, signal })
        } catch (error) {
          if (signal?.aborted) return { canceled: true }
          if (!(error instanceof SpawnError)) throw error
          log.warn(`[folders] cannot start the folder picker (${error.code})`)
          throw new ApiError('unknown', FAILED)
        }
        return await outcome(result)
      } finally {
        open = false
      }
    },
  }
}
