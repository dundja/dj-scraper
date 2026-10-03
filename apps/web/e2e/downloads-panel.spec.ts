import type { Page } from '@playwright/test'
import { downloadsPanel, inlineJob, jobRow, linkBox, trackCard } from './app.ts'
import { SOUNDCLOUD_TRACK } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// The panel's bulk actions over every job. SoundCloud's short track, so it costs no YouTube pacing.
const TITLE = /^Dl Test Video/

async function load(page: Page, url: string) {
  await linkBox(page).fill(url)
  await linkBox(page).press('Enter')
}

test('Clear finished empties the finished jobs, done and skipped, from the panel and the server', async ({
  page,
  server,
  downloadFolder: _ownFolder,
}) => {
  await page.goto('/')
  const panel = downloadsPanel(page)
  // Every test starts without earlier finished jobs (fixtures.ts), and none still running.
  await expect(panel.getByText('Nothing downloading yet')).toBeVisible()

  // Two finished jobs: the track, then the same track again, which finds its file there.
  await load(page, SOUNDCLOUD_TRACK)
  await expect(inlineJob(trackCard(page, TITLE))).toHaveAttribute('data-status', 'done')
  await load(page, SOUNDCLOUD_TRACK)
  const card = trackCard(page, TITLE)
  await expect(inlineJob(card)).toHaveAttribute('data-status', 'skipped')
  await expect(inlineJob(card)).toContainText('Already in the folder')
  const rows = panel.locator('[data-slot="job-row"]')
  await expect(rows).toHaveCount(2)
  await expect(jobRow(page, TITLE).nth(0)).toHaveAttribute('data-status', 'skipped')
  await expect(jobRow(page, TITLE).nth(1)).toHaveAttribute('data-status', 'done')
  const counts = panel.locator('[data-slot="downloads-header"]').getByRole('status')
  await expect(counts).toHaveText('1 done · 1 skipped')

  // Only what applies is offered: nothing failed, nothing to cancel.
  await panel.getByRole('button', { name: 'Actions for all downloads' }).click()
  await expect(page.getByRole('menuitem', { name: 'Retry failed' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Cancel all' })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Clear finished' }).click()

  await expect(rows).toHaveCount(0)
  await expect(panel.getByText('Nothing downloading yet')).toBeVisible()
  // The live region stays, empty, so the next count is announced.
  await expect(counts).toHaveText('')
  expect((await server.downloads()).jobs).toEqual([])
  // The card still on the page says its job left the list, and offers to download it again.
  await expect(inlineJob(card)).toContainText('No longer in the downloads list')
  await expect(card.getByRole('button', { name: 'Download again' })).toBeVisible()
})
