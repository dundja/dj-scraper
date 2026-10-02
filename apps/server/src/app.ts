import { Hono } from 'hono'
import { onError, onNotFound } from './http/errors.ts'
import { type GuardOptions, guard } from './http/guard.ts'
import { type SystemDeps, systemRoutes } from './routes/system.ts'

export type AppDeps = GuardOptions & SystemDeps

export const createApp = (deps: AppDeps) => {
  const app = new Hono()
  // Registration order is execution order: the guard comes before every route.
  app.use(guard(deps))
  app.route('/api', systemRoutes(deps))
  app.notFound(onNotFound)
  app.onError(onError)
  return app
}
