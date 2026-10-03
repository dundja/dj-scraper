import { type Settings, SettingsUpdateSchema } from '@dj-scraper/shared'
import { Hono } from 'hono'
import { jsonBodyLimit, readJson } from '../http/json.ts'
import type { SettingsStore } from '../settings/store.ts'

export type SettingsDeps = {
  settings: SettingsStore
  /** Called when a PUT changed `concurrency`, with the new value (the queue resizes). */
  onConcurrency?: (concurrency: number) => void
}

export const settingsRoutes = ({ settings, onConcurrency }: SettingsDeps) =>
  new Hono()
    .get('/settings', (c) => c.json(settings.get() satisfies Settings))
    // PUT takes the fields to change; recentFolders is the server's to keep, so it is dropped.
    .put('/settings', jsonBodyLimit, async (c) => {
      const patch = await readJson(c, SettingsUpdateSchema)
      const before = settings.get().concurrency
      const updated = await settings.update(patch)
      if (updated.concurrency !== before) onConcurrency?.(updated.concurrency)
      return c.json(updated satisfies Settings)
    })
