import * as z from 'zod'
import {
  DEFAULT_FILENAME_TEMPLATE,
  DownloadFormatSchema,
  FilenameTemplateSchema,
} from './download.ts'
import { FolderPathSchema } from './folder.ts'

export const MAX_RECENT_FOLDERS = 5
export const MAX_CONCURRENCY = 6
export const DEFAULT_CONCURRENCY = 3

/** The app's settings, kept by the server in settings.json in the app data dir. */
export const SettingsSchema = z.object({
  /** Where downloads go. The default is `~/Music/DJ Scraper`, filled in by the server. */
  folder: FolderPathSchema,
  /** Folders used before, newest first. Kept by the server: a download or a new `folder` adds one. */
  recentFolders: z.array(FolderPathSchema).max(MAX_RECENT_FOLDERS),
  format: DownloadFormatSchema,
  filenameTemplate: FilenameTemplateSchema,
  embedArtwork: z.boolean(),
  /** Write the track's public page URL into the comment tag. */
  sourceUrlComment: z.boolean(),
  /** Put a playlist's tracks into a folder named after it. */
  playlistSubfolder: z.boolean(),
  /** How many tracks download at once. */
  concurrency: z.int().min(1).max(MAX_CONCURRENCY),
  /** Start downloading a pasted single track at once. */
  autoDownloadSingles: z.boolean(),
})
export type Settings = z.infer<typeof SettingsSchema>

/** Every default except `folder`, which depends on the user's home folder. */
export const DEFAULT_SETTINGS = {
  recentFolders: [],
  format: 'mp3',
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  embedArtwork: true,
  sourceUrlComment: true,
  playlistSubfolder: false,
  concurrency: DEFAULT_CONCURRENCY,
  autoDownloadSingles: true,
} as const satisfies Omit<Settings, 'folder'>

/** `PUT /api/settings`: the fields to change. `recentFolders` is the server's to keep. */
export const SettingsUpdateSchema = SettingsSchema.omit({ recentFolders: true }).partial()
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>

/** `POST /api/folders/pick`: opens the macOS folder picker, starting in `startIn` when it exists. */
export const FolderPickRequestSchema = z.object({ startIn: FolderPathSchema.optional() })
export type FolderPickRequest = z.infer<typeof FolderPickRequestSchema>

export const FolderPickResponseSchema = z.union([
  z.object({ path: FolderPathSchema }),
  z.object({ canceled: z.literal(true) }),
])
export type FolderPickResponse = z.infer<typeof FolderPickResponseSchema>
