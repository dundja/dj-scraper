import { FolderPickRequestSchema, type FolderPickResponse } from '@dj-scraper/shared'
import { Hono } from 'hono'
import type { FolderPicker } from '../fs/folder-picker.ts'
import { jsonBodyLimit, readJson } from '../http/json.ts'

export type FolderDeps = { picker: FolderPicker }

/**
 * `c.req.raw.signal` aborts when the browser drops the request (the UI's Cancel, a closed tab),
 * which closes the picker: the pick then answers `{ canceled: true }` to nobody.
 */
export const folderRoutes = ({ picker }: FolderDeps) =>
  new Hono().post('/folders/pick', jsonBodyLimit, async (c) => {
    const { startIn } = await readJson(c, FolderPickRequestSchema)
    const response = await picker.pick(startIn, c.req.raw.signal)
    return c.json(response satisfies FolderPickResponse)
  })
