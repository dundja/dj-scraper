import { Hono } from 'hono'
import { onError, onNotFound } from './http/errors.ts'
import { type GuardOptions, guard } from './http/guard.ts'
import { securityHeaders } from './http/security-headers.ts'
import { type DownloadsDeps, downloadRoutes } from './routes/downloads.ts'
import { type EventsDeps, eventRoutes } from './routes/events.ts'
import { type FolderDeps, folderRoutes } from './routes/folders.ts'
import { type ResolveDeps, resolveRoutes } from './routes/resolve.ts'
import { type SettingsDeps, settingsRoutes } from './routes/settings.ts'
import { type SystemDeps, systemRoutes } from './routes/system.ts'
import { serveWeb } from './routes/web.ts'

export type AppDeps = GuardOptions &
  SystemDeps &
  ResolveDeps &
  DownloadsDeps &
  EventsDeps &
  SettingsDeps &
  FolderDeps & {
    /** The built UI (apps/web/dist) to serve. Undefined serves no UI, as with --dev (Vite does). */
    webRoot?: string | undefined
  }

export const createApp = (deps: AppDeps) => {
  const app = new Hono()
  // Registration order is execution order. The security headers wrap everything, the guard's
  // rejections included; the guard comes before every route, static files included.
  app.use(securityHeaders())
  app.use(guard(deps))
  app.route('/api', systemRoutes(deps))
  app.route('/api', resolveRoutes(deps))
  app.route('/api', downloadRoutes(deps))
  app.route('/api', eventRoutes(deps))
  app.route('/api', settingsRoutes(deps))
  app.route('/api', folderRoutes(deps))
  if (deps.webRoot !== undefined) app.get('*', serveWeb(deps.webRoot))
  app.notFound(onNotFound)
  app.onError(onError)
  return app
}
