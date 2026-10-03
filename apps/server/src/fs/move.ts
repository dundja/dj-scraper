import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  type PartRecord,
  type Publish,
  type PublishRequest,
  type PublishResult,
  StepError,
} from '../jobs/types.ts'
import { errnoCode } from '../util/errno.ts'
import { folderError, recheckFolder } from './folders.ts'

/**
 * Publishing a finished file into the user's folder without ever overwriting (design D10).
 *
 * - Same volume: `link(src, dest)` claims the name atomically; EEXIST means a file of that name is
 *   already there (case- and normalization-insensitively on APFS and exFAT), so the job is skipped.
 *   `rename` would silently replace it, on every volume (facts: macos.md §5).
 * - Another volume (EXDEV), or a volume without hard links (FAT/exFAT: ENOTSUP, SMB: EPERM,
 *   EMLINK): first record `<jobsDir>/<attemptId>.part.json`, so the startup sweep can find what we
 *   leave behind; then copy to `<folder>/.djs-<attemptId>.part` and fsync it (abortable). Then claim
 *   with `link(part, dest)`, or on FAT/exFAT reserve the name with an exclusive create and rename
 *   the part onto our own empty placeholder.
 * - The claim is the only step an abort doesn't stop. Claims run one at a time (one module-level
 *   lock), each right after re-resolving the folder: it must still be the folder resolved at
 *   enqueue (never created here). An abort while a job waits for its turn, or during that check,
 *   stops it before the claim.
 * - On any error or abort, the part (and a placeholder of ours) is removed. The record stays when
 *   the part can't be removed, or when its folder is gone with it (renamed, a drive unplugged).
 */

export type PublishOps = {
  link: (existing: string, newPath: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  /** Copies `src` into the new file `dest` (EEXIST if it exists), stopping on `signal`; then fsync. */
  copyFile: (src: string, dest: string, signal: AbortSignal) => Promise<void>
  /** Exclusive create: the name reservation on volumes without hard links. */
  open: (path: string, flags: 'wx') => Promise<{ close(): Promise<void> }>
  rename: (from: string, to: string) => Promise<void>
  lstat: (path: string) => Promise<{ size: number }>
  /** realpath(3): symlinks and the on-disk case resolved. */
  realpath: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ isDirectory(): boolean }>
  writeFile: (path: string, data: string, options: { mode: number }) => Promise<void>
}

const DEFAULT_OPS: PublishOps = {
  link,
  unlink,
  copyFile: streamCopy,
  open: (file, flags) => open(file, flags),
  rename,
  lstat,
  realpath,
  stat,
  writeFile: (file, data, options) => writeFile(file, data, { mode: options.mode }),
}

/** Errors of `link` that mean "no hard link here", not "no": copy instead. */
const NO_HARD_LINK = new Set(['EXDEV', 'ENOTSUP', 'EPERM', 'EMLINK'])
/** Volumes that refuse hard links even within themselves: reserve and rename instead. */
const RESERVE_INSTEAD = new Set(['ENOTSUP', 'EPERM'])
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolves once every claim queued so far has finished (or given up its turn). Never rejects. */
let claimTail: Promise<void> = Promise.resolve()

/**
 * Runs `claim` after every claim before it has finished: one at a time in this process. The wait
 * for the turn stops at once on abort (a hung claim on a stalled drive holds up only its own job);
 * the turn still passes on in order, after the claims before it. Once begun, a claim runs to its end.
 */
async function withClaimLock<T>(signal: AbortSignal, claim: () => Promise<T>): Promise<T> {
  const before = claimTail
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  claimTail = before.then(() => finished)
  try {
    await untilAborted(before, signal)
    signal.throwIfAborted()
    return await claim()
  } finally {
    finish()
  }
}

