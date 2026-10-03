import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  downloadsPanel,
  emptyState,
  inlineJob,
  jobRow,
  linkBox,
  nextDownloads,
  nextPost,
  pasteAnywhere,
  trackCard,
} from './app.ts'
import { SOUNDCLOUD_TRACK } from './fake-urls.ts'
import { expect, type ServerApi, test } from './fixtures.ts'

// The SoundCloud secret link (fake-urls.ts): a 10 s MP3 128 kbps track, downloaded as MP3 it is
// copied as is. SoundCloud, not YouTube, so these downloads leave YouTube's pacing to the specs
// that need YouTube.
// (A regex with quotes in an accessible name trips Playwright's selector parser: keep it plain.)
const TITLE = /^Dl Test Video/

/** The job's file, read back from the server: it must be the one file in `folder`. */
async function expectFileIn(server: ServerApi, jobId: string, folder: string) {
  const job = (await server.downloads()).jobs.find((candidate) => candidate.id === jobId)
  if (job?.status !== 'done') throw new Error(`job ${jobId} is ${job?.status ?? 'gone'}`)
  expect(await realpath(path.dirname(job.outputPath))).toBe(await realpath(folder))
  expect(await readdir(folder)).toEqual([path.basename(job.outputPath)])
  expect((await stat(job.outputPath)).size).toBeGreaterThan(0)
  return job
}

test('a track pasted anywhere downloads at once, shows done in the card and the panel, and Reveal in Finder asks the server', async ({
  page,
  downloadFolder,
  revealRequests,
  server,
}) => {
  await page.goto('/')
  await expect(linkBox(page)).toBeFocused()
  // A paste with the focus outside any text field (Edit › Paste): the page takes the link from the
  // pasted text.
  await emptyState(page).click()
  await expect(linkBox(page)).not.toBeFocused()
  const created = nextDownloads(page)
  await pasteAnywhere(page, `  ${SOUNDCLOUD_TRACK}\nshared from the SoundCloud app`)

  // The link lands in the box with what it is, and the card shows the track and its source.
  await expect(linkBox(page)).toHaveValue(SOUNDCLOUD_TRACK)
  await expect(linkBox(page)).toHaveAccessibleDescription(/SoundCloud.*Track.*private link/)
  const card = trackCard(page, TITLE)
  await expect(card).toContainText('Youtube')
  await expect(card).toContainText('0:10')
  await expect(card).toContainText('Source: MP3 128 kbps')

  // Auto-download: queued without a click, then done, with what the file really is.
  const {
    jobIds: [jobId],
  } = await created
  const status = inlineJob(card)
  await expect(status).toHaveAttribute('data-status', 'done')
  await expect(status.getByRole('status')).toContainText('Done')
  await expect(status).toContainText('MP3 · 128 kbps · copied')
  await expect(card.getByRole('button', { name: 'Download' })).toHaveCount(0)

  // The panel shows the same job, done, under its own batch.
  const panel = downloadsPanel(page)
  const row = jobRow(page, TITLE)
  await expect(row).toHaveAttribute('data-status', 'done')
  await expect(row).toContainText('MP3 · 128 kbps · copied')
  await expect(panel.locator('[data-slot="downloads-header"]').getByRole('status')).toHaveText(
    '1 done',
  )

  // Reveal in Finder, from the card and from the panel's row: each asks the server to show the
  // file (answered by the fixture, so Finder stays closed).
  await card.getByRole('button', { name: 'Reveal in Finder' }).click()
  await expect.poll(() => revealRequests.length).toBe(1)
  await row.getByRole('button', { name: /^Reveal .+ in Finder$/ }).click()
  await expect.poll(() => revealRequests.length).toBe(2)
  for (const request of revealRequests) {
    expect(request.method()).toBe('POST')
    expect(new URL(request.url()).pathname).toBe(`/api/downloads/${jobId}/reveal`)
  }

  // The file is in the folder, under the name the server reports.
  const job = await expectFileIn(server, jobId ?? '', downloadFolder)
  expect(job.output).toMatchObject({ ext: 'mp3', codec: 'mp3', encoded: false })
})

test('⌘V with nothing focused pastes into the link box, over its old text, and loads the link once', async ({
  page,
  settings,
}) => {
  // Nothing downloads: the key press is what this checks.
  await settings.set({ autoDownloadSingles: false })
  await page.goto('/')
  await expect(linkBox(page)).toBeFocused()
  await linkBox(page).fill('old text')

  // The link goes on the browser's clipboard with a real copy (a headless Playwright browser keeps
  // its own clipboard, not the system's). Removing the copied-from field leaves nothing focused.
  await page.evaluate((text) => {
    const source = document.createElement('textarea')
    source.id = 'e2e-copy-source'
    source.value = text
    document.body.append(source)
    source.focus()
    source.select()
  }, SOUNDCLOUD_TRACK)
  await page.keyboard.press('ControlOrMeta+C')
  await page.evaluate(() => document.getElementById('e2e-copy-source')?.remove())
  await expect(linkBox(page)).not.toBeFocused()

  const resolves: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/resolve') {
      resolves.push(request.postData() ?? '')
    }
  })
  const answered = nextPost(page, '/api/resolve')
  await page.keyboard.press('ControlOrMeta+V')
  await answered

  // The key moved the focus into the box and selected its text, so the paste replaced it.
  await expect(linkBox(page)).toBeFocused()
  await expect(linkBox(page)).toHaveValue(SOUNDCLOUD_TRACK)
  const card = trackCard(page, TITLE)
  await expect(card.getByRole('button', { name: 'Download' })).toBeVisible()
  // One load: the box took the paste, and the page-wide listener left it alone.
  expect(resolves.map((body) => JSON.parse(body))).toEqual([{ url: SOUNDCLOUD_TRACK }])
})

test('with auto-download off, a typed track waits for Download, in the format picked beside it', async ({
  page,
  settings,
  downloadFolder,
  server,
}) => {
  await settings.set({ autoDownloadSingles: false, format: 'mp3' })
  await page.goto('/')
  await expect(page.getByText('A single track shows a Download button')).toBeVisible()

  // Typing shows the badge; Enter loads the link.
  await linkBox(page).fill(SOUNDCLOUD_TRACK)
  await expect(linkBox(page)).toHaveAccessibleDescription(/SoundCloud.*Track/)
  const downloadRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/downloads') downloadRequests.push(request.url())
  })
  await linkBox(page).press('Enter')

  const card = trackCard(page, TITLE)
  const download = card.getByRole('button', { name: 'Download' })
  await expect(download).toBeVisible()
  expect(downloadRequests).toEqual([])

  // AIFF: a lossless container holds the MP3 source's quality, no more.
  await card.getByRole('combobox', { name: 'Format' }).click()
  await page.getByRole('option', { name: 'AIFF' }).click()
  await expect(card.getByRole('combobox', { name: 'Format' })).toHaveText(/AIFF/)
  await expect.poll(async () => (await server.settings()).format).toBe('aiff')

  const created = nextDownloads(page)
  await download.click()
  const {
    jobIds: [jobId],
  } = await created
  const status = inlineJob(card)
  await expect(status).toHaveAttribute('data-status', 'done')
  await expect(status).toContainText('AIFF · 16-bit · from MP3 128 kbps')
  await expect(download).toHaveCount(0)

  const job = await expectFileIn(server, jobId ?? '', downloadFolder)
  expect(job).toMatchObject({ format: 'aiff', output: { ext: 'aiff', encoded: true } })
})
