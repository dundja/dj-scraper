import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Health } from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { killActiveGroups, type RunResult, run } from '../src/engine/run.ts'
import { entryArgs, resolveArgs } from '../src/engine/ytdlp-args.ts'
import { createEnricher } from '../src/resolve/enricher.ts'
import { createResolver } from '../src/resolve/resolver.ts'
import { type RunningServer, startServer } from '../src/server.ts'
import { UNUSED_DOWNLOAD_DEPS } from '../src/stubs.ts'
import { makeTempDir, writeFakeTool } from './helpers.ts'

// A browser that closes a resolve request (tab closed, new paste) must stop the yt-dlp working for
// it. This checks the whole chain over a real socket: node-server aborts c.req.raw.signal on a
// premature close, and the signal reaches run(), which stops the (fake, hanging) yt-dlp.

const VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const ENTRY_URL = 'https://api.soundcloud.com/tracks/1001'

const health: Health = {
  ok: false,
  checkedAt: '2026-10-02T08:00:00.000Z',
  ytdlp: { status: 'missing', message: 'yt-dlp is not on PATH.' },
  ffmpeg: { status: 'missing', message: 'ffmpeg is not on PATH.' },
  ffprobe: { status: 'missing', message: 'ffprobe is not on PATH.' },
  jsRuntimes: [],
}
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

let root = ''
let server: RunningServer | undefined
beforeAll(async () => {
  root = await makeTempDir('resolve-abort')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(async () => {
  killActiveGroups()
  await server?.close()
  server = undefined
})

let binCount = 0
/** Starts the app with a fake yt-dlp that hangs when called with exactly `argv`. */
async function start(argv: readonly string[]) {
  const ytdlp = await writeFakeTool(path.join(root, `bin-${++binCount}`), 'yt-dlp', {
    argv,
    hang: true,
  })
  const engine = { YTDLP_PATH: ytdlp }
  const runs: Promise<RunResult>[] = []
  let started: () => void = () => {}
  const spawned = new Promise<void>((resolve) => {
    started = resolve
  })
  const spy: typeof run = (bin, args, options) => {
    const promise = run(bin, args, options)
    runs.push(promise)
    started()
    return promise
  }
  const resolver = createResolver({ engine, run: spy, log: quiet })
  const enricher = createEnricher({ engine, run: spy, log: quiet })
  const stubHealth = { current: async () => health, recheck: async () => health }
  server = await startServer(0, (port) =>
    createApp({ port, health: stubHealth, resolver, enricher, ...UNUSED_DOWNLOAD_DEPS }),
  )
  return { port: server.port, runs, spawned }
}

/** The request body as one Content-Length chunk, or streamed (chunked, read by bodyLimit). */
const bodies = {
  'with Content-Length': (json: string) => ({ body: json }),
  chunked: (json: string) => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json))
        controller.close()
      },
    }),
    duplex: 'half' as const,
  }),
}

describe.each(Object.entries(bodies))('a closed browser request (%s body)', (_label, body) => {
  it('stops the yt-dlp resolving it', async () => {
    const argv = resolveArgs({
      url: VIDEO_URL,
      playlist: 'no',
      limit: 5000,
      jsRuntime: process.execPath,
    })
    const { port, runs, spawned } = await start(argv)
    const controller = new AbortController()
    const request = fetch(`http://127.0.0.1:${port}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body(JSON.stringify({ url: VIDEO_URL })),
      signal: controller.signal,
    })
    await spawned
    controller.abort()
    await expect(request).rejects.toThrow()

    const [result] = await Promise.all(runs)
    expect(result).toMatchObject({ aborted: true, timedOut: false, signal: 'SIGINT' })
    expect(result?.durationMs).toBeLessThan(10_000)
  })

  it('stops the yt-dlp enriching rows for it', async () => {
    const { port, runs, spawned } = await start(
      entryArgs({ url: ENTRY_URL, jsRuntime: process.execPath }),
    )
    const controller = new AbortController()
    const request = fetch(`http://127.0.0.1:${port}/api/resolve/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body(
        JSON.stringify({ entries: [{ platform: 'soundcloud', id: '1001', url: ENTRY_URL }] }),
      ),
      signal: controller.signal,
    })
    await spawned
    controller.abort()
    await expect(request).rejects.toThrow()

    const [result] = await Promise.all(runs)
    expect(result).toMatchObject({ aborted: true, timedOut: false, signal: 'SIGINT' })
  })
})
