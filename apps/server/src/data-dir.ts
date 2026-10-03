import type { Stats } from 'node:fs'
import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import * as z from 'zod'
import { run } from './engine/run.ts'
import type { PartRecord } from './jobs/types.ts'
import { defaultSleep, type Sleep } from './resolve/limiter.ts'
import type { Logger } from './resolve/ytdlp-call.ts'
import { errnoCode, failureName } from './util/errno.ts'

/**
 * The app data dir (Phase 2 design, D9): settings, the job temp dirs in `jobs/`, and `server.lock`,
 * which one server holds for its whole life. Holding it is what makes the startup sweep safe: any
 * process whose argv names `<dataDir>/jobs/<uuid>` belongs to a server that is gone.
 */

export const LOCK_FILE = 'server.lock'
export const JOBS_DIR = 'jobs'
/** How long a second server waits for the previous one to finish its shutdown (8 s) and let go. */
export const LOCK_WAIT_MS = 9000
const LOCK_POLL_MS = 250
/** <sys/fcntl.h> on macOS: open(2) takes an exclusive flock(2) with it. Node has no constant. */
const O_EXLOCK = 0x20
/** O_NOFOLLOW: a symlink planted as server.lock fails (ELOOP) instead of having its target rewritten. */
const LOCK_FLAGS =
  constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_EXLOCK

/** ps with no locale but UTF-8, so non-ASCII paths come through as they are (macos.md §4). */
const PS_BIN = '/bin/ps'
const PS_ARGV = ['-A', '-ww', '-o', 'pid=,pgid=,command=']
const PS_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_CTYPE: 'en_US.UTF-8' }
const PS_TIMEOUT_MS = 10_000
/** How long the sweep waits for killed groups to be gone, so nothing writes into jobs/ after it. */
const KILL_WAIT_MS = 2000
const KILL_POLL_MS = 50
/** A part record is a short JSON object; anything bigger is not ours. */
const MAX_RECORD_BYTES = 64 * 1024
/** A part record whose folder is missing (a drive not plugged in) waits this long for it. */
export const PART_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const JOB_ENTRY = new RegExp(`^${UUID}$`)
const PART_RECORD = new RegExp(`^(${UUID})\\.part\\.json$`)
/** A job dir in argv: the UUID, then the end of the argument or a path inside the dir. */
const JOB_DIR_IN_ARGV = new RegExp(`^${UUID}(?=[/\\s]|$)`)
/** What may precede an absolute path in an argument: `-P <dir>`, `file:<path>`, `--opt=<path>`. */
const PATH_START = /[\s=:"']/

/** Why the data dir can't be used. `message` has no path (logs never do); `dataDir` does. */
export class DataDirError extends Error {
  override name = 'DataDirError'
  readonly dataDir: string

  constructor(message: string, dataDir: string, options?: ErrorOptions) {
    super(message, options)
    this.dataDir = dataDir
  }
}

/**
 * Makes sure `dataDir` and its `jobs/` are real directories owned by us, creating them 0700 when
 * missing, and returns the real path of `dataDir`. Permissions of an existing folder change only
 * when it holds `server.lock` (so it is ours): DJS_DATA_DIR may name a folder of the user's.
 */
export async function prepareDataDir(
  dataDir: string,
  { uid = process.getuid?.() }: { uid?: number } = {},
): Promise<string> {
  const created = await ownDir(dataDir, dataDir, uid)
  const ours = created || (await isRegularFile(path.join(dataDir, LOCK_FILE)))
  try {
    if (ours) await chmod(dataDir, 0o700)
    const real = await realpath(dataDir)
    const jobs = path.join(real, JOBS_DIR)
    if ((await ownDir(jobs, dataDir, uid)) || ours) await chmod(jobs, 0o700)
    return real
  } catch (error) {
    if (error instanceof DataDirError) throw error
    throw new DataDirError(
      `The app data folder can't be prepared (${failureName(error)})`,
      dataDir,
      {
        cause: error,
      },
    )
  }
}

/** Checks `dir` is a real directory owned by `uid`, or creates it (0700). True when created. */
async function ownDir(dir: string, dataDir: string, uid: number | undefined): Promise<boolean> {
  let stats: Stats
  try {
    stats = await lstat(dir)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      throw new DataDirError(`The app data folder can't be read (${failureName(error)})`, dataDir, {
        cause: error,
      })
    }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
    } catch (cause) {
      throw new DataDirError(
        `The app data folder can't be created (${failureName(cause)})`,
        dataDir,
        {
          cause,
        },
      )
    }
    return true
  }
  const what = dir === dataDir ? 'The app data folder' : 'Its jobs folder'
  if (stats.isSymbolicLink()) throw new DataDirError(`${what} is a symbolic link`, dataDir)
  if (!stats.isDirectory()) throw new DataDirError(`${what} is not a folder`, dataDir)
  if (uid !== undefined && stats.uid !== uid) {
    throw new DataDirError(`${what} belongs to another user`, dataDir)
  }
  return false
}

