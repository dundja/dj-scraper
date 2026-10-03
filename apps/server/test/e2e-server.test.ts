import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ApiErrorBodySchema,
  CreateDownloadsResponseSchema,
  DownloadsSnapshotSchema,
  HealthSchema,
  JobSchema,
  ResolveResultSchema,
  type Settings,
  SettingsSchema,
  TrackRefSchema,
} from '@dj-scraper/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
// The URLs the e2e specs use; the e2e-only rules below must answer them as that file says.
import {
  YOUTUBE_HANGING_TRACK,
  YOUTUBE_PRIVATE_IN_PLAYLIST,
  YOUTUBE_SLOW_PLAYLIST,
} from '../../web/e2e/fake-urls.ts'
import { FIXTURE_INDEX, freePort, makeTempDir, writeWebDist } from './helpers.ts'

// test/e2e-server.ts is the webServer of apps/web's Playwright config; this pins its contract.

const SCRIPT = path.join(import.meta.dirname, 'e2e-server.ts')
const YTDLP_DATE = expect.stringMatching(/^\d{4}\.\d{2}\.\d{2}$/)

let root = ''
let webDist = ''
beforeAll(async () => {
  root = await makeTempDir('e2e-server')
  webDist = await writeWebDist(path.join(root, 'dist'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Started in their own process group, so a failed test can't leave a server behind. */
const started: ChildProcessByStdio<null, Readable, Readable>[] = []
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // ESRCH: the group is gone already.
    }
  }
})

/** Runs the script from an unrelated cwd, as Playwright may. */
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: root,
    env: { TMPDIR: tmpdir(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  started.push(child)
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output.stderr += chunk
  })
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  return { child, output, exited }
}

/** POSTs `body` (if any) as JSON, as the app's mutations are. */
const post = (port: number, route: string, body?: unknown, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  })

/** GETs `route`, or POSTs `body` as JSON, and checks the 200 answer against the contract. */
async function api<T>(port: number, route: string, schema: z.ZodType<T>, body?: unknown) {
  const response =
    body === undefined
      ? await fetch(`http://127.0.0.1:${port}/api${route}`)
      : await post(port, route, body)
  const json: unknown = await response.json()
  expect(response.status, `${route}: ${JSON.stringify(json)}`).toBe(200)
  return schema.parse(json)
}

/** The request to download `items` (anything with a TrackRef's fields) with the server's settings. */
const downloadRequest = (settings: Settings, items: readonly unknown[]) => ({
  items: items.map((item) => TrackRefSchema.parse(item)),
  folder: settings.folder,
  options: {
    format: settings.format,
    filenameTemplate: settings.filenameTemplate,
    embedArtwork: settings.embedArtwork,
    sourceUrlComment: settings.sourceUrlComment,
  },
})

/** The fake yt-dlp's calls so far, from the log beside it (see writeFakeYtdlp). */
const CallSchema = z.object({ url: z.string().nullable(), pid: z.int().positive() })
async function fakeCalls(bin: string) {
  const log = await readFile(path.join(bin, '.yt-dlp.calls.jsonl'), 'utf8').catch(() => '')
  return log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => CallSchema.parse(JSON.parse(line)))
}

/** Whether a process with this pid exists (signal 0 only checks). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for the server's ready line; returns the fake engine's bin dir. */
async function ready(port: number, output: { stdout: string }) {
  await expect
    .poll(() => output.stdout, { timeout: 4_000 })
    .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
  return /Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? ''
}

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })

