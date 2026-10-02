// @vitest-environment node
import { EventEmitter } from 'node:events'
import type { ViteDevServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_DEADLINE_MS, devExit, type ExitHost } from './dev-exit.ts'

type Signal = 'SIGINT' | 'SIGTERM'

/** A stand-in for `process`: signals come from an emitter and exit only records its code. */
function fakeProcess() {
  const signals = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const host: ExitHost = {
    on: (signal, listener) => signals.on(signal, listener),
    exit,
    exitCode: undefined,
  }
  return {
    host,
    exit,
    send: (signal: Signal) => signals.emit(signal),
    handlers: (signal: Signal) => signals.listenerCount(signal),
  }
}

/** A dev server whose close() settles however `close` says. */
function fakeServer(close: () => Promise<void> = () => Promise.resolve()) {
  const error = vi.fn()
  const server = { close: vi.fn(close), config: { logger: { error } } }
  return { server, close: server.close, loggedError: error }
}

/** Starts a dev server the way Vite does: a fresh plugin from the config, then its hook. */
function startDevServer(
  host: ExitHost,
  server: ReturnType<typeof fakeServer>['server'],
  plugin = devExit,
) {
  const hook = plugin(host).configureServer
  const handler = typeof hook === 'function' ? hook : hook?.handler
  return handler?.call({} as never, server as unknown as ViteDevServer)
}

/** Lets pending promise callbacks (close → exit) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('the dev-exit plugin', () => {
  it('only runs in the dev server', () => {
    expect(devExit(fakeProcess().host)).toMatchObject({
      name: 'dj-scraper:dev-exit',
      apply: 'serve',
    })
  })

  it.each<Signal>(['SIGINT', 'SIGTERM'])(
    'closes the dev server and exits 0 on %s',
    async (signal) => {
      const { host, exit, send } = fakeProcess()
      const { server, close } = fakeServer()
      expect(startDevServer(host, server)).toBeUndefined()

      send(signal)
      // Set at once: Vite's own SIGTERM handler exits with `exitCode ?? 143` when its close is done.
      expect(host.exitCode).toBe(0)
      expect(close).toHaveBeenCalledTimes(1)
      expect(exit).not.toHaveBeenCalled()

      await settle()
      expect(exit.mock.calls).toEqual([[0]])
    },
  )

  it('waits for the server to close before exiting', async () => {
    const { host, exit, send } = fakeProcess()
    const { promise: closed, resolve: finishClosing } = Promise.withResolvers<void>()
    startDevServer(host, fakeServer(() => closed).server)

    send('SIGINT')
    await settle()
    expect(exit).not.toHaveBeenCalled()

    finishClosing()
    await settle()
    expect(exit.mock.calls).toEqual([[0]])
  })

  it('handles a repeated Ctrl-C, or SIGINT then SIGTERM, as one stop', async () => {
    const { host, exit, send } = fakeProcess()
    const { server, close } = fakeServer()
    startDevServer(host, server)

    send('SIGINT')
    send('SIGINT')
    send('SIGTERM')
    await settle()

    expect(close).toHaveBeenCalledTimes(1)
    expect(exit.mock.calls).toEqual([[0]])
  })

  it('keeps one handler per signal across restarts and closes the newest server', async () => {
    const { host, exit, send, handlers } = fakeProcess()
    const first = fakeServer()
    const second = fakeServer()
    // A config edit makes Vite build a new server and run every plugin's configureServer again.
    startDevServer(host, first.server)
    // Vite re-bundles and re-imports vite.config.ts on a restart, so dev-exit.ts runs again too.
    vi.resetModules()
    const reloaded = await import('./dev-exit.ts')
    startDevServer(host, second.server, reloaded.devExit)

    expect(handlers('SIGINT')).toBe(1)
    expect(handlers('SIGTERM')).toBe(1)

    send('SIGINT')
    await settle()
    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(exit.mock.calls).toEqual([[0]])
  })

  it('exits 1 and says why when closing the server fails', async () => {
    const { host, exit, send } = fakeProcess()
    const { server, loggedError } = fakeServer(() => Promise.reject(new Error('watcher stuck')))
    startDevServer(host, server)

    send('SIGINT')
    await settle()

    expect(exit.mock.calls).toEqual([[1]])
    expect(loggedError).toHaveBeenCalledWith(
      '[dev-exit] Closing the dev server failed: Error: watcher stuck',
      { timestamp: true },
    )
  })

  it('exits 1 when the server has not closed by the deadline', async () => {
    vi.useFakeTimers()
    const { host, exit, send } = fakeProcess()
    const { server, loggedError } = fakeServer(() => new Promise<void>(() => {}))
    startDevServer(host, server)

    send('SIGTERM')
    await vi.advanceTimersByTimeAsync(CLOSE_DEADLINE_MS - 1)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(exit.mock.calls).toEqual([[1]])
    expect(loggedError).toHaveBeenCalledWith("[dev-exit] The dev server didn't close within 5 s.", {
      timestamp: true,
    })
  })
})