/** What `server.lock` says about the server holding it. */
export type LockHolder = { pid: number; startedAt: string; port?: number }

const LockHolderSchema = z.object({
  pid: z.int().positive(),
  startedAt: z.string(),
  port: z.int().min(1).max(65_535).optional(),
})

/** Another server holds the data dir and didn't let go within the wait. */
export class DataDirLocked extends Error {
  override name = 'DataDirLocked'
  /** Undefined when its record couldn't be read. */
  readonly holder: LockHolder | undefined

  constructor(holder: LockHolder | undefined) {
    const where = holder?.port === undefined ? '' : `, http://127.0.0.1:${holder.port}/`
    super(
      holder === undefined
        ? 'Another DJ Scraper server is using the app data folder'
        : `Another DJ Scraper server (pid ${holder.pid}${where}) is using the app data folder`,
    )
    this.holder = holder
  }
}

export type DataDirLock = {
  /**
   * False when no lock could be taken (not macOS, or a filesystem without flock): another server
   * may share the data dir, so the caller must skip the leftover sweep.
   */
  readonly exclusive: boolean
  /** Adds the listening port to the holder record (for a second server's message). */
  setPort(port: number): void
  /** Closes the lock file, letting the next server in. Idempotent. */
  release(): void
}

export type LockOptions = {
  /** How long to wait for a holder to let go. Default `LOCK_WAIT_MS`. */
  waitMs?: number
  pollMs?: number
  sleep?: Sleep
  log?: Logger
  /** Injected for tests. */
  platform?: NodeJS.Platform
  open?: (file: string, flags: number, mode: number) => number
  pid?: number
  now?: () => number
}

/**
 * Takes the data dir's lock for the life of this process: `server.lock` opened with O_EXLOCK and
 * kept open as a plain fd (a FileHandle would close on GC and drop the lock). libuv opens with
 * O_CLOEXEC, so engine children don't inherit it. While another server holds it, polls for up to
 * `waitMs` (a restart overlaps the old server's shutdown), then throws `DataDirLocked`.
 */
export async function lockDataDir(
  dataDirReal: string,
  {
    waitMs = LOCK_WAIT_MS,
    pollMs = LOCK_POLL_MS,
    sleep = defaultSleep,
    log = console,
    platform = process.platform,
    open = openSync,
    pid = process.pid,
    now = Date.now,
  }: LockOptions = {},
): Promise<DataDirLock> {
  if (platform !== 'darwin') {
    log.warn('[server] The data folder lock needs macOS: running without it, and without the sweep')
    return UNLOCKED
  }
  const file = path.join(dataDirReal, LOCK_FILE)
  const polls = Math.ceil(waitMs / pollMs)
  for (let poll = 0; ; poll++) {
    let fd: number
    try {
      fd = open(file, LOCK_FLAGS, 0o600)
    } catch (error) {
      const code = failureName(error)
      if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        log.warn(`[server] The data folder can't be locked (${code}): running without the sweep`)
        return UNLOCKED
      }
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') {
        throw new DataDirError(`The app data folder can't be locked (${code})`, dataDirReal, {
          cause: error,
        })
      }
      const holder = readHolder(file)
      if (poll >= polls) throw new DataDirLocked(holder)
      if (poll === 0) {
        const who = holder === undefined ? '' : ` (pid ${holder.pid})`
        log.info(`[server] Waiting for the previous server${who} to stop…`)
      }
      await sleep(pollMs)
      continue
    }
    return held(fd, { pid, startedAt: new Date(now()).toISOString() }, log)
  }
}

const UNLOCKED: DataDirLock = { exclusive: false, setPort() {}, release() {} }

function held(fd: number, holder: LockHolder, log: Logger): DataDirLock {
  let open = true
  // Written in place (pwrite at 0, then truncate), on the fd that holds the lock.
  const write = (record: LockHolder): void => {
    try {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
      writeSync(fd, bytes, 0, bytes.length, 0)
      ftruncateSync(fd, bytes.length)
    } catch (error) {
      // Only a second server's message needs the record; the lock itself holds.
      log.warn(`[server] Can't write the data folder lock record (${failureName(error)})`)
    }
  }
  write(holder)
  return {
    exclusive: true,
    setPort(port) {
      if (open) write({ ...holder, port })
    },
    release() {
      if (!open) return
      open = false
      closeSync(fd)
    },
  }
}

