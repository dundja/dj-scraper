import type { Config } from './config.ts'
import { type RunOptions, type RunResult, run } from './engine/run.ts'
import { hasBuiltUi } from './routes/web.ts'
import { HOSTNAME } from './server.ts'

/** macOS: hands the URL to the default browser and exits; it doesn't wait for the browser. */
const OPEN_BIN = '/usr/bin/open'
const OPEN_TIMEOUT_MS = 10_000

export type OpenBrowserDeps = {
  platform: NodeJS.Platform
  run: (bin: string, argv: readonly string[], options: RunOptions) => Promise<RunResult>
  log: (message: string) => void
  warn: (message: string) => void
}

const defaultOpenDeps: OpenBrowserDeps = {
  platform: process.platform,
  run,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
}

/**
 * Opens `url` in the default browser: `/usr/bin/open <url>` on macOS (argv only, no shell), and a
 * log line with the URL elsewhere. Never throws: a failure only logs, the server keeps running.
 */
export async function openBrowser(url: string, deps = defaultOpenDeps): Promise<void> {
  if (deps.platform !== 'darwin') {
    deps.log(`[server] Open ${url} in your browser.`)
    return
  }
  let failure: string | undefined
  try {
    const result = await deps.run(OPEN_BIN, [url], {
      timeoutMs: OPEN_TIMEOUT_MS,
      killGraceMs: 1_000,
    })
    if (result.timedOut) failure = `open timed out after ${OPEN_TIMEOUT_MS / 1_000} s`
    else if (result.exitCode !== 0) {
      const reason = result.stderr.trim().split('\n')[0]
      failure = `open exited with ${result.exitCode ?? result.signal}${reason ? `: ${reason}` : ''}`
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure !== undefined) {
    deps.warn(`[server] Could not open the browser (${failure}). Open ${url} yourself.`)
  }
}

export type AfterListenDeps = {
  openBrowser: (url: string) => Promise<void>
  warn: (message: string) => void
}

/**
 * Once the server listens, outside dev mode (Vite serves the UI then): warn when there is no built
 * UI to serve (the API still works), and open the UI in the browser for --open (`pnpm start`).
 */
export async function afterListen(
  config: Pick<Config, 'dev' | 'open' | 'webDist'>,
  port: number,
  deps: AfterListenDeps = { openBrowser, warn: (message) => console.warn(message) },
): Promise<void> {
  if (config.dev) return
  if (!hasBuiltUi(config.webDist)) {
    deps.warn(`[server] No built UI in ${config.webDist}. Run \`pnpm build\` (pnpm start does).`)
  }
  if (config.open) await deps.openBrowser(`http://${HOSTNAME}:${port}/`)
}
