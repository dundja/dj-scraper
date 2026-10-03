import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { downloadsPanel, jobRow, linkBox, nextDownloads } from './app.ts'
import { YOUTUBE_PLAYLIST } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// The YouTube playlist "The Memes Of 2010s....." (fake-urls.ts): 23 rows of its 162, rows 2 and 13
// private and row 22 deleted, so 20 can be selected. Its downloads are YouTube's: this spec queues
// 3 per browser, inside YouTube's burst of 10 per run.
const LIST_TITLE = 'The Memes Of 2010s.....'
const SUBFOLDER = 'The Memes Of 2010s'
const ROW_1 = "Oh God Why! (#NGT2 Asaba Theatre Auditions) | Nigeria's Got Talent"
const ROW_3 = 'Work it Willis'
const ROW_4 = "Call 911 He's Dying!"
const ROW_5 = 'JonTron "WTF"'

const box = (page: Page, title: string): Locator =>
  page.getByRole('table', { name: 'Tracks' }).getByRole('checkbox', { name: `Select ${title}` })

/** The line under the toolbar: "3 selected · 4:56" (only the count is announced). */
const selection = (page: Page): Locator => page.locator('[data-slot="selection-summary"]')

test('picks rows with none, invert, a shift-click range and a filter, then downloads them into a subfolder', async ({
  page,
  downloadFolder,
  server,
}) => {
  await page.goto('/')
  await linkBox(page).fill(YOUTUBE_PLAYLIST)
  await linkBox(page).press('Enter')

  // The header, and every row that can download selected from the start.
  await expect(page.getByRole('heading', { name: LIST_TITLE })).toBeVisible()
  await expect(page.getByText('23 of 162 tracks')).toBeVisible()
  await expect(selection(page)).toHaveText(/^20 selected · /)
  const privateRows = page.getByRole('checkbox', { name: 'Select [Private video]' })
  await expect(privateRows).toHaveCount(2)
  for (const row of await privateRows.all()) {
    await expect(row).toBeDisabled()
    await expect(row).not.toBeChecked()
  }
  const download = page.getByRole('button', { name: /^Download \d+ tracks?$|^Select tracks$/ })
  await expect(download).toHaveText('Download 20 tracks')

  // None, then Invert: every selectable row again, never the private ones.
  await page.getByRole('button', { name: 'Select none' }).click()
  await expect(selection(page)).toHaveText('None selected')
  await expect(download).toHaveText('Select tracks')
  await expect(download).toBeDisabled()
  await page.getByRole('button', { name: 'Invert selection' }).click()
  await expect(selection(page)).toHaveText(/^20 selected · /)

  // Row 1, then shift-click row 4: rows 1 to 4, skipping the private row 2.
  await page.getByRole('button', { name: 'Select none' }).click()
  await box(page, ROW_1).click()
  await box(page, ROW_4).click({ modifiers: ['Shift'] })
  await expect(selection(page)).toHaveText(/^3 selected · /)
  for (const title of [ROW_1, ROW_3, ROW_4]) await expect(box(page, title)).toBeChecked()

  // Deselect row 3.
  await box(page, ROW_3).click()
  await expect(box(page, ROW_3)).not.toBeChecked()
  await expect(selection(page)).toHaveText(/^2 selected · /)

  // A filter (any case) shows only the matching row; selecting it keeps the others selected.
  const filter = page.getByRole('textbox', { name: 'Filter tracks' })
  await filter.fill('jontron')
  await expect(page.getByRole('table', { name: 'Tracks' }).getByRole('checkbox')).toHaveCount(1)
  await box(page, ROW_5).click()
  await expect(selection(page)).toHaveText(/^3 selected · /)
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(filter).toHaveValue('')
  for (const title of [ROW_1, ROW_4, ROW_5]) await expect(box(page, title)).toBeChecked()
  await expect(box(page, ROW_3)).not.toBeChecked()

  // Into a subfolder named after the list, which the server keeps as a setting.
  const subfolder = page.getByRole('switch', { name: `Into a subfolder: ${SUBFOLDER}` })
  await expect(subfolder).not.toBeChecked()
  await subfolder.click()
  await expect(subfolder).toBeChecked()
  await expect.poll(async () => (await server.settings()).playlistSubfolder).toBe(true)

  const created = nextDownloads(page)
  await expect(download).toHaveText('Download 3 tracks')
  await download.click()
  const { jobIds } = await created
  expect(jobIds).toHaveLength(3)
  await expect(page.getByText('Queued 3 tracks — see Downloads.')).toBeVisible()

  // The panel: overall progress while they run (each row takes about 1.6 s in the fake engine),
  // one batch named after the list, its 3 jobs in table order, all done.
  const panel = downloadsPanel(page)
  await expect(panel.getByRole('progressbar', { name: 'Overall progress' })).toBeVisible()
  const list = panel.getByRole('list', { name: 'Downloads by batch' })
  await expect(list.getByRole('heading', { name: LIST_TITLE })).toBeVisible()
  const rows = panel.locator('[data-slot="job-row"]')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText(ROW_1)
  await expect(rows.nth(1)).toContainText(ROW_4)
  await expect(rows.nth(2)).toContainText(ROW_5)
  for (const title of [ROW_1, ROW_4, ROW_5]) {
    await expect(jobRow(page, title)).toHaveAttribute('data-status', 'done')
  }
  await expect(list.getByText('3 of 3 finished')).toBeAttached()
  await expect(panel.locator('[data-slot="downloads-header"]').getByRole('status')).toHaveText(
    '3 done',
  )
  await expect(panel.getByRole('progressbar', { name: 'Overall progress' })).toHaveCount(0)

  // The files are in the subfolder, one per job.
  const folder = path.join(downloadFolder, SUBFOLDER)
  const { jobs } = await server.downloads()
  const ours = jobs.filter((job) => jobIds.includes(job.id))
  const names = ours.map((job) => {
    if (job.status !== 'done') throw new Error(`job ${job.id} is ${job.status}`)
    return path.basename(job.outputPath)
  })
  for (const job of ours) expect(await realpath(job.folder)).toBe(await realpath(folder))
  expect((await readdir(folder)).sort()).toEqual(names.sort())
})