function readHolder(file: string): LockHolder | undefined {
  try {
    const parsed = LockHolderSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export type PsRow = { pid: number; pgid: number; command: string }

/** Pure: `ps -o pid=,pgid=,command=` output → rows; lines that don't parse are skipped. */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) continue
    rows.push({ pid, pgid, command: match[3] ?? '' })
  }
  return rows
}

/**
 * Pure: the process groups (≠ ours, > 1) with a member whose argv names a job dir:
 * `marker` (`<dataDirReal>/jobs/`) followed by a UUID, as yt-dlp's `-P` and every ffmpeg path
 * of an attempt do. The marker must start an argument (or follow `file:`, `=`), so another data
 * dir that merely ends with ours doesn't match.
 */
export function leftoverGroups(rows: readonly PsRow[], marker: string, selfPgid: number): number[] {
  const groups = new Set<number>()
  for (const { pgid, command } of rows) {
    if (pgid <= 1 || pgid === selfPgid || groups.has(pgid)) continue
    if (namesJobDir(command, marker)) groups.add(pgid)
  }
  return [...groups]
}

function namesJobDir(command: string, marker: string): boolean {
  if (marker === '') return false
  for (let at = command.indexOf(marker); at !== -1; at = command.indexOf(marker, at + 1)) {
    if (at > 0 && !PATH_START.test(command.charAt(at - 1))) continue
    const rest = command.slice(at + marker.length, at + marker.length + 37)
    if (JOB_DIR_IN_ARGV.test(rest)) return true
  }
  return false
}

/** The filesystem calls of the sweep. None of them follows a symlink in the last component. */
export type SweepFs = {
  readdir: (dir: string) => Promise<string[]>
  lstat: (file: string) => Promise<Pick<Stats, 'isFile' | 'isDirectory' | 'size' | 'mtimeMs'>>
  readFile: (file: string) => Promise<string>
  unlink: (file: string) => Promise<void>
  /** Recursive, removing symlinks themselves (fs.rm never follows them). */
  rmTree: (dir: string) => Promise<void>
}

const realFs: SweepFs = {
  readdir: (dir) => readdir(dir),
  lstat: (file) => lstat(file),
  readFile: (file) => readFile(file, 'utf8'),
  unlink: (file) => unlink(file),
  rmTree: (dir) => rm(dir, { recursive: true, force: true }),
}

export type SweepDeps = {
  run?: typeof run
  /** `process.kill`, called with a negative pid (a process group). */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  fs?: Partial<SweepFs>
  sleep?: Sleep
  log?: Logger
  /** Our pid, to find our own process group in the ps output. */
  pid?: number
  /** Wall-clock ms, for the age of part records. Default `Date.now`. */
  now?: () => number
}

/** What the sweep did: process groups killed, `jobs/` entries removed, part files unlinked. */
export type SweepResult = { killed: number; removed: number; parts: number }

/**
 * At startup, with the lock held and before listening: SIGKILLs the process groups a previous
 * server left running (one ps), waits up to 2 s for them to be gone, unlinks the cross-volume
 * part files its publish steps recorded (D10), and removes its job dirs and part records. Only
 * `jobs/` entries named `<uuid>` or `<uuid>.part.json` are touched, and no symlink is followed.
 * A part record whose folder is missing (a drive not plugged in) stays for a later start, for at
 * most 30 days.
 */
export async function sweepLeftovers(
  dataDirReal: string,
  {
    run: runFn = run,
    kill = (pid, signal) => {
      process.kill(pid, signal)
    },
    fs: fsOverrides = {},
    sleep = defaultSleep,
    log = console,
    pid = process.pid,
    now = Date.now,
  }: SweepDeps = {},
): Promise<SweepResult> {
  const fs: SweepFs = { ...realFs, ...fsOverrides }
  const killed = await killLeftovers(dataDirReal, runFn, kill, sleep, log, pid)
  const jobsDir = path.join(dataDirReal, JOBS_DIR)
  let names: string[]
  try {
    names = await fs.readdir(jobsDir)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { killed, removed: 0, parts: 0 }
    log.warn(`[server] Can't read the jobs folder (${failureName(error)}): not sweeping it`)
    return { killed, removed: 0, parts: 0 }
  }
  let parts = 0
  const kept = new Set<string>()
  for (const name of names) {
    const attemptId = PART_RECORD.exec(name)?.[1]
    if (attemptId === undefined) continue
    const outcome = await unlinkRecordedPart(fs, jobsDir, name, attemptId, now(), log)
    parts += outcome.parts
    if (outcome.keep) kept.add(name)
  }
  if (kept.size > 0) {
    log.info(
      `[server] Kept ${kept.size} part record${kept.size === 1 ? '' : 's'} for a folder that isn't there (a drive not connected?)`,
    )
  }
  let removed = 0
  for (const name of names) {
    if (kept.has(name) || (!JOB_ENTRY.test(name) && !PART_RECORD.test(name))) continue
    const entry = path.join(jobsDir, name)
    try {
      const stats = await fs.lstat(entry)
      if (stats.isDirectory()) await fs.rmTree(entry)
      else await fs.unlink(entry)
      removed++
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        log.warn(`[server] Can't remove a leftover job entry (${failureName(error)})`)
      }
    }
  }
  return { killed, removed, parts }
}

