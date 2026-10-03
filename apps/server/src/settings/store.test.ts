import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  MAX_RECENT_FOLDERS,
  type Settings,
  SettingsSchema,
} from '@dj-scraper/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAD_SETTINGS_FILE,
  createSettingsStore,
  repairSettings,
  SETTINGS_FILE,
  type SettingsFs,
} from './store.ts'

const DEFAULT_FOLDER = '/Users/dj/Music/DJ Scraper'
const defaults: Settings = { ...DEFAULT_SETTINGS, recentFolders: [], folder: DEFAULT_FOLDER }

/** Every field away from its default. */
const custom: Settings = {
  folder: '/Volumes/USB/Sets',
  recentFolders: ['/Volumes/USB/Sets', DEFAULT_FOLDER],
  format: 'aiff',
  filenameTemplate: '{artist} - {title} ({year})',
  embedArtwork: false,
  sourceUrlComment: false,
  playlistSubfolder: true,
  concurrency: 5,
  autoDownloadSingles: false,
}

const folders = (count: number, prefix = '/Users/dj/Music/Set'): string[] =>
  Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}`)

const errno = (code: string, message = `${code}: failed, '/Users/dj/secret path'`) =>
  Object.assign(new Error(message), { code })

let root = ''
let dir = ''
let count = 0
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dj-scraper-settings-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
beforeEach(async () => {
  // Each test gets a data dir that doesn't exist yet, as on a first run.
  dir = path.join(root, `data-${++count}`)
})

const settingsFile = () => path.join(dir, SETTINGS_FILE)
const badFile = () => path.join(dir, BAD_SETTINGS_FILE)
const modeOf = async (file: string) => (await stat(file)).mode & 0o777
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )
const savedSettings = async (): Promise<unknown> =>
  JSON.parse(await readFile(settingsFile(), 'utf8'))

/** Writes settings.json (a string as is, anything else as JSON) into a fresh data dir. */
async function seed(content: unknown): Promise<string> {
  await mkdir(dir, { recursive: true })
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  await writeFile(settingsFile(), text)
  return text
}

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const text = () =>
    [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n')
  return { log, text }
}

async function openStore(fs?: Partial<SettingsFs>) {
  const { log, text } = makeLog()
  const store = await createSettingsStore({ dataDir: dir, defaultFolder: DEFAULT_FOLDER, fs, log })
  return { store, log, logged: text }
}

/** A rename that waits for `release()` the first time, to hold a write in progress. */
function heldRename() {
  const renamed: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fs: Partial<SettingsFs> = {
    async rename(from, to) {
      renamed.push(await readFile(from, 'utf8'))
      if (renamed.length === 1) await gate
      await rename(from, to)
    },
  }
  return { fs, renamed, release }
}

describe('createSettingsStore: reading settings.json', () => {
  it('starts from the defaults and the default folder when there is no file, writing nothing', async () => {
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual(defaults)
    expect(SettingsSchema.parse(store.get())).toStrictEqual(defaults)
    expect(await exists(dir)).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reads a valid file unchanged', async () => {
    await seed(custom)
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual(custom)
    expect(await exists(badFile())).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reads a file that starts with a BOM', async () => {
    await seed(`﻿${JSON.stringify(custom)}`)
    expect((await openStore()).store.get()).toStrictEqual(custom)
  })

  it('fills missing fields with their defaults, quietly', async () => {
    await seed({ format: 'wav', concurrency: 1 })
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual({ ...defaults, format: 'wav', concurrency: 1 })
    expect(await exists(badFile())).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('ignores unknown keys, such as a setting another version wrote', async () => {
    await seed({ ...custom, theme: 'light' })
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual(custom)
    expect(await exists(badFile())).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('defaults only the invalid fields, keeps the original as settings.json.bad and logs paths, not values', async () => {
    const original = await seed({
      ...custom,
      folder: '/Volumes/Secret Gig/',
      format: 'secret-opus',
      concurrency: 99,
    })
    const { store, log, logged } = await openStore()
    expect(store.get()).toStrictEqual({
      ...custom,
      folder: DEFAULT_FOLDER,
      format: 'mp3',
      concurrency: DEFAULT_SETTINGS.concurrency,
    })
    expect(await readFile(badFile(), 'utf8')).toBe(original)
    expect(await modeOf(badFile())).toBe(0o600)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[settings] settings.json: invalid folder, format, concurrency: using their defaults (the original is in settings.json.bad)',
    )
    expect(logged()).not.toMatch(/Secret|secret-opus|99/)
  })

  it('keeps the valid recent folders, deduped, at most MAX_RECENT_FOLDERS', async () => {
    const [a, b, c, d, e, f] = folders(6)
    await seed({ ...custom, recentFolders: [a, '/Volumes/USB/', a, 'Music', b, c, d, e, f] })
    const { store, log } = await openStore()
    expect(store.get().recentFolders).toStrictEqual([a, b, c, d, e])
    expect(await exists(badFile())).toBe(true)
    expect(log.warn).toHaveBeenCalledOnce()
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/invalid recentFolders\[1\], recentFolders\[3\]/)
  })

  it('cuts a list of valid recent folders that is too long', async () => {
    const recentFolders = folders(MAX_RECENT_FOLDERS + 2)
    await seed({ ...custom, recentFolders })
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual({
      ...custom,
      recentFolders: recentFolders.slice(0, MAX_RECENT_FOLDERS),
    })
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('invalid recentFolders: '),
    )
    expect(await exists(badFile())).toBe(true)
  })

  it('empties recent folders that are not a list', async () => {
    await seed({ ...custom, recentFolders: '/Volumes/USB/Sets' })
    const { store } = await openStore()
    expect(store.get()).toStrictEqual({ ...custom, recentFolders: [] })
  })

  it.each([
    ['not JSON', 'format = "mp3"'],
    ['cut-off JSON', '{"format": '],
    ['empty', ''],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"mp3"'],
  ])(
    'uses the defaults for a file that is %s and keeps it as settings.json.bad',
    async (_label, text) => {
      await seed(text)
      const { store, log } = await openStore()
      expect(store.get()).toStrictEqual(defaults)
      expect(await readFile(badFile(), 'utf8')).toBe(text)
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        '[settings] settings.json is not a JSON object: using the defaults (the original is in settings.json.bad)',
      )
    },
  )

  it('uses the defaults when the file cannot be read, logging only the error code', async () => {
    await mkdir(settingsFile(), { recursive: true })
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual(defaults)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[settings] cannot read settings.json (EISDIR): using the defaults',
    )
    expect(await exists(badFile())).toBe(false)
  })

  it('still repairs the settings when the .bad copy cannot be written', async () => {
    await seed({ ...custom, format: 'opus' })
    const { store, log, logged } = await openStore({
      writeFile: async () => {
        throw errno('EACCES')
      },
    })
    expect(store.get()).toStrictEqual({ ...custom, format: 'mp3' })
    expect(log.warn).toHaveBeenCalledWith('[settings] cannot write settings.json.bad (EACCES)')
    expect(logged()).not.toContain('secret path')
  })

  it('never writes settings.json.bad through a symlink planted in its place', async () => {
    await seed({ ...custom, format: 'opus' })
    const target = path.join(root, `victim-${count}.txt`)
    await writeFile(target, 'my notes\n')
    await symlink(target, badFile())
    const { store, log } = await openStore()
    expect(store.get()).toStrictEqual({ ...custom, format: 'mp3' })
    expect(await readFile(target, 'utf8')).toBe('my notes\n')
    expect((await lstat(badFile())).isSymbolicLink()).toBe(true)
    expect(log.warn).toHaveBeenCalledWith('[settings] cannot write settings.json.bad (ELOOP)')
  })

  it('replaces an older settings.json.bad file', async () => {
    await seed({ ...custom, format: 'opus' })
    await writeFile(badFile(), 'an older, longer bad file\n')
    await openStore()
    expect(await readFile(badFile(), 'utf8')).toBe(JSON.stringify({ ...custom, format: 'opus' }))
  })

  it('removes temp files a crashed write left behind, and nothing else', async () => {
    await mkdir(dir)
    const stale = `${SETTINGS_FILE}.0b6f3c2e-8a8d-4c43-9a1e-2f0f6d4b7c11.tmp`
    const others = [`${SETTINGS_FILE}.notes.tmp`, 'other.tmp', SETTINGS_FILE]
    for (const name of [stale, ...others]) await writeFile(path.join(dir, name), '{}')
    await openStore()
    expect((await readdir(dir)).sort()).toStrictEqual([...others].sort())
  })

  it('refuses a default folder that is not an absolute folder path', async () => {
    await expect(
      createSettingsStore({ dataDir: dir, defaultFolder: 'Music/DJ Scraper' }),
    ).rejects.toThrow('The default download folder is not an absolute folder path')
  })
})

describe('repairSettings', () => {
  it('reports every invalid field by its path and keeps the rest', () => {
    const { settings, dropped } = repairSettings(
      { ...custom, embedArtwork: 'yes', recentFolders: [DEFAULT_FOLDER, 42], extra: true },
      defaults,
    )
    expect(settings).toStrictEqual({
      ...custom,
      embedArtwork: true,
      recentFolders: [DEFAULT_FOLDER],
    })
    expect(dropped).toStrictEqual(['recentFolders[1]', 'embedArtwork'])
  })

  it('treats a field set to null as invalid, and one set to undefined as missing', () => {
    expect(repairSettings({ format: null, concurrency: undefined }, defaults)).toStrictEqual({
      settings: defaults,
      dropped: ['format'],
    })
  })
})

describe('SettingsStore.update', () => {
  it('applies the given fields at once and resolves once they are saved', async () => {
    const { store } = await openStore()
    const saved = store.update({ format: 'wav', concurrency: 1 })
    const expected = { ...defaults, format: 'wav', concurrency: 1 }
    expect(store.get()).toStrictEqual(expected)
    expect(await saved).toStrictEqual(expected)
    expect(await savedSettings()).toStrictEqual(expected)
  })

  it('creates a missing data dir 0700 and writes settings.json 0600, leaving no temp file', async () => {
    dir = path.join(dir, 'Application Support', 'DJ Scraper')
    const { store } = await openStore()
    await store.update({ embedArtwork: false })
    expect(await modeOf(dir)).toBe(0o700)
    expect(await modeOf(path.dirname(dir))).toBe(0o700)
    expect(await modeOf(settingsFile())).toBe(0o600)
    expect(await readdir(dir)).toStrictEqual([SETTINGS_FILE])
  })

  it('replaces an existing settings.json, mode 0600 whatever the old mode', async () => {
    await seed(custom)
    const { store } = await openStore()
    expect(await modeOf(settingsFile())).toBe(0o644)
    await store.update({ concurrency: 2 })
    expect(await savedSettings()).toStrictEqual({ ...custom, concurrency: 2 })
    expect(await modeOf(settingsFile())).toBe(0o600)
  })

  it('puts a new folder at the front of the recent folders, deduped, at most MAX_RECENT_FOLDERS', async () => {
    const { store } = await openStore()
    const [a, b, c, d, e, f] = folders(6)
    for (const folder of [a, b, c]) await store.update({ folder })
    expect(store.get()).toMatchObject({ folder: c, recentFolders: [c, b, a] })
    await store.update({ folder: a })
    expect(store.get()).toMatchObject({ folder: a, recentFolders: [a, c, b] })
    for (const folder of [d, e, f]) await store.update({ folder })
    expect(store.get().recentFolders).toStrictEqual([f, e, d, a, c])
    expect(await savedSettings()).toStrictEqual(store.get())
  })

  it('leaves the recent folders alone when the folder stays the same', async () => {
    await seed(custom)
    const { store } = await openStore()
    await store.update({ folder: custom.folder, format: 'flac' })
    expect(store.get()).toStrictEqual({ ...custom, format: 'flac' })
  })

  it('ignores recentFolders and unknown keys in a patch', async () => {
    const { store } = await openStore()
    const patch = { recentFolders: ['/Users/dj/Desktop'], theme: 'light', concurrency: 2 }
    await store.update(patch)
    expect(store.get()).toStrictEqual({ ...defaults, concurrency: 2 })
  })

  it('skips the write and the listeners when nothing changes', async () => {
    await seed(custom)
    const open = vi.fn<SettingsFs['open']>()
    const { store } = await openStore({ open })
    const listener = vi.fn()
    store.onChange(listener)
    expect(await store.update({ format: custom.format, folder: custom.folder })).toStrictEqual(
      custom,
    )
    expect(await store.update({})).toStrictEqual(custom)
    expect(open).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('hands out frozen settings and replaces them on a change', async () => {
    const { store } = await openStore()
    const before = store.get()
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(before.recentFolders)).toBe(true)
    await store.update({ folder: '/Volumes/USB' })
    expect(store.get()).not.toBe(before)
    expect(before).toStrictEqual(defaults)
    expect(Object.isFrozen(store.get().recentFolders)).toBe(true)
  })

  it('writes changes made in the same tick once', async () => {
    const { fs, renamed, release } = heldRename()
    release()
    const { store } = await openStore(fs)
    await Promise.all([store.update({ format: 'wav' }), store.update({ concurrency: 1 })])
    expect(renamed).toHaveLength(1)
    expect(await savedSettings()).toStrictEqual({ ...defaults, format: 'wav', concurrency: 1 })
  })

  it('coalesces changes made during a write into one more write with the latest values', async () => {
    const { fs, renamed, release } = heldRename()
    const { store } = await openStore(fs)
    const first = store.update({ format: 'wav' })
    await vi.waitFor(() => expect(renamed).toHaveLength(1))
    const later = [
      store.update({ concurrency: 1 }),
      store.update({ concurrency: 2 }),
      store.update({ format: 'flac' }),
    ]
    release()
    const latest = { ...defaults, format: 'flac', concurrency: 2 }
    expect(await Promise.all([first, ...later])).toStrictEqual([latest, latest, latest, latest])
    expect(renamed.map((text) => JSON.parse(text))).toStrictEqual([
      { ...defaults, format: 'wav' },
      latest,
    ])
    expect(await savedSettings()).toStrictEqual(latest)
  })

  it('logs a failed write by its code, removes its temp file and saves everything on the next change', async () => {
    let failures = 1
    const { store, log, logged } = await openStore({
      async rename(from, to) {
        if (failures-- > 0) throw errno('ENOSPC')
        await rename(from, to)
      },
    })
    const changed = { ...defaults, format: 'wav' }
    expect(await store.update({ format: 'wav' })).toStrictEqual(changed)
    expect(store.get()).toStrictEqual(changed)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[settings] cannot save settings.json (ENOSPC)',
    )
    expect(logged()).not.toContain('secret path')
    expect(await readdir(dir)).toStrictEqual([])

    await store.update({ concurrency: 1 })
    expect(await savedSettings()).toStrictEqual({ ...changed, concurrency: 1 })
  })

  it('keeps the old file when a write fails before the rename', async () => {
    const original = await seed(custom)
    const { store, log } = await openStore({
      open: async () => {
        throw errno('EACCES')
      },
    })
    await store.update({ concurrency: 1 })
    expect(await readFile(settingsFile(), 'utf8')).toBe(original)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      '[settings] cannot save settings.json (EACCES)',
    )
  })

  it('closes and removes the temp file when writing into it fails', async () => {
    const close = vi.fn(async () => {})
    const { store, log } = await openStore({
      open: async (file, flags, mode) => {
        await writeFile(file, '', { flag: flags, mode })
        return {
          writeFile: async () => {
            throw errno('EIO')
          },
          sync: async () => {},
          close,
        }
      },
    })
    await store.update({ concurrency: 1 })
    expect(close).toHaveBeenCalledOnce()
    expect(await readdir(dir)).toStrictEqual([])
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('[settings] cannot save settings.json (EIO)')
  })
})

describe('SettingsStore.rememberFolder', () => {
  it('puts the folder at the front of the recent folders, without changing the folder setting', async () => {
    await seed(custom)
    const { store } = await openStore()
    const [a, b, c, d] = ['/Users/dj/Music/A', '/Users/dj/Music/B', '/Volumes/USB', '/Volumes/SD']
    for (const folder of [a, b, c, d]) await store.rememberFolder(folder)
    expect(store.get()).toStrictEqual({ ...custom, recentFolders: [d, c, b, a, custom.folder] })
    expect(await store.rememberFolder(b)).toStrictEqual({
      ...custom,
      recentFolders: [b, d, c, a, custom.folder],
    })
    expect(await savedSettings()).toStrictEqual(store.get())
  })

  it.each([
    ['a path with a trailing slash', '/Volumes/USB/'],
    ['a relative path', 'Music'],
    ['a path with a control character', '/Volumes/USB\nSets'],
  ])('ignores %s', async (_label, folder) => {
    const open = vi.fn<SettingsFs['open']>()
    const { store } = await openStore({ open })
    expect(await store.rememberFolder(folder)).toStrictEqual(defaults)
    expect(open).not.toHaveBeenCalled()
  })

  it('writes nothing when the folder is already the most recent', async () => {
    await seed(custom)
    const open = vi.fn<SettingsFs['open']>()
    const { store } = await openStore({ open })
    expect(await store.rememberFolder(custom.folder)).toStrictEqual(custom)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('SettingsStore.onChange', () => {
  it('calls listeners with the new settings on every change, until they unsubscribe', async () => {
    const { store } = await openStore()
    const listener = vi.fn()
    const unsubscribe = store.onChange(listener)
    await store.update({ concurrency: 2 })
    await store.rememberFolder('/Volumes/USB')
    unsubscribe()
    await store.update({ concurrency: 4 })
    expect(listener.mock.calls).toStrictEqual([
      [{ ...defaults, concurrency: 2 }],
      [{ ...defaults, concurrency: 2, recentFolders: ['/Volumes/USB'] }],
    ])
  })

  it('logs a listener that throws and carries on', async () => {
    const { store, log } = await openStore()
    const after = vi.fn()
    store.onChange(() => {
      throw new Error('listener bug')
    })
    store.onChange(after)
    expect(await store.update({ concurrency: 2 })).toMatchObject({ concurrency: 2 })
    expect(after).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith(
      '[settings] a change listener failed:',
      expect.objectContaining({ message: 'listener bug' }),
    )
  })
})

describe('SettingsStore.flush', () => {
  it('waits for the write in progress', async () => {
    const { fs, renamed, release } = heldRename()
    const { store } = await openStore(fs)
    void store.update({ concurrency: 2 })
    await vi.waitFor(() => expect(renamed).toHaveLength(1))
    let flushed = false
    const flushing = store.flush().then(() => {
      flushed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(flushed).toBe(false)
    release()
    await flushing
    expect(await savedSettings()).toStrictEqual({ ...defaults, concurrency: 2 })
  })

  it('resolves at once when nothing is pending', async () => {
    const { store } = await openStore()
    await expect(store.flush()).resolves.toBeUndefined()
  })
})
