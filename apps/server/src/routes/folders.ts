import { FolderPickRequestSchema, type FolderPickResponse } from '@dj-scraper/shared'
import { Hono } from 'hono'
import type { FolderPicker } from '../fs/folder-picker.ts'
import { checkPickedFolder, type FolderOps } from '../fs/folders.ts'
import { ApiError } from '../http/errors.ts'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import { StepError } from '../jobs/types.ts'

export type FolderDeps = {
  picker: FolderPicker
  /** The app data dir's real path: no download goes inside it, so no picked folder may be in it. */
  dataDirReal: string
  /** The folder checks' filesystem calls (tests script errors). */
  folderOps?: Partial<FolderOps>
}

/**
 * `c.req.raw.signal` aborts when the browser drops the request (the UI's Cancel, a closed tab),
 * which closes the picker: the pick then answers `{ canceled: true }` to nobody.
 *
 * A picked folder is checked as enqueue would check it, then read, so that macOS shows its privacy
 * prompt for a protected folder now and not in the middle of a batch. The answer waits for the
 * user to answer that prompt; the picker itself is closed by then.
 */
export const folderRoutes = ({ picker, dataDirReal, folderOps }: FolderDeps) =>
  new Hono().post('/folders/pick', jsonBodyLimit, async (c) => {
    const { startIn } = await readJson(c, FolderPickRequestSchema)
    const response = await picker.pick(startIn, c.req.raw.signal)
    if ('path' in response) {
      await checkPickedFolder(response.path, { dataDirReal }, folderOps).catch((error: unknown) => {
        throw error instanceof StepError ? new ApiError(error.code, error.message) : error
      })
    }
    return c.json(response satisfies FolderPickResponse)
  })