async function killLeftovers(
  dataDirReal: string,
  runFn: typeof run,
  kill: (pid: number, signal: NodeJS.Signals) => void,
  sleep: Sleep,
  log: Logger,
  pid: number,
): Promise<number> {
  let stdout: string
  try {
    const result = await runFn(PS_BIN, PS_ARGV, { env: PS_ENV, timeoutMs: PS_TIMEOUT_MS })
    if (result.exitCode !== 0) throw Object.assign(new Error('ps failed'), { code: 'EXIT' })
    stdout = result.stdout
  } catch (error) {
    log.warn(`[server] Can't list processes (${failureName(error)}): leftover jobs keep running`)
    return 0
  }
  const rows = parsePs(stdout)
  const self = rows.find((row) => row.pid === pid)
  if (self === undefined) {
    log.warn("[server] Can't find this server in the process list: leftover jobs keep running")
    return 0
  }
  const groups = leftoverGroups(rows, `${dataDirReal}/${JOBS_DIR}/`, self.pgid)
  for (const group of groups) signalGroup(kill, group, 'SIGKILL')
  // Until they're gone, a dying ffmpeg could still write into a job dir the sweep removes. The
  // wait signals again, so a member forked while the first signal went out goes too.
  let alive = groups
  for (let waited = 0; waited < KILL_WAIT_MS; waited += KILL_POLL_MS) {
    alive = alive.filter((group) => signalGroup(kill, group, 'SIGKILL'))
    if (alive.length === 0) break
    await sleep(KILL_POLL_MS)
  }
  return groups.length
}

/** Signals a process group; false when it is gone (ESRCH, or EPERM: only a zombie left). */
function signalGroup(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pgid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    kill(-pgid, signal)
    return true
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ESRCH' || code === 'EPERM') return false
    throw error
  }
}

/** What fs/move.ts writes (one type for both sides). */
const PartRecordSchema = z.object({
  partPath: z.string(),
  /** The 0-byte file a publish on FAT/exFAT reserved the final name with (D10). */
  placeholderPath: z.string().optional(),
}) satisfies z.ZodType<PartRecord>

/**
 * Unlinks the part file a part record names, only when it is exactly `.djs-<attemptId>.part`, an
 * absolute path and a regular file; and its 0-byte placeholder in the same folder. Returns how
 * many part files were unlinked (0 or 1), and whether to keep the record: its folder isn't there
 * (a drive not plugged in) and the record is under 30 days old.
 */
async function unlinkRecordedPart(
  fs: SweepFs,
  jobsDir: string,
  name: string,
  attemptId: string,
  now: number,
  log: Logger,
): Promise<{ parts: number; keep: boolean }> {
  const done = { parts: 0, keep: false }
  try {
    const record = path.join(jobsDir, name)
    const stats = await fs.lstat(record)
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) return done
    const parsed = PartRecordSchema.safeParse(JSON.parse(await fs.readFile(record)))
    if (!parsed.success) return done
    const { partPath, placeholderPath: placeholder } = parsed.data
    if (!path.isAbsolute(partPath) || path.basename(partPath) !== `.djs-${attemptId}.part`) {
      return done
    }
    const folder = await fs.lstat(path.dirname(partPath)).catch(() => undefined)
    if (!folder?.isDirectory()) {
      return { parts: 0, keep: now - stats.mtimeMs < PART_RECORD_MAX_AGE_MS }
    }
    let unlinked = 0
    if ((await fs.lstat(partPath).catch(() => undefined))?.isFile()) {
      await fs.unlink(partPath)
      unlinked = 1
    }
    if (
      placeholder !== undefined &&
      path.isAbsolute(placeholder) &&
      path.dirname(placeholder) === path.dirname(partPath) &&
      placeholder !== partPath
    ) {
      // Only while still empty: once the part was renamed over it, it is the user's file.
      const reserved = await fs.lstat(placeholder).catch(() => undefined)
      if (reserved?.isFile() && reserved.size === 0) await fs.unlink(placeholder)
    }
    return { parts: unlinked, keep: false }
  } catch (error) {
    // A record that isn't JSON is no reason to stop the sweep.
    if (!(error instanceof SyntaxError) && errnoCode(error) !== 'ENOENT') {
      log.warn(`[server] Can't clean up a leftover part file (${failureName(error)})`)
    }
    return done
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile()
  } catch {
    return false
  }
}
