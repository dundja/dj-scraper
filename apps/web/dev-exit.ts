import type { Plugin, ViteDevServer } from 'vite'

/** Vite closes its watcher, sockets and optimizer in well under a second; this is for a hang. */
export const CLOSE_DEADLINE_MS = 5_000

const SIGNALS = ['SIGINT', 'SIGTERM'] as const

/**
 * The handlers' state lives on the host (`process`), not in this module: a config edit restarts
 * Vite in-process and re-evaluates this file along with vite.config.ts, while `process` stays.
 */
const STATE: unique symbol = Symbol.for('dj-scraper:dev-exit')

type DevServer = Pick<ViteDevServer, 'close' | 'config'>

type ExitState = {
  /** The newest dev server: a restart replaces the closed one. */
  server: DevServer
  stopping: boolean
}

/** What the plugin uses from Node's `process`. Tests pass a stand-in, so nothing really exits. */
export type ExitHost = {
  on(signal: (typeof SIGNALS)[number], listener: () => void): unknown
  exit(code: number): void
  exitCode: number | string | null | undefined
  [STATE]?: ExitState
}

/**
 * Dev server only: Ctrl-C (SIGINT) or SIGTERM closes the dev server and exits 0. Vite's CLI dies
 * by SIGINT and exits 143 on SIGTERM, so `pnpm dev` used to end every Ctrl-C with
 * ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL. Repeated signals and in-process restarts add no handlers.
 */
export const devExit = (host: ExitHost = process): Plugin => ({
  name: 'dj-scraper:dev-exit',
  apply: 'serve',
  configureServer(server) {
    exitOnSignals(host, server)
  },
})

function exitOnSignals(host: ExitHost, server: DevServer): void {
  const installed = host[STATE]
  if (installed !== undefined) {
    installed.server = server
    return
  }
  const state: ExitState = { server, stopping: false }
  host[STATE] = state

  const stop = () => {
    // pnpm can deliver one Ctrl-C more than once; the first one does the work.
    if (state.stopping) return
    state.stopping = true
    // Vite's own SIGTERM handler runs first: it closes the same server and exits with
    // `exitCode ?? 143` once close() settles. So on SIGTERM a failed close still exits 0 without a
    // report; only SIGINT reports it. The deadline below covers both.
    host.exitCode = 0
    const { logger } = state.server.config
    const fail = (message: string) => {
      logger.error(`[dev-exit] ${message}`, { timestamp: true })
      host.exit(1)
    }
    const deadline = setTimeout(
      () => fail(`The dev server didn't close within ${CLOSE_DEADLINE_MS / 1000} s.`),
      CLOSE_DEADLINE_MS,
    )
    deadline.unref()
    state.server
      .close()
      .finally(() => clearTimeout(deadline))
      .then(
        () => host.exit(0),
        (error: unknown) => fail(`Closing the dev server failed: ${String(error)}`),
      )
  }
  for (const signal of SIGNALS) host.on(signal, stop)
}
