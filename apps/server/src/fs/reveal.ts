import { lstat as fsLstat } from 'node:fs/promises'
import path from 'node:path'
import { type RunResult, run as runProcess, SpawnError } from '../engine/run.ts'
import { StepError } from '../jobs/types.ts'
import { errnoCode } from '../util/errno.ts'

/** `open -R` hands the file to Finder and returns; it never waits for the user. */
export const REVEAL_TIMEOUT_MS = 10_000

const MOVED = 'The file was moved, deleted, or its drive is unplugged'
const FAILED = "The file couldn't be shown in Finder"

export type RevealDeps = {
  bin?: string
  run?: typeof runProcess
  lstat?: (file: string) => Promise<unknown>
}

/**
 * Selects `file` in a Finder window (`open -R`, which needs no Automation consent). Take the path
 * from the server's job record, never from a request. Throws StepError: not_found when the file
 * is gone, unknown otherwise.
 */
export async function revealInFinder(file: string, deps: RevealDeps = {}): Promise<void> {
  const { bin = '/usr/bin/open', run = runProcess, lstat = fsLstat } = deps
  if (!path.isAbsolute(file)) throw new TypeError('revealInFinder needs an absolute path')
  try {
    await lstat(file)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new StepError('not_found', MOVED)
    throw new StepError('unknown', FAILED)
  }
  let result: RunResult
  try {
    result = await run(bin, ['-R', '--', file], { timeoutMs: REVEAL_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof SpawnError) throw new StepError('unknown', FAILED)
    throw error
  }
  if (result.exitCode === 0 && !result.timedOut) return
  // `The file /… does not exist.`: it went away after the lstat.
  if (result.stderr.trimEnd().endsWith('does not exist.')) throw new StepError('not_found', MOVED)
  throw new StepError('unknown', FAILED)
}
