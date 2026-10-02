import { createApp } from './app.ts'
import { ConfigError, DEV_ORIGINS, loadConfig } from './config.ts'
import { checkHealth } from './engine/binaries.ts'
import { cachedHealthCheck, healthWarnings } from './engine/health.ts'
import { killActiveGroups } from './engine/run.ts'
import { HOSTNAME, type RunningServer, startServer } from './server.ts'

/** node --watch waits for the old process forever on restart, so shutdown needs a hard deadline. */
const SHUTDOWN_DEADLINE_MS = 8_000

// Engine processes run in their own process groups and survive us unless killed explicitly.
process.on('exit', killActiveGroups)

let running: RunningServer | undefined
let stopping = false
const shutdown = () => {
  // pnpm dev delivers Ctrl-C twice (pnpm's group and node --watch), so this must be idempotent.
  if (stopping) return
  stopping = true
  setTimeout(() => {
    console.error('[server] Shutdown timed out')
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS).unref()
  // Still starting: nothing to close yet.
  if (running === undefined) process.exit(0)
  running.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('[server] Error while closing:', error)
      process.exit(1)
    },
  )
}
// Registered before listening, so a signal right after the "listening" line still shuts down
// cleanly. `on`, not `once`: a second signal must hit the `stopping` guard, not Node's default
// action, which would skip the exit hook and orphan engine processes. SIGHUP is a closed terminal.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown)

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env, process.argv.slice(2))
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(`[server] ${error.message}`)
  process.exit(1)
}

const health = cachedHealthCheck(() => checkHealth(config.engine, new Date()))

try {
  running = await startServer(config.port, (port) =>
    createApp({ port, extraOrigins: config.dev ? DEV_ORIGINS : [], health }),
  )
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(`[server] Port ${config.port} is in use. Is DJ Scraper already running?`)
    process.exit(1)
  }
  throw error
}
console.log(
  `[server] DJ Scraper on http://${HOSTNAME}:${running.port}${config.dev ? ' (dev)' : ''}`,
)

// Probe the engine at boot without delaying listen; the result also warms the cache.
health.current().then(
  (result) => {
    for (const warning of healthWarnings(result)) console.warn(`[server] ${warning}`)
  },
  (error: unknown) => console.error('[server] Engine check failed:', error),
)