/** Resolves with `promise`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const onAbort = () => reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
}

export function createPublish(ops: Partial<PublishOps> = {}): Publish {
  const fs: PublishOps = { ...DEFAULT_OPS, ...ops }

  return async (request: PublishRequest): Promise<PublishResult> => {
    const { src, folder, name, attemptId, signal } = request
    if (!isFileName(name) || !ATTEMPT_ID.test(attemptId)) {
      throw new StepError('unknown', "The file name can't be used.")
    }
    const dest = path.join(folder.real, name)
    signal.throwIfAborted()

    const same = await withClaimLock(signal, async () => {
      await recheckFolder(folder, fs)
      signal.throwIfAborted()
      try {
        await fs.link(src, dest)
        return 'moved'
      } catch (error) {
        const code = errnoCode(error)
        if (code === 'EEXIST') return 'exists'
        if (code !== undefined && NO_HARD_LINK.has(code)) return 'copy'
        throw await publishError(fs, error, src)
      }
    })
    if (same === 'moved') {
      await fs.unlink(src).catch(() => {})
      return { status: 'moved', path: dest }
    }
    if (same === 'exists') return { status: 'exists', path: dest }
    return copyAcross(fs, request, dest)
  }
}

async function copyAcross(
  fs: PublishOps,
  { src, folder, name, attemptId, jobsDir, signal }: PublishRequest,
  dest: string,
): Promise<PublishResult> {
  const part = path.join(folder.real, `.djs-${attemptId}.part`)
  const record = path.join(jobsDir, `${attemptId}.part.json`)
  const writeRecord = (content: PartRecord) =>
    fs.writeFile(record, JSON.stringify(content), { mode: 0o600 })

  await writeRecord({ partPath: part }).catch(async (error: unknown) => {
    throw await publishError(fs, error, src)
  })
  // What may be ours in the user's folder until the claim is through.
  let partExists = true
  let placeholder = false
  try {
    signal.throwIfAborted()
    await fs.copyFile(src, part, signal)
    signal.throwIfAborted()

    const claimed = await withClaimLock(signal, async (): Promise<PublishResult['status']> => {
      await recheckFolder(folder, fs)
      signal.throwIfAborted()
      try {
        await fs.link(part, dest)
        return 'moved'
      } catch (error) {
        const code = errnoCode(error)
        if (code === 'EEXIST') return 'exists'
        if (code === undefined || !RESERVE_INSTEAD.has(code)) throw error
      }
      // FAT/exFAT: an exclusive create decides who gets the name; then our part replaces our own
      // empty placeholder (rename would replace anybody's file, so it only ever targets ours).
      let reserved: { close(): Promise<void> }
      try {
        reserved = await fs.open(dest, 'wx')
      } catch (error) {
        if (errnoCode(error) === 'EEXIST') return 'exists'
        throw error
      }
      // Ours from the create on, so cleanUp removes it even when the close fails.
      placeholder = true
      await reserved.close()
      await writeRecord({ partPath: part, placeholderPath: dest })
      // macOS gives every file on these volumes a `._` sidecar, which follows a rename.
      const sidecar = path.join(folder.real, `._.djs-${attemptId}.part`)
      const hadSidecar = await fs.lstat(sidecar).then(
        () => true,
        () => false,
      )
      await fs.rename(part, dest)
      partExists = false
      placeholder = false
      if (hadSidecar) await fs.unlink(path.join(folder.real, `._${name}`)).catch(() => {})
      return 'moved'
    })
    return { status: claimed, path: dest }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw await publishError(fs, error, src)
  } finally {
    const leftovers = await cleanUp(
      fs,
      partExists ? part : undefined,
      placeholder ? dest : undefined,
    )
    if (leftovers === 0) await fs.unlink(record).catch(() => {})
  }
}

/** Removes our part and our (still empty) placeholder; returns how many are left behind. */
async function cleanUp(
  fs: PublishOps,
  part: string | undefined,
  placeholder: string | undefined,
): Promise<number> {
  let left = 0
  if (part !== undefined && !(await removeIfThere(fs, part))) left++
  if (placeholder !== undefined) {
    const size = await fs.lstat(placeholder).then(
      (stats) => stats.size,
      () => undefined,
    )
    if (size === 0 && !(await removeIfThere(fs, placeholder))) left++
  }
  return left
}

/**
 * True once `file` is gone. ENOENT proves that only while its folder is still there: a folder that
 * was renamed or whose drive was unplugged took the file with it, and the record must stay for the
 * startup sweep.
 */
async function removeIfThere(fs: PublishOps, file: string): Promise<boolean> {
  try {
    await fs.unlink(file)
    return true
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') return false
    return fs.stat(path.dirname(file)).then(
      (stats) => stats.isDirectory(),
      () => false,
    )
  }
}

/** A single component: no separators, not `.`/`..`, no NUL. */
function isFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\u{0}') &&
    path.basename(name) === name
  )
}

/** Maps a failed step by its errno code (fs error messages hold paths). */
async function publishError(fs: PublishOps, error: unknown, src: string): Promise<StepError> {
  if (error instanceof StepError) return error
  const code = errnoCode(error)
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return new StepError('disk_full', 'The drive is full. Free some space, then retry.')
    case 'EFBIG':
      return new StepError('unknown', 'The file is too large for this drive (FAT32 holds 4 GB).')
    case 'ENAMETOOLONG':
      return new StepError('unknown', 'The file name is too long for this folder.')
    case 'EIO':
    case 'ENXIO':
    case 'ENODEV':
      return new StepError(
        'folder_unavailable',
        "The folder's drive stopped responding. Check that it is connected, then retry.",
      )
    case 'ENOENT': {
      // Either our finished file or the folder is gone; the folder was checked just before.
      const srcThere = await fs.lstat(src).then(
        () => true,
        () => false,
      )
      return srcThere
        ? folderError(error)
        : new StepError('unknown', 'The finished file disappeared before it could be moved.')
    }
    default:
      return folderError(error)
  }
}

/** The default copy: a stream into a new file (`wx`), fsynced (`flush`) so "done" means on the drive. */
export async function streamCopy(src: string, dest: string, signal: AbortSignal): Promise<void> {
  await pipeline(createReadStream(src), createWriteStream(dest, { flags: 'wx', flush: true }), {
    signal,
  })
}
