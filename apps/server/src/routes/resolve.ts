import {
  ResolveEntriesRequestSchema,
  type ResolveEntriesResponse,
  ResolveLinksRequestSchema,
  ResolveRequestSchema,
  type ResolveResult,
} from '@dj-scraper/shared'
import { Hono } from 'hono'
import { jsonBodyLimit, jsonBodyLimitOf, readJson } from '../http/json.ts'
import type { Enricher } from '../resolve/enricher.ts'
import type { Resolver } from '../resolve/resolver.ts'

/**
 * `POST /api/resolve/links` takes up to MAX_PASTED_LINKS links: 5,000 Spotify links with their
 * `?si=…` share ids are about 400 kB.
 */
export const LINKS_BODY_LIMIT_BYTES = 1024 * 1024

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
    .post('/resolve/links', jsonBodyLimitOf(LINKS_BODY_LIMIT_BYTES), async (c) => {
      const request = await readJson(c, ResolveLinksRequestSchema)
      return c.json(resolver.resolveLinks(request) satisfies ResolveResult)
    })
    .post('/resolve/entries', jsonBodyLimit, async (c) => {
      const request = await readJson(c, ResolveEntriesRequestSchema)
      const response = await enricher.enrich(request, c.req.raw.signal)
      return c.json(response satisfies ResolveEntriesResponse)
    })