describe('e2e-server', () => {
  it.each([
    // Passed on by the script.
    ['SIGTERM to the script only', 'SIGTERM', 1],
    ['SIGINT to the script only', 'SIGINT', 1],
    // Playwright's gracefulShutdown and Ctrl-C signal the whole group: the server gets the signal
    // directly and forwarded, and must still exit cleanly.
    ['SIGTERM to its process group', 'SIGTERM', -1],
  ] as const)(
    'serves the built UI with a healthy fake engine, and cleans up on %s',
    async (_label, signal, target) => {
      const port = await freePort()
      const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
      await expect
        .poll(() => output.stdout, { timeout: 4_000 })
        .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
      const bin = /Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? ''
      expect(existsSync(bin)).toBe(true)

      const health = HealthSchema.parse(
        await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(),
      )
      expect(health).toMatchObject({
        ok: true,
        // A pattern, not today's date: the test may run across midnight UTC.
        ytdlp: { status: 'ok', path: path.join(bin, 'yt-dlp'), version: YTDLP_DATE },
        ffmpeg: { status: 'ok', version: '8.0' },
        ffprobe: { status: 'ok', version: '8.0' },
        jsRuntimes: [{ name: 'node', supported: true }],
      })
      const page = await fetch(`http://localhost:${port}/`)
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      expect(await page.text()).toBe(FIXTURE_INDEX)

      // Never pid 0: that would signal the test runner's own process group.
      if (child.pid === undefined) throw new Error('e2e-server has no pid')
      process.kill(target * child.pid, signal)
      expect(await exited).toEqual([0, null])
      expect(await refused(port)).toBe(true)
      expect(existsSync(path.dirname(bin))).toBe(false)
      expect(output.stderr).toBe('')
    },
  )

  it('resolves and downloads through the fake engine into the temp home folder, playlist rows included', {
    timeout: 20_000,
  }, async () => {
    const port = await freePort()
    const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
    await expect
      .poll(() => output.stdout, { timeout: 4_000 })
      .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
    const tempDir = path.dirname(/Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? '')

    const single = await api(port, '/resolve', ResolveResultSchema, {
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    })
    const playlist = await api(port, '/resolve', ResolveResultSchema, {
      url: 'https://www.youtube.com/playlist?list=PLYwq8WOe86_xGmR7FrcJq8Sb7VW8K3Tt2',
    })
    if (single.kind !== 'track' || playlist.kind !== 'collection') {
      throw new Error(`resolved ${single.kind} and ${playlist.kind}`)
    }
    // Rows 1 and 3 (row 2 is a private video): the script's own rules download them.
    const rows = playlist.collection.entries.filter((row) => row.availability !== 'unavailable')
    // Set row 6 by the API URL the set lists it with, as the UI sends it before the row's lookup.
    const setRow = {
      platform: 'soundcloud',
      id: '47127631',
      url: 'https://api-v2.soundcloud.com/tracks/47127631',
    }

    const settings = await api(port, '/settings', SettingsSchema)
    const { folder } = settings
    expect(folder.startsWith(`${tempDir}${path.sep}`)).toBe(true)
    expect(folder.endsWith(`${path.sep}${path.join('home', 'Music', 'DJ Scraper')}`)).toBe(true)
    const { jobIds } = await api(
      port,
      '/downloads',
      CreateDownloadsResponseSchema,
      downloadRequest(settings, [single.track, ...rows.slice(0, 2), setRow]),
    )
    const statuses = async () => {
      const { jobs } = await api(port, '/downloads', DownloadsSnapshotSchema)
      return jobIds.map((id) => jobs.find((job) => job.id === id)?.status)
    }
    await expect.poll(statuses, { timeout: 10_000 }).toEqual(['done', 'done', 'done', 'done'])
    // Each row's file has its own title and uploader.
    expect((await readdir(folder)).sort()).toEqual([
      "Nigeria's Got Talent - Oh God Why! (#NGT2 Asaba Theatre Auditions) - Nigeria's Got Talent.mp3",
      'The Royal Concept - Knocked Up.mp3',
      'WorkitWillis - Work it Willis.mp3',
      'jawed - Me at the zoo.mp3',
    ])

    child.kill('SIGTERM')
    expect(await exited).toEqual([0, null])
    // The downloads went with the temp dir.
    expect(existsSync(tempDir)).toBe(false)
    expect(output.stderr).toBe('')
  })

  it('answers the e2e-only links: a private track in a playlist, a download that hangs until canceled, a slow list', {
    timeout: 20_000,
  }, async () => {
    const port = await freePort()
    const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
    const bin = await ready(port, output)

    // The track lookup fails as the private video's does; its playlist still loads.
    const lookup = await post(port, '/resolve', { url: YOUTUBE_PRIVATE_IN_PLAYLIST })
    expect(lookup.status).toBe(422)
    expect(ApiErrorBodySchema.parse(await lookup.json()).error).toEqual({
      code: 'private',
      message: 'Private video.',
    })
    const list = await api(port, '/resolve', ResolveResultSchema, {
      url: YOUTUBE_PRIVATE_IN_PLAYLIST,
      mode: 'collection',
    })
    if (list.kind !== 'collection') throw new Error(`resolved ${list.kind}`)
    expect(list.collection.title).toBe('dlp test playlist')
    expect(list.collection.entries.map((entry) => entry.title)).toEqual([
      'dlp test video title translated (en)',
    ])

    // The hanging video resolves to its own track, and its download stops at 12 % until canceled.
    const hanging = await api(port, '/resolve', ResolveResultSchema, { url: YOUTUBE_HANGING_TRACK })
    if (hanging.kind !== 'track') throw new Error(`resolved ${hanging.kind}`)
    expect(hanging.track).toMatchObject({
      platform: 'youtube',
      id: 'e2eHangs001',
      url: YOUTUBE_HANGING_TRACK,
      title: 'Endless Download (e2e)',
      uploader: 'DJ Scraper e2e',
      durationSec: 245,
    })
    const settings = await api(port, '/settings', SettingsSchema)
    const {
      jobIds: [jobId],
    } = await api(
      port,
      '/downloads',
      CreateDownloadsResponseSchema,
      downloadRequest(settings, [hanging.track]),
    )
    const job = async () => {
      const { jobs } = await api(port, '/downloads', DownloadsSnapshotSchema)
      return jobs.find((candidate) => candidate.id === jobId)
    }
    await expect
      .poll(async () => {
        const current = await job()
        return current?.status === 'downloading' ? current.progress?.percent : current?.status
      })
      .toBeCloseTo(12.59, 1)
    await delay(500)
    expect((await job())?.status).toBe('downloading')
    const canceling = JobSchema.parse(await (await post(port, `/downloads/${jobId}/cancel`)).json())
    expect(canceling.cancelRequested).toBe(true)
    await expect.poll(async () => (await job())?.status).toBe('canceled')

    // The slow list is still loading after a while; closing the request stops its yt-dlp.
    const controller = new AbortController()
    let answered = false
    const slow = post(port, '/resolve', { url: YOUTUBE_SLOW_PLAYLIST }, controller.signal).then(
      () => {
        answered = true
      },
      (error: unknown) => error,
    )
    const call = async () => (await fakeCalls(bin)).find((c) => c.url === YOUTUBE_SLOW_PLAYLIST)
    await expect.poll(call).toBeDefined()
    const pid = (await call())?.pid ?? 0
    await delay(1_500)
    expect(answered).toBe(false)
    expect(alive(pid)).toBe(true)
    controller.abort()
    expect(await slow).toBeInstanceOf(Error)
    await expect.poll(() => alive(pid)).toBe(false)

    child.kill('SIGTERM')
    expect(await exited).toEqual([0, null])
  })

  it('stops the server with it when its process group is SIGKILLed', async () => {
    const port = await freePort()
    const { child, output, exited } = start({ PORT: String(port), DJS_WEB_DIST: webDist })
    await expect
      .poll(() => output.stdout, { timeout: 4_000 })
      .toContain(`[server] DJ Scraper on http://127.0.0.1:${port}\n`)
    const bin = /Fake engine in (\S+),/.exec(output.stdout)?.[1] ?? ''
    // The boot's engine probes run in process groups of their own, so the SIGKILL below misses
    // them, and each logs its call into `bin`. Let them finish first, or one that ends during the
    // rm below writes into the emptied dir (ENOTEMPTY).
    expect(await api(port, '/health', HealthSchema)).toMatchObject({ ok: true })

    // Playwright's fallback once gracefulShutdown times out, and what its exit handler sends.
    if (child.pid === undefined) throw new Error('e2e-server has no pid')
    process.kill(-child.pid, 'SIGKILL')
    expect(await exited).toEqual([null, 'SIGKILL'])
    // The server was in the same group, so it is gone too.
    await expect.poll(() => refused(port)).toBe(true)
    // No exit hook runs on SIGKILL, so the temp dir is left behind; remove it here.
    await rm(path.dirname(bin), { recursive: true, force: true })
  })

  it.each([
    [
      'without PORT',
      () => ({ DJS_WEB_DIST: webDist }),
      () => 'Set PORT to a free port from 1024 to 65535, e.g. PORT=4849.',
    ],
    [
      'without a built UI',
      () => ({ PORT: '4849', DJS_WEB_DIST: path.join(root, 'missing') }),
      () =>
        `No built UI in ${path.join(root, 'missing')}. Run \`pnpm --filter @dj-scraper/web build\` first.`,
    ],
    [
      'with a relative DJS_WEB_DIST',
      () => ({ PORT: '4849', DJS_WEB_DIST: 'dist' }),
      () => 'DJS_WEB_DIST must be an absolute path, not dist.',
    ],
  ])('exits 1 %s, before starting anything', async (_label, env, message) => {
    const { output, exited } = start(env())
    expect(await exited).toEqual([1, null])
    expect(output).toEqual({ stdout: '', stderr: `[e2e-server] ${message()}\n` })
  })
})
