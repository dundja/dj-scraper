import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import type { DownloadFormat } from './download.ts'
import type { FolderPath } from './folder.ts'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_SETTINGS,
  type FolderPickRequest,
  FolderPickRequestSchema,
  type FolderPickResponse,
  FolderPickResponseSchema,
  MAX_CONCURRENCY,
  MAX_RECENT_FOLDERS,
  type Settings,
  SettingsSchema,
  type SettingsUpdate,
  SettingsUpdateSchema,
} from './settings.ts'
import { issuePaths, type OptionalKeys, without } from './test-helpers.ts'

const defaultFolder = '/Users/dj/Music/DJ Scraper'

/** What a fresh install reads: the defaults plus the folder the server fills in. */
const freshSettings = { ...DEFAULT_SETTINGS, folder: defaultFolder } satisfies Settings

/** Every field away from its default, so a dropped or renamed field shows. */
const customSettings = {
  folder: '/Volumes/USB/Sets',
  recentFolders: ['/Volumes/USB/Sets', defaultFolder, '/Users/dj/Música/東京'],
  format: 'aiff',
  filenameTemplate: '{artist} - {title} ({year})',
  embedArtwork: false,
  sourceUrlComment: false,
  playlistSubfolder: true,
  concurrency: MAX_CONCURRENCY,
  autoDownloadSingles: false,
} satisfies Settings

const settingsFields = [
  'folder',
  'recentFolders',
  'format',
  'filenameTemplate',
  'embedArtwork',
  'sourceUrlComment',
  'playlistSubfolder',
  'concurrency',
  'autoDownloadSingles',
] as const

const folders = (count: number): string[] =>
  Array.from({ length: count }, (_, n) => `/Users/dj/Music/Set ${n + 1}`)

/** Values each settings field must refuse, in PUT /api/settings and in settings.json alike. */
const invalidValues = [
  ['folder', '/Volumes/USB/'],
  ['folder', '~/Music'],
  ['folder', null],
  ['format', 'opus'],
  ['filenameTemplate', '{artist}'],
  ['filenameTemplate', '{artist}/{title}'],
  ['embedArtwork', 'true'],
  ['sourceUrlComment', 1],
  ['playlistSubfolder', null],
  ['concurrency', 0],
  ['concurrency', MAX_CONCURRENCY + 1],
  ['concurrency', 2.5],
  ['concurrency', '3'],
  ['autoDownloadSingles', 'yes'],
] as const

describe('DEFAULT_SETTINGS', () => {
  it('parses unchanged once the server adds the folder', () => {
    expect(SettingsSchema.parse(freshSettings)).toStrictEqual(freshSettings)
  })

  it('matches the defaults of the product spec', () => {
    expect(DEFAULT_SETTINGS).toStrictEqual({
      recentFolders: [],
      format: 'mp3',
      filenameTemplate: '{artist} - {title}',
      embedArtwork: true,
      sourceUrlComment: true,
      playlistSubfolder: false,
      concurrency: 3,
      autoDownloadSingles: true,
    })
    expect(DEFAULT_CONCURRENCY).toBe(DEFAULT_SETTINGS.concurrency)
  })

  it('runs a few downloads at once, within the cap', () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(MAX_CONCURRENCY)
  })

  it('has every setting but the folder', () => {
    expectTypeOf<keyof typeof DEFAULT_SETTINGS>().toEqualTypeOf<Exclude<keyof Settings, 'folder'>>()
  })
})

describe('SettingsSchema', () => {
  it.each([
    ['fresh settings', freshSettings],
    ['settings with every field changed', customSettings],
  ])('parses %s unchanged', (_label, settings) => {
    expect(SettingsSchema.parse(settings)).toStrictEqual(settings)
  })

  it.each(settingsFields)('requires %s', (field) => {
    expect(issuePaths(SettingsSchema, without(customSettings, field))).toEqual([[field]])
  })

  it.each(invalidValues)('rejects %s %j', (field, value) => {
    expect(issuePaths(SettingsSchema, { ...customSettings, [field]: value })).toEqual([[field]])
  })

  it.each([1, MAX_CONCURRENCY])('accepts a concurrency of %i', (concurrency) => {
    expect(issuePaths(SettingsSchema, { ...customSettings, concurrency })).toEqual([])
  })

  it('keeps up to MAX_RECENT_FOLDERS recent folders', () => {
    const recentFolders = folders(MAX_RECENT_FOLDERS)
    expect(issuePaths(SettingsSchema, { ...customSettings, recentFolders })).toEqual([])
    expect(
      issuePaths(SettingsSchema, {
        ...customSettings,
        recentFolders: folders(MAX_RECENT_FOLDERS + 1),
      }),
    ).toEqual([['recentFolders']])
  })

  it('reports a recent folder that is not normalized at its index', () => {
    const recentFolders = [defaultFolder, '/Volumes/USB/']
    expect(issuePaths(SettingsSchema, { ...customSettings, recentFolders })).toEqual([
      ['recentFolders', 1],
    ])
  })

  it('strips unknown keys, such as a setting an older version wrote', () => {
    expect(SettingsSchema.parse({ ...customSettings, skipExisting: true })).toStrictEqual(
      customSettings,
    )
  })

  it('caps concurrency at 6 and remembers 5 folders', () => {
    expect(MAX_CONCURRENCY).toBe(6)
    expect(MAX_RECENT_FOLDERS).toBe(5)
  })

  it('types the settings with the contract types', () => {
    expectTypeOf<Settings>().toEqualTypeOf<{
      folder: FolderPath
      recentFolders: FolderPath[]
      format: DownloadFormat
      filenameTemplate: string
      embedArtwork: boolean
      sourceUrlComment: boolean
      playlistSubfolder: boolean
      concurrency: number
      autoDownloadSingles: boolean
    }>()
    expectTypeOf<z.input<typeof SettingsSchema>>().toEqualTypeOf<Settings>()
  })

  it('lets the server build Settings from the defaults and a folder', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, folder: defaultFolder }
    expect(SettingsSchema.parse(settings)).toStrictEqual(freshSettings)
  })
})

