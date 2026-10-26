import { RemixRequestSchema, type RemixSuggestions } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import type { RemixFinder } from '../remix/finder.ts'

export type RemixDeps = { remixes: RemixFinder }

/**
 * `POST /api/remixes` (ADR-027). `c.req.raw.signal` aborts when the browser drops the request,
 * which stops a search no other request waits for.
 */
export const remixRoutes = ({ remixes }: RemixDeps) =>
  new Hono().post('/remixes', jsonBodyLimit, async (c) => {
    const request = await readJson(c, RemixRequestSchema)
    const answer = await remixes.find(request, c.req.raw.signal)
    return c.json(answer satisfies RemixSuggestions)
  })
