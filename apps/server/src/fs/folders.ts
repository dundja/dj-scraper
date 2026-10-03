import { constants } from 'node:fs'
import { access, lstat, mkdir, opendir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  FolderPathSchema,
  MAX_FILENAME_LENGTH,
  normalizeFolderPath,
  sanitizeFolderName,
} from '@dj-scraper/shared'
import { StepError, type TargetFolder } from '../jobs/types.ts'
import { errnoCode } from '../util/errno.ts'

/**
 * The download folder (design D10, D16): checked when it is chosen (the native picker returns it,
 * or the settings change to it), when a batch is enqueued, and again right before each file is
 * published. Errors are StepErrors with texts for the user (never a path): `invalid_request` for a
 * folder value that can't work at all, `folder_unavailable` for a folder that exists in the wrong
 * way (missing, not a folder, not writable, inside the data dir, blocked by macOS privacy
 * settings).
 */

/** The filesystem calls this module makes; tests replace some to script errors. */
export type FolderOps = {
  /** Resolves symlinks and, on case-insensitive volumes, the on-disk case (realpath(3)). */
  realpath: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ isDirectory(): boolean }>
  access: (path: string, mode: number) => Promise<void>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>
  /** Only to read a picked folder's first entry (checkPickedFolder). */
  opendir: (path: string) => Promise<{ read(): Promise<unknown>; close(): Promise<void> }>
}

const DEFAULT_OPS: FolderOps = { realpath, stat, access, mkdir, lstat, opendir }

/** macOS limits a whole path to 1024 bytes, the terminating NUL included. */
const MAX_PATH_BYTES = 1024

export const PRIVACY_MESSAGE =
  'macOS blocked access to this folder. Allow your terminal app under System Settings › Privacy & Security › Files and Folders (or Full Disk Access), then try again.'

export type ResolveFolderContext = {
  /** The app data dir's real path. Downloads never go inside it: the startup sweep empties jobs/. */
  dataDirReal: string
  /**
   * Create the folder and its parents when missing. Only for the default `~/Music/DJ Scraper`: the
   * server never creates a folder the user named.
   */
  create?: boolean
}

/**
 * Resolves the folder a batch downloads into: `given` (an absolute path; one trailing slash is
 * fine) must be an existing, writable directory outside the data dir. `subfolder` becomes one safe
 * folder name inside it, created if missing; a subfolder that is a symlink is refused. The real
 * path plus the longest file name must fit macOS's path limit in bytes.
 */
export async function resolveTargetFolder(
  given: string,
  subfolder: string | undefined,
  context: ResolveFolderContext,
  ops: Partial<FolderOps> = {},
): Promise<TargetFolder> {
  const fs: FolderOps = { ...DEFAULT_OPS, ...ops }
  const folder = normalizeFolderPath(given)
  if (folder === undefined) {
    throw new StepError('invalid_request', 'Choose a folder by its full path, starting with /.')
  }
  if (context.create === true) {
    await fs.mkdir(folder, { recursive: true }).catch(rethrowAsFolderError)
  }
  const real = await fs.realpath(folder).catch(rethrowAsFolderError)
  await checkWritableFolder(fs, real)
  const dataDir = await fs.realpath(context.dataDirReal).catch(() => context.dataDirReal)
  checkOutside(dataDir, real)
  if (subfolder === undefined) return checkPathBudget({ given: folder, real })

  const name = sanitizeFolderName(subfolder)
  if (name === undefined) {
    throw new StepError('invalid_request', "The subfolder name can't be used as a folder name.")
  }
  const child = path.join(real, name)
  checkPathBudget({ given: child, real: child })
  // Jobs and batches carry this path, so it must be a valid API folder too (a long given path may
  // reach a short real one through a symlink).
  const childGiven = path.join(folder, name)
  // FolderPathSchema counts UTF-16 units; macOS counts bytes, and publish resolves this path again.
  if (
    !FolderPathSchema.safeParse(childGiven).success ||
    Buffer.byteLength(childGiven) >= MAX_PATH_BYTES
  ) {
    throw pathTooLong()
  }
  // Not recursive: the subfolder is exactly one level, and its parent was just checked.
  await fs.mkdir(child).catch((error: unknown) => {
    if (errnoCode(error) !== 'EEXIST') rethrowAsFolderError(error)
  })
  // A symlink even to a folder beside it: the batch's files would land in another folder.
  const linked = await fs.lstat(child).then((stats) => stats.isSymbolicLink(), rethrowAsFolderError)
  const childReal = await fs.realpath(child).catch(rethrowAsFolderError)
  if (linked || path.dirname(childReal) !== real) {
    throw new StepError(
      'folder_unavailable',
      'The subfolder is a link to another place. Rename or remove it, or turn off playlist subfolders.',
    )
  }
  // `<parent of the data dir>` + the data dir's name.
  checkOutside(dataDir, childReal)
  await checkWritableFolder(fs, childReal)
  return checkPathBudget({ given: childGiven, real: childReal })
}

