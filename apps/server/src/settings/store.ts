import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  FolderPathSchema,
  MAX_RECENT_FOLDERS,
  type Settings,
  SettingsSchema,
  type SettingsUpdate,
  SettingsUpdateSchema,
} from '@dj-scraper/shared'
import type { Logger } from '../resolve/ytdlp-call.ts'
import { failureName } from '../util/errno.ts'

/**
 * The app's settings: `settings.json` in the app data dir. The copy in memory is the truth; the file
 * follows it. Reads repair field by field (a bad value costs only that field, the original is kept
 * as settings.json.bad); writes are atomic (a unique temp file, fsync, rename) and coalesced.
 * Create the store after the data dir is locked: it removes temp files a crashed write left behind.
 */
export type SettingsStore = {
  /** The current settings, frozen. A change replaces the object. */
  get(): Settings
  /**
   * Applies the fields `patch` sets, at once (get() sees them). A changed folder goes to the front
   * of `recentFolders`. Resolves with the settings once a write that includes the change has ended;
   * a failed write is logged and doesn't reject (the next change writes everything again).
   */
  update(patch: SettingsUpdate): Promise<Settings>
  /** A folder a download used: to the front of `recentFolders`. Not a folder path → no change. */
  rememberFolder(folder: string): Promise<Settings>
  /** Called after every change, with the new settings. */
  onChange(listener: (settings: Settings) => void): () => void
  /** Resolves once no write is pending. Never rejects. */
  flush(): Promise<void>
}

/** The file operations the store uses; node:fs/promises by default. */
export type SettingsFs = {
  readFile(file: string): Promise<Uint8Array>
  writeFile(file: string, data: Uint8Array, options: { mode: number; flag: number }): Promise<void>
  readdir(dir: string): Promise<string[]>
  mkdir(dir: string, options: { recursive: true; mode: number }): Promise<unknown>
  open(file: string, flags: 'wx', mode: number): Promise<SettingsFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
}

