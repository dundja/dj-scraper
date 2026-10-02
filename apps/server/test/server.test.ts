import net from 'node:net'
import { ApiErrorBodySchema, type Health, HealthSchema } from '@dj-scraper/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import type { HealthCheck } from '../src/engine/health.ts'
import { HOSTNAME, type RunningServer, startServer } from '../src/server.ts'

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}
const stubHealth: HealthCheck = { current: async () => health, recheck: async () => health }

let running: RunningServer[] = []
afterEach(async () => {
  await Promise.all(running.map((server) => server.close()))
  running = []
})

async function start(makeApp = (port: number) => createApp({ port, health: stubHealth })) {
  const server = await startServer(0, makeApp)
  running.push(server)
  return server
}

type RawResponse = { status: number; headers: string; body: string }

/** Sends raw bytes (\n becomes \r\n) and parses the reply once the server closes the socket. */
function raw(port: number, request: string): Promise<RawResponse | 'closed'> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, HOSTNAME, () => socket.write(request.replaceAll('\n', '\r\n')))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    socket.on('error', reject)
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(data)
      if (match?.[1] === undefined) return resolve('closed')
      const split = data.indexOf('\r\n\r\n')
      resolve({
        status: Number(match[1]),
        headers: data.slice(0, split).toLowerCase(),
        body: data.slice(split + 4),
      })
    })
  })
}

/** Resolves once a socket is connected, rejects with the connect error. */
const connect = (port: number, host: string) =>
  new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

describe('startServer', () => {
  it('listens on a free port when given 0 and serves the app with that port in the guard', async () => {
    const { port } = await start()
    expect(port).toBeGreaterThan(0)
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(res.status).toBe(200)
    expect(HealthSchema.parse(await res.json())).toStrictEqual(health)
  })

  it('serves http://localhost:<port>, the URL the browser uses', async () => {
    const { port } = await start()
    expect((await fetch(`http://localhost:${port}/api/health`)).status).toBe(200)
  })

  it('builds the app with the bound port', async () => {
    const ports: number[] = []
    const { port } = await start((p) => {
      ports.push(p)
      return createApp({ port: p, health: stubHealth })
    })
    expect(ports).toEqual([port])
  })

  it('binds 127.0.0.1 only, so the IPv6 loopback is refused', async () => {
    const { port } = await start()
    await expect(connect(port, '::1')).rejects.toThrow()
  })

  it('rejects with EADDRINUSE instead of crashing when the port is taken', async () => {
    const { port } = await start()
    let built = false
    const error = await startServer(port, (p) => {
      built = true
      return createApp({ port: p, health: stubHealth })
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'EADDRINUSE' })
    expect(built).toBe(false)
  })
})

describe('the guard over a real socket', () => {
  it.each([
    [
      'two Host headers, ours first',
      (h: string) => `GET /api/health HTTP/1.1\nHost: ${h}\nHost: evil.test\nConnection: close\n\n`,
    ],
    [
      'two Host headers, ours last',
      (h: string) => `GET /api/health HTTP/1.1\nHost: evil.test\nHost: ${h}\nConnection: close\n\n`,
    ],
    [
      'an absolute-form target for another host',
      (h: string) => `GET http://evil.test/api/health HTTP/1.1\nHost: ${h}\nConnection: close\n\n`,
    ],
    [
      'an absolute-form target for us, with a foreign Host',
      (h: string) => `GET http://${h}/api/health HTTP/1.1\nHost: evil.test\nConnection: close\n\n`,
    ],
    ['HTTP/1.0 without a Host', () => 'GET /api/health HTTP/1.0\n\n'],
    [
      'a DNS-rebinding Host',
      (h: string) =>
        `GET /api/health HTTP/1.1\nHost: rebind.evil.test:${h.split(':')[1]}\nConnection: close\n\n`,
    ],
    [
      'two Origin headers, ours first',
      (h: string) =>
        `POST /api/health/recheck HTTP/1.1\nHost: ${h}\nOrigin: http://${h}\nOrigin: http://evil.test\nContent-Type: application/json\nContent-Length: 2\nConnection: close\n\n{}`,
    ],
  ])('rejects %s with 403 forbidden', async (_label, request) => {
    const { port } = await start()
    const res = await raw(port, request(`localhost:${port}`))
    if (res === 'closed') throw new Error('socket closed without a response')
    expect(res.status).toBe(403)
    expect(res.headers).not.toContain('access-control-')
    expect(ApiErrorBodySchema.parse(JSON.parse(res.body)).error.code).toBe('forbidden')
  })

  it.each([
    ['two Content-Type headers, text then JSON', 'text/plain', 'application/json'],
    ['two JSON Content-Type headers', 'application/json', 'application/json'],
  ])('rejects %s on POST with 415', async (_label, first, second) => {
    const { port } = await start()
    const host = `localhost:${port}`
    const res = await raw(
      port,
      `POST /api/health/recheck HTTP/1.1\nHost: ${host}\nContent-Type: ${first}\nContent-Type: ${second}\nContent-Length: 2\nConnection: close\n\n{}`,
    )
    expect(res).toMatchObject({ status: 415 })
  })

  it('treats TRACE as an unsafe method that needs JSON', async () => {
    const { port } = await start()
    const res = await raw(
      port,
      `TRACE /api/health HTTP/1.1\nHost: localhost:${port}\nConnection: close\n\n`,
    )
    expect(res).toMatchObject({ status: 415 })
  })

  it.each([
    [
      'HTTP/1.1 with our Host',
      (h: string) => `GET /api/health HTTP/1.1\nHost: ${h}\nConnection: close\n\n`,
    ],
    ['HTTP/1.0 with our Host', (h: string) => `GET /api/health HTTP/1.0\nHost: ${h}\n\n`],
    [
      'an absolute-form target for us, with our Host',
      (h: string) => `GET http://${h}/api/health HTTP/1.1\nHost: ${h}\nConnection: close\n\n`,
    ],
  ])('accepts %s', async (_label, request) => {
    const { port } = await start()
    expect(await raw(port, request(`127.0.0.1:${port}`))).toMatchObject({ status: 200 })
  })

  it('leaves HTTP/1.1 without a Host to Node, which answers 400 before the app runs', async () => {
    const { port } = await start()
    expect(await raw(port, 'GET /api/health HTTP/1.1\nConnection: close\n\n')).toMatchObject({
      status: 400,
    })
  })
})

describe('RunningServer.close', () => {
  it('resolves promptly while a keep-alive connection is idle', async () => {
    const server = await startServer(0, (port) => createApp({ port, health: stubHealth }))
    const socket = await connect(server.port, HOSTNAME)
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    const answered = new Promise<void>((resolve) => socket.once('data', () => resolve()))
    socket.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`)
    await answered

    const startedAt = performance.now()
    await server.close()
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    await closed
  })

  it('resolves promptly while a response is still being produced (like an SSE stream)', async () => {
    let entered: () => void = () => {}
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const hanging: HealthCheck = {
      current: () => {
        entered()
        return new Promise<Health>(() => {})
      },
      recheck: async () => health,
    }
    const server = await startServer(0, (port) => createApp({ port, health: hanging }))
    const request = fetch(`http://127.0.0.1:${server.port}/api/health`)
    await handlerEntered

    const startedAt = performance.now()
    await server.close()
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    await expect(request).rejects.toThrow()
  })

  it('stops accepting new connections', async () => {
    const server = await startServer(0, (port) => createApp({ port, health: stubHealth }))
    await server.close()
    await expect(connect(server.port, HOSTNAME)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
