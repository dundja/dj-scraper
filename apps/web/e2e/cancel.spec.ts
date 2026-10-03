import { readdir } from 'node:fs/promises'
import { isTerminalStatus } from '@dj-scraper/shared'
import { inlineJob, jobRow, linkBox, nextDownloads, trackCard } from './app.ts'
import { YOUTUBE_HANGING_TRACK } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// The made-up video whose download reports 12 % and then hangs until it is canceled (fake-urls.ts).
// Two YouTube downloads per browser: the first attempt and the retry.
const TITLE = 'Endless Download (e2e)'

test('a running download cancels in one click from the card, retries, and cancels from the panel', async ({
  page,
  request,
  server,
  downloadFolder,
}) => {
  await page.goto('/')
  // The card queues the download as soon as it shows, before any check below: the cleanup covers
  // them all.
  try {
    const created = nextDownloads(page)
    await linkBox(page).fill(YOUTUBE_HANGING_TRACK)
    await linkBox(page).press('Enter')
    const card = trackCard(page, TITLE)
    await expect(card).toContainText('DJ Scraper e2e')
    const {
      jobIds: [jobId = ''],
    } = await created

    // Downloading, with its numbers and a progress bar.
    const status = inlineJob(card)
    await expect(status).toHaveAttribute('data-status', 'downloading')
    await expect(status.getByRole('status')).toHaveText('Downloading')
    await expect(status).toContainText(/12 % · .+\/s · 0:04 left/)
    await expect(card.getByRole('progressbar', { name: 'Download progress' })).toBeVisible()

    // One click cancels: no confirmation.
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(status).toHaveAttribute('data-status', 'canceled')
    await expect(status.getByRole('status')).toHaveText('Canceled')
    await expect(card.getByRole('progressbar')).toHaveCount(0)

    // Retry starts a second attempt of the same job, which hangs again.
    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(status).toHaveAttribute('data-status', 'downloading')
    await expect(status).toContainText(/12 %/)
    const row = jobRow(page, TITLE)
    await expect(row).toHaveAttribute('data-status', 'downloading')
    await expect(row).toContainText(/12 %/)

    // This time from the panel's row, whose button names the track.
    await row.getByRole('button', { name: `Cancel ${TITLE}` }).click()
    await expect(row).toHaveAttribute('data-status', 'canceled')
    await expect(row.getByRole('button', { name: `Retry ${TITLE}` })).toBeVisible()
    await expect(status).toHaveAttribute('data-status', 'canceled')

    const job = (await server.downloads()).jobs.find((candidate) => candidate.id === jobId)
    expect(job).toMatchObject({ status: 'canceled', attempt: 2 })
    // Nothing reached the folder.
    expect(await readdir(downloadFolder)).toEqual([])
  } finally {
    // Never leave it hanging into the next test, whatever failed above, even before the job's id
    // was known (fixtures.ts also cancels what an earlier test left at work).
    for (const job of (await server.downloads()).jobs) {
      if (job.track.title === TITLE && !isTerminalStatus(job.status)) {
        await request.post(`/api/downloads/${job.id}/cancel`, { data: {} })
      }
    }
  }
})
