import { healthProblems, WEB_DEV_PORT } from '@dj-scraper/shared'
import { createApp } from './app.ts'
import { ConfigError, defaultDownloadFolder, loadConfig } from './config.ts'
import {
  DataDirError,
  type DataDirLock,
  DataDirLocked,
  lockDataDir,
  prepareDataDir,
  sweepLeftovers,
} from './data-dir.ts'
import { checkHealth } from './engine/binaries.ts'
import { cachedHealthCheck } from './engine/health.ts'
import { killActiveGroups } from './engine/run.ts'
import { createFolderPicker } from './fs/folder-picker.ts'
import { HOSTNAME, type RunningServer, startServer } from './server.ts'
import { createServices } from './services.ts'
import { createSettingsStore } from './settings/store.ts'
import { type Services, shutDown } from './shutdown.ts'
import { afterListen } from './startup.ts'
import { errnoCode } from './util/errno.ts'

/** node --watch waits for the old process forever on restart, so shutdown needs a hard deadline. */
const SHUTDOWN_DEADLINE_MS = 8_000

// Engine processes run in their own process groups and survive us unless killed explicitly.
process.on('exit', killActiveGroups)

let services: Services | undefined
let stopping = false

const shutdown = () => {
  // pnpm dev delivers Ctrl-C twice (pnpm's group and node --watch), so this must be idempotent.
  if (stopping) return
  stopping = true
  setTimeout(() => {
    console.error('[server] Shutdown timed out')
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS).unref()
  // Still starting: nothing to close yet (the exit hook stops engine processes, and the OS
  // releases the data dir lock with the process).
  if (services === undefined) process.exit(0)
  shutDown(services).then(
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

function fail(message: string): never {
  console.error(`[server] ${message}`)
  process.exit(1)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env, process.argv.slice(2))
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  fail(error.message)
}

// The data dir: ours alone while we run (a second server waits for the first to stop, then gives
// up), so whatever a previous server left in jobs/ can be swept before anything new starts.
let dataDirReal: string
let lock: DataDirLock
try {
  dataDirReal = await prepareDataDir(config.dataDir)
  lock = await lockDataDir(dataDirReal)
} catch (error) {
  if (error instanceof DataDirLocked) fail(`${error.message}. Stop it first.`)
  if (error instanceof DataDirError) {
    fail(`${error.message}. Set DJS_DATA_DIR to use another folder.`)
  }
  throw error
}
if (lock.exclusive) {
  const swept = await sweepLeftovers(dataDirReal)
  if (swept.killed + swept.removed + swept.parts > 0) {
    console.log(
      `[server] Cleaned up after the previous server: ${swept.killed} process group(s) stopped, ${swept.removed} job entr${swept.removed === 1 ? 'y' : 'ies'} and ${swept.parts} part file(s) removed`,
    )
  }
}

const defaultFolder = defaultDownloadFolder(config.homeDir)
const settings = await createSettingsStore({ dataDir: dataDirReal, defaultFolder })

const health = cachedHealthCheck(() => checkHealth(config.engine, new Date()))
// Every event is checked against the contract in dev (tests turn it on in their own harnesses).
const { resolver, enricher, queue, streams, locate } = createServices({
  engine: config.engine,
  dataDirReal,
  settings,
  assertContract: config.dev,
})

let running: RunningServer
try {
  running = await startServer(config.port, (port) =>
    createApp({
      port,
      devPort: config.dev ? WEB_DEV_PORT : undefined,
      health,
      resolver,
      enricher,
      queue,
      settings,
      onConcurrency: (concurrency) => queue.setConcurrency(concurrency),
      locateEngine: locate,
      dataDirReal,
      defaultFolder,
      streams,
      picker: createFolderPicker(),
      // With --dev, Vite serves the UI.
      webRoot: config.dev ? undefined : config.webDist,
    }),
  )
} catch (error) {
  if (errnoCode(error) === 'EADDRINUSE') {
    fail(`Port ${config.port} is in use. Is DJ Scraper already running?`)
  }
  throw error
}
services = { lock, settings, queue, streams, running }
// A signal that came while starting found nothing to stop and has exited already.
lock.setPort(running.port)
console.log(
  `[server] DJ Scraper on http://${HOSTNAME}:${running.port}${config.dev ? ' (dev)' : ''}`,
)
// Warns about a missing UI build and handles --open (a failure to open only logs).
afterListen(config, running.port).catch((error: unknown) =>
  console.error('[server] Startup step failed:', error),
)

// Probe the engine at boot without delaying listen; the result also warms the cache.
health.current().then(
  (result) => {
    for (const problem of healthProblems(result)) console.warn(`[server] ${problem.message}`)
  },
  (error: unknown) => console.error('[server] Engine check failed:', error),
)
