import type { Health } from '@dj-scraper/shared'
import { Hono } from 'hono'
import type { HealthCheck } from '../engine/health.ts'

export type SystemDeps = { health: HealthCheck }

export const systemRoutes = ({ health }: SystemDeps) =>
  new Hono()
    .get('/health', async (c) => c.json((await health.current()) satisfies Health))
    // POST, not GET: a re-check spawns processes, so it goes through the JSON-only rule.
    .post('/health/recheck', async (c) => c.json((await health.recheck()) satisfies Health))
