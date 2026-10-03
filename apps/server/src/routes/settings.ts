import { type Settings, SettingsUpdateSchema } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { checkPickedFolder, type FolderOps } from '../fs/folders.ts'
import { ApiError } from '../http/errors.ts'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import { StepError } from '../jobs/types.ts'
import type { SettingsStore } from '../settings/store.ts'

export type SettingsDeps = {
  settings: SettingsStore
  /** The app data dir's real path: no download goes inside it, so no chosen folder may be in it. */
  dataDirReal: string
  /** `defaultDownloadFolder(homeDir)`: a valid choice while missing, since a download creates it. */
  defaultFolder: string
  /** The folder checks' filesystem calls (tests script errors). */
  folderOps?: Partial<FolderOps>
  /** Called when a PUT changed `concurrency`, with the new value (the queue resizes). */
  onConcurrency?: (concurrency: number) => void
}

/**
 * PUT takes the fields to change; recentFolders is the server's to keep, so it is dropped.
 *
 * A new `folder` gets the checks a folder picked in the dialog gets (POST /api/folders/pick), so a
 * folder you name must exist when you choose it, e.g. a recent one deleted or on a drive that is
 * out: 422 `folder_unavailable`, and nothing of the request is saved. The default folder is the
 * exception (POST /api/downloads creates it). An unchanged folder isn't checked again, so other
 * settings still save while its drive is out; enqueue checks it anyway.
 *
 * PUTs apply one at a time, in the order they arrive: a folder check can take a while (the read
 * waits for the answer to macOS's privacy prompt), and a later PUT must not be saved first and
 * then overwritten by the older one (two tabs, or any client that doesn't wait for the answer).
 */
export const settingsRoutes = ({
  settings,
  dataDirReal,
  defaultFolder,
  folderOps,
  onConcurrency,
}: SettingsDeps) => {
  let previous: Promise<unknown> = Promise.resolve()
  const inOrder = <T>(task: () => Promise<T>): Promise<T> => {
    const result = previous.then(task)
    previous = result.catch(() => {})
    return result
  }

  return new Hono()
    .get('/settings', (c) => c.json(settings.get() satisfies Settings))
    .put('/settings', jsonBodyLimit, async (c) => {
      const patch = await readJson(c, SettingsUpdateSchema)
      const updated = await inOrder(async () => {
        const { folder } = patch
        if (folder !== undefined && folder !== settings.get().folder && folder !== defaultFolder) {
          await checkPickedFolder(folder, { dataDirReal }, folderOps).catch((error: unknown) => {
            throw error instanceof StepError ? new ApiError(error.code, error.message) : error
          })
        }
        const before = settings.get().concurrency
        const next = await settings.update(patch)
        if (next.concurrency !== before) onConcurrency?.(next.concurrency)
        return next
      })
      return c.json(updated satisfies Settings)
    })
}
