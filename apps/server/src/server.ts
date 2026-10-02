import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { Hono } from 'hono'

/** Non-negotiable: the server is never reachable from another machine. */
export const HOSTNAME = '127.0.0.1'

export type RunningServer = {
  /** The bound port; differs from the requested one when that was 0. */
  port: number
  /** Stops accepting, drops open connections (SSE included) and resolves once closed. */
  close: () => Promise<void>
}

/**
 * Listens first, then builds the app with the real port, so the Host guard also works with port 0
 * in tests. Rejects with the listen error (e.g. EADDRINUSE) instead of crashing the process, which
 * is why this isn't node-server's serve().
 */
export const startServer = (port: number, makeApp: (port: number) => Hono) =>
  new Promise<RunningServer>((resolve, reject) => {
    let app: Hono | undefined
    const server = createServer(
      getRequestListener(
        // No request arrives before 'listening', so app is set; the 503 only satisfies the types.
        (request, env) => (app ? app.fetch(request, env) : new Response(null, { status: 503 })),
        // URL authority for an HTTP/1.0 request without Host (the guard rejects it).
        { hostname: HOSTNAME },
      ),
    )
    server.once('error', reject)
    server.listen(port, HOSTNAME, () => {
      server.off('error', reject)
      // Later errors (e.g. EMFILE on accept) must not crash the process as unhandled 'error' events.
      server.on('error', (error) => console.error('[server] HTTP server error:', error))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Unexpected server address'))
        return
      }
      app = makeApp(address.port)
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()))
            // close() alone waits forever for an open SSE stream.
            server.closeAllConnections()
          }),
      })
    })
  })
