// @vitest-environment node
import { SERVER_PORT } from '@dj-scraper/shared'
import type { Plugin, ViteDevServer } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import config from './vite.config.ts'

// The dev server's defenses are plain config values (ADR-011). Each one silently reopens a hole
// when dropped, so pin them here.
describe('the Vite dev server config', () => {
  const server = config.server ?? {}

  it('proxies /api to the server, keeping the browser Host for its exact Host check', () => {
    // The string shorthand ('/api': 'http://…') would set changeOrigin: true.
    expect(server.proxy?.['/api']).toEqual({
      target: `http://127.0.0.1:${SERVER_PORT}`,
      changeOrigin: false,
    })
  })

  it('answers no CORS, refuses framing, and runs only on the trusted port', () => {
    expect(server).toMatchObject({
      port: 5173,
      strictPort: true,
      cors: false,
      headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
    })
    for (const key of ['allowedHosts', 'host', 'https']) expect(server).not.toHaveProperty(key)
  })

  it("installs the dev guard ahead of Vite's own file serving, proxy and endpoints", () => {
    const plugins = (config.plugins ?? []).flat() as Plugin[]
    const guard = plugins.find((plugin) => plugin?.name === 'dj-scraper:dev-guard')
    expect(guard).toBeDefined()

    const use = vi.fn()
    const hook = guard?.configureServer
    const handler = typeof hook === 'function' ? hook : hook?.handler
    // A returned function would be a post hook, which runs after Vite's middlewares.
    const returned = handler?.call(
      {} as never,
      { middlewares: { use } } as unknown as ViteDevServer,
    )
    expect(returned).toBeUndefined()
    expect(use).toHaveBeenCalledTimes(1)
    expect(use.mock.calls[0]).toEqual([expect.any(Function)])
  })
})
