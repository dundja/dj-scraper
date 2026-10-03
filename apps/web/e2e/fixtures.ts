import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DownloadsSnapshot,
  DownloadsSnapshotSchema,
  isTerminalStatus,
  type Settings,
  SettingsSchema,
  type SettingsUpdate,
} from '@dj-scraper/shared'
import { type APIResponse, test as base, expect, type Request } from '@playwright/test'

/** The e2e server's API, for a spec's setup and for checks the page doesn't show. */
export type ServerApi = {
  settings: () => Promise<Settings>
  /** The queue as the server has it: jobs (with their output paths), batches, pacing. */
  downloads: () => Promise<DownloadsSnapshot>
}

/** Settings a spec changes; every change (the page's too) is undone after the test. */
export type SettingsControl = {
  set: (patch: SettingsUpdate) => Promise<Settings>
}

type ConsoleExpectation = { pattern: RegExp; seen: boolean }

type Fixtures = {
  /**
   * Lets this test's page log console errors matching `pattern` (tested against "<text> <url>"),
   * any number of times, and fails the test if none came: an expected error that never shows is
   * a broken expectation. Use failedLoad() for the browser's own line about an error answer.
   */
  expectConsoleError: (pattern: RegExp) => void
  /** Every POST /api/downloads/:id/reveal of the test, answered 204 here: never `open -R`. */
  revealRequests: Request[]
  server: ServerApi
  settings: SettingsControl
  /**
   * A new, empty folder in the e2e server's temp home (beside ~/Music/DJ Scraper there), made the
   * download folder for this test: downloads there end `done`, not `skipped` by an earlier test's
   * file. The settings go back afterwards.
   */
  downloadFolder: string
}

type Internal = {
  consoleExpectations: ConsoleExpectation[]
  consoleGuard: undefined
  networkGuard: undefined
  jobsCleared: undefined
}

/**
 * The line Chromium and WebKit log for a response with an error status, e.g. 422 from
 * /api/resolve: "Failed to load resource: the server responded with a status of 422 (…)" at its URL.
 */
export function failedLoad(status: number, pathname: string): RegExp {
  const escaped = pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^Failed to load resource: the server responded with a status of ${status}\\b.* https?://[^/]+${escaped}(\\?.*)?$`,
  )
}

/** A 1×1 PNG: what every remote thumbnail loads as, so no spec reaches YouTube's or SoundCloud's CDN. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const REVEAL = /\/api\/downloads\/[^/]+\/reveal$/

async function json(response: APIResponse): Promise<unknown> {
  if (!response.ok()) {
    throw new Error(`${response.url()}: ${response.status()} ${await response.text()}`)
  }
  return response.json()
}

/** The settings PUT takes back: all of them but `recentFolders`, which the server keeps. */
function updatable({ recentFolders: _recent, ...rest }: Settings): SettingsUpdate {
  return rest
}

/**
 * The e2e server's temp HOME, from its default folder (HOME/Music/DJ Scraper). Refuses anything
 * outside the temp dir, so a spec never writes into a real ~/Music.
 */
function serverHome(folder: string): string {
  const music = path.dirname(folder)
  const home = path.dirname(music)
  const temp = [tmpdir(), realpathSync(tmpdir())]
  if (
    path.basename(folder) !== 'DJ Scraper' ||
    path.basename(music) !== 'Music' ||
    !temp.some((dir) => home.startsWith(`${dir}${path.sep}`))
  ) {
    throw new Error(
      `Expected the e2e server's default folder (<temp HOME>/Music/DJ Scraper), got ${folder}`,
    )
  }
  return home
}

let folderCount = 0

/**
 * `test` for every spec. Besides the fixtures above, every test gets:
 * - a console guard: a console error or warning, or an uncaught page error, fails the test that
 *   caused it, as in the unit tests (src/test/setup.ts), unless the test expected it
 *   (expectConsoleError);
 * - a network guard: requests that would leave the e2e server's origin are answered here (remote
 *   thumbnails get a 1×1 PNG) or blocked, and a blocked one fails the test;
 * - reveal requests answered 204 without reaching the server (revealRequests);
 * - its settings restored afterwards (settings);
 * - no jobs from earlier tests: the downloads panel starts empty. A job an earlier test left at
 *   work (it failed before its own cleanup) is canceled first, so its failure doesn't spread.
 */