// Below lg the page scrolls under the sticky 48 px header: a row the keyboard brings back into
// view must land below it (scroll-padding on <html>), not under it.
for (const size of [
  { width: 900, height: 700 },
  { width: 375, height: 700 },
]) {
  test(`keeps the focused row clear of the sticky header at ${size.width} px`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.goto('/')
    await linkBox(page).fill(YOUTUBE_PLAYLIST)
    await linkBox(page).press('Enter')
    await expect(selection(page)).toHaveText(/^20 selected · /)

    /** Whether the focused element is what the window shows at its centre (nothing covers it). */
    const focusedInSight = () =>
      page.evaluate(() => {
        const focused = document.activeElement
        if (!(focused instanceof HTMLElement)) return 'nothing focused'
        const box = focused.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        if (hit !== null && (hit === focused || focused.contains(hit))) return 'in sight'
        return hit?.closest('header') !== null ? 'under the header' : `under ${hit?.tagName}`
      })

    /** The checkbox of the row at `position` among the shown rows (0-based). */
    const rowAt = (position: number) =>
      page.locator(`[data-position="${position}"] [role="checkbox"]`)

    await box(page, ROW_1).focus()
    for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowDown')
    await expect(rowAt(10)).toBeFocused()
    expect(await focusedInSight()).toBe('in sight')
    await page.keyboard.press('End')
    await expect(rowAt(22)).toBeFocused()
    expect(await focusedInSight()).toBe('in sight')

    // Scroll the page past the table's top, then jump back to the first row.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await page.keyboard.press('Home')
    await expect(rowAt(0)).toBeFocused()
    expect(await focusedInSight()).toBe('in sight')
  })
}