export type SettingsFileHandle = {
  writeFile(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export type SettingsStoreOptions = {
  /** The app data dir; created (0700) on the first write if missing. */
  dataDir: string
  /** The `folder` until the user picks one: `defaultDownloadFolder(homeDir)`. */
  defaultFolder: string
  fs?: Partial<SettingsFs>
  log?: Logger
}

export const SETTINGS_FILE = 'settings.json'
/** A settings.json that isn't a JSON object or has invalid fields is copied here before repair. */
export const BAD_SETTINGS_FILE = 'settings.json.bad'
/** settings.json.bad is replaced, but never through a symlink planted in its place (ELOOP). */
const BAD_FILE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

const NODE_FS: SettingsFs = { readFile, writeFile, readdir, mkdir, open, rename, unlink }

const TEMP_FILE = /^settings\.json\.[0-9a-f-]{36}\.tmp$/
/** A settings.json with hundreds of bad recent folders still logs one short line. */
const MAX_PATHS_LOGGED = 10

export async function createSettingsStore(options: SettingsStoreOptions): Promise<SettingsStore> {
  const { dataDir, log = console } = options
  const fs: SettingsFs = { ...NODE_FS, ...options.fs }
  const file = path.join(dataDir, SETTINGS_FILE)
  if (!FolderPathSchema.safeParse(options.defaultFolder).success) {
    throw new Error('The default download folder is not an absolute folder path')
  }
  const defaults: Settings = {
    ...DEFAULT_SETTINGS,
    recentFolders: [],
    folder: options.defaultFolder,
  }

  await removeTempFiles(fs, dataDir)
  let current = frozen(await load())
  const listeners = new Set<(settings: Settings) => void>()
  let pending = false
  let writing: Promise<void> | undefined

  async function load(): Promise<Settings> {
    let bytes: Uint8Array
    try {
      bytes = await fs.readFile(file)
    } catch (error) {
      const code = failureName(error)
      if (code !== 'ENOENT') {
        log.warn(`[settings] cannot read ${SETTINGS_FILE} (${code}): using the defaults`)
      }
      return defaults
    }
    let raw: unknown
    try {
      // TextDecoder drops a BOM and replaces invalid UTF-8 instead of throwing.
      raw = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      raw = undefined
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      await keepBadCopy(bytes)
      log.warn(`[settings] ${SETTINGS_FILE} is not a JSON object: using the defaults (${keptAs})`)
      return defaults
    }
    const { settings, dropped } = repairSettings(raw, defaults)
    if (dropped.length > 0) {
      await keepBadCopy(bytes)
      log.warn(
        `[settings] ${SETTINGS_FILE}: invalid ${listPaths(dropped)}: using their defaults (${keptAs})`,
      )
    }
    return settings
  }

  async function keepBadCopy(bytes: Uint8Array): Promise<void> {
    try {
      await fs.writeFile(path.join(dataDir, BAD_SETTINGS_FILE), bytes, {
        mode: 0o600,
        flag: BAD_FILE_FLAGS,
      })
    } catch (error) {
      log.warn(`[settings] cannot write ${BAD_SETTINGS_FILE} (${failureName(error)})`)
    }
  }

  /** One atomic write of `text`; logs a failure and never throws. */
  async function write(text: string): Promise<void> {
    const temp = path.join(dataDir, `${SETTINGS_FILE}.${randomUUID()}.tmp`)
    let handle: SettingsFileHandle | undefined
    let created = false
    try {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
      handle = await fs.open(temp, 'wx', 0o600)
      created = true
      await handle.writeFile(text)
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temp, file)
      created = false
    } catch (error) {
      log.warn(`[settings] cannot save ${SETTINGS_FILE} (${failureName(error)})`)
      await handle?.close().catch(() => {})
      if (created) await fs.unlink(temp).catch(() => {})
    }
  }

  /**
   * Starts a write, or joins the one in progress: changes made while a write runs share the next
   * write, which takes the settings as they are when it starts (the latest value wins).
   */
  function save(): Promise<void> {
    pending = true
    writing ??= (async () => {
      try {
        // A microtask first, so the changes of this tick share one write.
        await Promise.resolve()
        while (pending) {
          pending = false
          await write(`${JSON.stringify(current, null, 2)}\n`)
        }
      } finally {
        writing = undefined
      }
    })()
    return writing
  }

  async function commit(next: Settings): Promise<Settings> {
    current = frozen(next)
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        log.error('[settings] a change listener failed:', error)
      }
    }
    await save()
    return current
  }

  return {
    get: () => current,
    async update(patch) {
      const next: Settings = { ...current }
      for (const [key, value] of Object.entries(SettingsUpdateSchema.parse(patch))) {
        if (value !== undefined) Object.assign(next, { [key]: value })
      }
      if (next.folder !== current.folder) {
        next.recentFolders = withRecent(current.recentFolders, next.folder)
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      return commit(next)
    },
    async rememberFolder(folder) {
      if (!FolderPathSchema.safeParse(folder).success || current.recentFolders[0] === folder) {
        return current
      }
      return commit({ ...current, recentFolders: withRecent(current.recentFolders, folder) })
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    flush: async () => {
      await writing
    },
  }
}

const keptAs = `the original is in ${BAD_SETTINGS_FILE}`

/**
 * Pure: settings.json's parsed object → Settings. Each field is checked alone: a missing one gets
 * its default quietly, an invalid one gets its default and its Zod issue paths go into `dropped`.
 * Recent folders keep their valid entries (deduped, at most MAX_RECENT_FOLDERS). Unknown keys,
 * such as a setting another version wrote, are ignored.
 */
export function repairSettings(
  raw: object,
  defaults: Settings,
): { settings: Settings; dropped: string[] } {
  const fields: Record<string, unknown> = { ...defaults }
  const dropped: string[] = []
  for (const [key, schema] of Object.entries(SettingsSchema.shape)) {
    const value: unknown = Object.hasOwn(raw, key) ? Reflect.get(raw, key) : undefined
    if (value === undefined) continue
    const parsed = schema.safeParse(value)
    if (parsed.success) {
      fields[key] = parsed.data
      continue
    }
    dropped.push(...parsed.error.issues.map((issue) => formatPath([key, ...issue.path])))
    if (key === 'recentFolders' && Array.isArray(value)) {
      const valid = value.filter((folder) => FolderPathSchema.safeParse(folder).success)
      fields[key] = [...new Set(valid)].slice(0, MAX_RECENT_FOLDERS)
    }
  }
  return { settings: SettingsSchema.parse(fields), dropped: [...new Set(dropped)] }
}

/** `folder` first, then the others in order, at most MAX_RECENT_FOLDERS. */
function withRecent(recent: readonly string[], folder: string): string[] {
  return [folder, ...recent.filter((other) => other !== folder)].slice(0, MAX_RECENT_FOLDERS)
}

function frozen(settings: Settings): Settings {
  Object.freeze(settings.recentFolders)
  return Object.freeze(settings)
}

/** Temp files of a write that never got renamed (a crash). Only one server holds the data dir. */
async function removeTempFiles(fs: SettingsFs, dataDir: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dataDir)
  } catch {
    return
  }
  for (const name of names) {
    if (TEMP_FILE.test(name)) await fs.unlink(path.join(dataDir, name)).catch(() => {})
  }
}

/** `recentFolders[2]`: field names and indexes only, never the values. */
function formatPath(segments: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? String(segment) : `.${String(segment)}`
  }
  return out
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_PATHS_LOGGED).join(', ')
  const more = paths.length - MAX_PATHS_LOGGED
  return more > 0 ? `${shown} (and ${more} more)` : shown
}