export const test = base.extend<Fixtures & Internal>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its first parameter.
  consoleExpectations: async ({}, use) => {
    await use([])
  },

  expectConsoleError: async ({ consoleExpectations }, use) => {
    await use((pattern) => {
      consoleExpectations.push({ pattern, seen: false })
    })
  },

  consoleGuard: [
    async ({ page, consoleExpectations }, use) => {
      const problems: string[] = []
      page.on('console', (message) => {
        const type = message.type()
        if (type !== 'error' && type !== 'warning') return
        const { url } = message.location()
        const line = url === '' ? message.text() : `${message.text()} ${url}`
        const expected =
          type === 'error'
            ? consoleExpectations.find(({ pattern }) => pattern.test(line))
            : undefined
        if (expected !== undefined) expected.seen = true
        else problems.push(`console.${type}: ${line}`)
      })
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
      await use(undefined)
      expect(problems, 'console errors, warnings or page errors').toEqual([])
      // A console event can still be on its way when the test's last check passes.
      const missing = () =>
        consoleExpectations.filter(({ seen }) => !seen).map(({ pattern }) => String(pattern))
      await expect
        .poll(missing, { message: 'expected console errors that never came', timeout: 2_000 })
        .toEqual([])
    },
    { auto: true },
  ],

  networkGuard: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL ?? 'http://127.0.0.1:4849').origin
      const blocked: string[] = []
      await context.route(
        (url) => url.origin !== origin,
        async (route) => {
          const request = route.request()
          if (request.resourceType() === 'image') {
            await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
          } else {
            blocked.push(`${request.method()} ${request.url()}`)
            await route.abort('blockedbyclient')
          }
        },
      )
      await use(undefined)
      expect(blocked, 'requests that would have left the machine').toEqual([])
    },
    { auto: true },
  ],

  revealRequests: [
    async ({ context }, use) => {
      const requests: Request[] = []
      await context.route(REVEAL, async (route) => {
        requests.push(route.request())
        await route.fulfill({ status: 204 })
      })
      await use(requests)
    },
    { auto: true },
  ],

  server: async ({ request }, use) => {
    await use({
      settings: async () => SettingsSchema.parse(await json(await request.get('/api/settings'))),
      downloads: async () =>
        DownloadsSnapshotSchema.parse(await json(await request.get('/api/downloads'))),
    })
  },

  settings: [
    async ({ request, server }, use) => {
      const put = async (patch: SettingsUpdate) =>
        SettingsSchema.parse(await json(await request.put('/api/settings', { data: patch })))
      const before = updatable(await server.settings())
      await use({ set: put })
      const after = updatable(await server.settings())
      if (JSON.stringify(after) !== JSON.stringify(before)) await put(before)
    },
    { auto: true },
  ],

  jobsCleared: [
    async ({ request, server }, use) => {
      const all = { target: { scope: 'all' } }
      await json(await request.post('/api/downloads/cancel', { data: all }))
      // A running job stops a moment later (cancelRequested until its attempt settles), and only a
      // finished job can be cleared.
      const atWork = async () =>
        (await server.downloads()).jobs
          .filter((job) => !isTerminalStatus(job.status))
          .map((job) => `${job.track.title ?? job.track.url}: ${job.status}`)
      await expect
        .poll(atWork, { message: 'jobs still at work after Cancel all', timeout: 10_000 })
        .toEqual([])
      await json(await request.post('/api/downloads/clear', { data: all }))
      await use(undefined)
    },
    { auto: true },
  ],

  downloadFolder: async ({ server, settings }, use, testInfo) => {
    const home = serverHome((await server.settings()).folder)
    folderCount += 1
    const name = `${testInfo.project.name}-${testInfo.workerIndex}-${folderCount}`
    const folder = path.join(home, 'Music', 'e2e', name)
    await mkdir(folder, { recursive: true })
    await settings.set({ folder })
    await use(folder)
  },
})

export { expect }
