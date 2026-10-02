import {
  ResolveEntriesRequestSchema,
  type ResolveEntriesResponse,
  ResolveRequestSchema,
  type ResolveResult,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import type { Enricher } from '../resolve/enricher.ts'
import type { Resolver } from '../resolve/resolver.ts'

export type ResolveDeps = { resolver: Resolver; enricher: Enricher }

/**
 * `c.req.raw.signal` aborts when the browser drops the request (node-server aborts it on a
 * premature close), which stops the yt-dlp processes working for it.
 */
export const resolveRoutes = ({ resolver, enricher }: ResolveDeps) =>
  new Hono()
    .post('/resolve', jsonBodyLimit, async (c) => {
      const request = await readJson(c, ResolveRequestSchema)
      const result = await resolver.resolve(request, c.req.raw.signal)
      return c.json(result satisfies ResolveResult)
    })
    .post('/resolve/entries', jsonBodyLimit, async (c) => {
      const request = await readJson(c, ResolveEntriesRequestSchema)
      const response = await enricher.enrich(request, c.req.raw.signal)
      return c.json(response satisfies ResolveEntriesResponse)
    })