describe('SettingsUpdateSchema', () => {
  const fullUpdate = without(customSettings, 'recentFolders')

  it.each([
    ['an empty update', {}],
    ['a new folder', { folder: '/Volumes/USB/Sets' }],
    ['a new format and concurrency', { format: 'wav', concurrency: 1 }],
    ['every field it takes', fullUpdate],
  ])('parses %s unchanged', (_label, update) => {
    expect(SettingsUpdateSchema.parse(update)).toStrictEqual(update)
  })

  it('drops recentFolders without an error: the server keeps that list itself', () => {
    const recentFolders = ['/Users/dj/Desktop']
    expect(SettingsUpdateSchema.parse({ recentFolders })).toStrictEqual({})
    expect(SettingsUpdateSchema.parse({ recentFolders, concurrency: 2 })).toStrictEqual({
      concurrency: 2,
    })
  })

  it('drops other unknown keys too', () => {
    expect(SettingsUpdateSchema.parse({ theme: 'light', embedArtwork: false })).toStrictEqual({
      embedArtwork: false,
    })
  })

  it.each(invalidValues)('rejects %s %j', (field, value) => {
    expect(issuePaths(SettingsUpdateSchema, { [field]: value })).toEqual([[field]])
  })

  it('makes every field but recentFolders optional', () => {
    expectTypeOf<keyof SettingsUpdate>().toEqualTypeOf<Exclude<keyof Settings, 'recentFolders'>>()
    expectTypeOf<OptionalKeys<SettingsUpdate>>().toEqualTypeOf<keyof SettingsUpdate>()
    expectTypeOf<SettingsUpdate['concurrency']>().toEqualTypeOf<number | undefined>()
  })
})

describe('FolderPickRequestSchema', () => {
  it.each([
    ['no start folder', {}],
    ['a start folder', { startIn: defaultFolder }],
  ])('parses a request with %s unchanged', (_label, request) => {
    expect(FolderPickRequestSchema.parse(request)).toStrictEqual(request)
  })

  it.each(['/Volumes/USB/', '~/Music', 'Music', ''])('rejects the start folder %j', (startIn) => {
    expect(issuePaths(FolderPickRequestSchema, { startIn })).toEqual([['startIn']])
  })

  it('makes the start folder optional', () => {
    expectTypeOf<FolderPickRequest>().toEqualTypeOf<{ startIn?: FolderPath | undefined }>()
  })
})

describe('FolderPickResponseSchema', () => {
  it.each([
    ['a picked folder', { path: '/Volumes/USB' }],
    ['the root', { path: '/' }],
    ['a canceled pick', { canceled: true }],
  ])('parses %s unchanged', (_label, response) => {
    expect(FolderPickResponseSchema.parse(response)).toStrictEqual(response)
  })

  it.each([
    ['the raw picker path with its trailing slash: the server normalizes it', '/Volumes/USB/'],
    ['a relative path', 'Music'],
    ['a file URL', 'file:///Volumes/USB/'],
  ])('rejects %s', (_label, path) => {
    expect(issuePaths(FolderPickResponseSchema, { path })).toEqual([['path']])
  })

  it.each([
    ['canceled false', { canceled: false }],
    ['an empty object', {}],
    ['a bare path string', '/Volumes/USB'],
  ])('rejects %s', (_label, response) => {
    expect(issuePaths(FolderPickResponseSchema, response)).toEqual([[]])
  })

  it('is a path or a cancel', () => {
    expectTypeOf<FolderPickResponse>().toEqualTypeOf<{ path: FolderPath } | { canceled: true }>()
  })
})