/**
 * A folder just chosen, in the native picker or as the new `settings.folder` (e.g. a recent one):
 * the checks a batch's folder gets at enqueue, then a read of its first entry. macOS asks for
 * access to a protected folder (Desktop, Documents, Downloads, iCloud Drive, a removable or network
 * volume) at the first read inside it, so its privacy prompt shows now rather than when a batch
 * publishes its first file, and the read waits for the user's answer. A refusal is EPERM
 * (PRIVACY_MESSAGE). Every refusal is `folder_unavailable`: the folder is the problem, not the
 * request. Never creates anything.
 */
export async function checkPickedFolder(
  picked: string,
  context: Pick<ResolveFolderContext, 'dataDirReal'>,
  ops: Partial<FolderOps> = {},
): Promise<void> {
  const fs: FolderOps = { ...DEFAULT_OPS, ...ops }
  try {
    const { real } = await resolveTargetFolder(picked, undefined, context, fs)
    await readFirstEntry(fs, real)
  } catch (error) {
    if (error instanceof StepError && error.code !== 'folder_unavailable') {
      throw new StepError('folder_unavailable', error.message)
    }
    throw error
  }
}

/**
 * Right before publishing: the folder must still resolve to the same real path and be a directory
 * (a renamed folder, an unplugged drive or a swapped-in symlink fail the job). Never creates it.
 */
export async function recheckFolder(
  target: TargetFolder,
  ops: Partial<Pick<FolderOps, 'realpath' | 'stat'>> = {},
): Promise<void> {
  const fs = { ...DEFAULT_OPS, ...ops }
  const real = await fs.realpath(target.given).catch((error: unknown) => {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') throw folderGone()
    return rethrowAsFolderError(error)
  })
  if (real !== target.real) throw folderGone()
  const stats = await fs.stat(real).catch(rethrowAsFolderError)
  if (!stats.isDirectory()) throw folderGone()
}

/** Whether `candidate` is `base` or inside it. Both must be real paths (compare like for like). */
export function insideFolder(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function checkOutside(dataDir: string, real: string): void {
  if (insideFolder(dataDir, real)) {
    throw new StepError(
      'folder_unavailable',
      "That folder is inside DJ Scraper's own data folder. Choose another one.",
    )
  }
}

async function checkWritableFolder(fs: FolderOps, real: string): Promise<void> {
  const stats = await fs.stat(real).catch(rethrowAsFolderError)
  if (!stats.isDirectory()) throw new StepError('folder_unavailable', "That path isn't a folder.")
  await fs.access(real, constants.W_OK).catch(rethrowAsFolderError)
}

/** One entry, not the whole listing: a DJ folder may hold thousands of files. */
async function readFirstEntry(fs: FolderOps, real: string): Promise<void> {
  try {
    const dir = await fs.opendir(real)
    try {
      await dir.read()
    } finally {
      await dir.close().catch(() => {})
    }
  } catch (error) {
    // A folder we may write to but not list (a drop box) still takes downloads: publishing never
    // lists it. macOS privacy settings refuse with EPERM, not EACCES.
    if (errnoCode(error) !== 'EACCES') rethrowAsFolderError(error)
  }
}

function checkPathBudget(target: TargetFolder): TargetFolder {
  const longest = path.join(target.real, 'x'.repeat(MAX_FILENAME_LENGTH))
  if (Buffer.byteLength(longest) >= MAX_PATH_BYTES) throw pathTooLong()
  return target
}

function pathTooLong(): StepError {
  return new StepError(
    'invalid_request',
    'That folder path is too long for the file names. Choose a folder closer to the top of the drive.',
  )
}

/**
 * A job's folder that went away before publishing. No next step in the message: Retry keeps this
 * folder, so the web says to put it back (jobErrorHint), not to choose another.
 */
function folderGone(): StepError {
  return new StepError(
    'folder_unavailable',
    'The download folder was moved, renamed or its drive was disconnected.',
  )
}

/** Maps an fs error to the user's words by its code (its message holds the path). */
export function folderError(error: unknown): StepError {
  const code = errnoCode(error)
  switch (code) {
    case 'ENOENT':
      return new StepError(
        'folder_unavailable',
        "That folder doesn't exist. Check the path, or that its drive is connected.",
      )
    case 'ENOTDIR':
      return new StepError('folder_unavailable', "That path isn't a folder.")
    case 'EPERM':
      return new StepError('folder_unavailable', PRIVACY_MESSAGE)
    case 'EACCES':
      return new StepError(
        'folder_unavailable',
        "DJ Scraper isn't allowed to write to that folder.",
      )
    case 'EROFS':
      return new StepError('folder_unavailable', 'That folder is on a read-only drive.')
    case 'ENOSPC':
    case 'EDQUOT':
      return new StepError('folder_unavailable', 'The drive of that folder is full.')
    case 'ELOOP':
      return new StepError('folder_unavailable', 'That folder path has a link that loops.')
    case 'ENAMETOOLONG':
      return new StepError('invalid_request', 'That folder path is too long.')
    default:
      return new StepError('folder_unavailable', `That folder can't be used (${code ?? 'error'}).`)
  }
}

function rethrowAsFolderError(error: unknown): never {
  throw folderError(error)
}
