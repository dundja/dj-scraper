import { Readable } from 'node:stream'
import { PREVIEW_ID_PATTERN, type PreviewReady, PreviewRequestSchema } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { ApiError } from '../http/errors.ts'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import { parseRange } from '../preview/plan.ts'
import type { PreviewStore } from '../preview/store.ts'

export type PreviewDeps = { previews: PreviewStore }

/**
 * `/previews…` (ADR-029). `POST` fetches an upload's audio into the preview cache and answers with
 * the same-origin path to play it from; `GET /previews/:id` serves a cached file to an `<audio>`
 * element with range requests (seeking), never cached by the browser. The file is looked up by an
 * id of 32 hex characters under the cache dir, opened without following a symlink.
 */
export const previewRoutes = ({ previews }: PreviewDeps) =>
  new Hono()
    .post('/previews', jsonBodyLimit, async (c) => {
      const request = await readJson(c, PreviewRequestSchema)
      const ready = await previews.prepare(request, c.req.raw.signal)
      return c.json(ready satisfies PreviewReady)
    })
    .get('/previews/:id', async (c) => {
      const id = c.req.param('id')
      if (!PREVIEW_ID_PATTERN.test(id)) throw new ApiError('not_found', 'Not found')
      const opened = await previews.open(id)
      if (opened === undefined) throw new ApiError('not_found', 'Not found')
      const { handle, size, mime } = opened
      const range = parseRange(c.req.header('range'), size)
      if (range.kind === 'unsatisfiable') {
        await handle.close()
        return c.body(null, 416, {
          'Content-Range': `bytes */${size}`,
          'Cache-Control': 'no-store',
        })
      }
      const [start, end] = range.kind === 'partial' ? [range.start, range.end] : [0, size - 1]
      const headers: Record<string, string> = {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }
      if (range.kind === 'partial') headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      const status = range.kind === 'partial' ? 206 : 200
      // HEAD never opens a stream: Hono runs this handler for it and drops the body unread.
      if (c.req.method === 'HEAD') {
        await handle.close()
        return c.body(null, status, headers)
      }
      // autoClose: the handle closes when the stream ends, errors or the client goes away.
      const stream = handle.createReadStream({ start, end, autoClose: true })
      return c.body(Readable.toWeb(stream) as ReadableStream, status, headers)
    })
