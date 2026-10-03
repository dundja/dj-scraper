import type { Locator, Page } from '@playwright/test'
import { linkBox, nextPost } from './app.ts'
import { SOUNDCLOUD_SET } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// "The Royal Concept EP" (fake-urls.ts): a SoundCloud set listed with ids only. The page looks the
// rows in view up (POST /api/resolve/entries), 4 rows per request and two requests at once (rows
// 1–4 and rows 5–6), each answered when all its rows are. The server paces SoundCloud lookups,
// so all 6 are known after about 5 s: row 1 is a Go+ preview, row 6 "Knocked Up", rows 2–5 fail
// to load.

/** SoundCloud's lookup pacing for 6 rows, with room: the slower request answers after about 5 s. */
const LOOKUPS_MS = 15_000

const table = (page: Page): Locator => page.getByRole('table', { name: 'Tracks' })
const checkbox = (page: Page, name: string): Locator =>
  table(page).getByRole('checkbox', { name: `Select ${name}` })
/** The row whose checkbox is named `Select <name>` (`has` locators are relative to the row). */
const row = (page: Page, name: string): Locator =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `Select ${name}` }) })

test('a SoundCloud set fills its rows in as they load: titles, a Go+ preview that cannot be picked, rows that failed', async ({
  page,
}) => {
  await page.goto('/')
  const lookups = nextPost(page, '/api/resolve/entries')
  await linkBox(page).fill(SOUNDCLOUD_SET)
  await linkBox(page).press('Enter')

  await expect(page.getByRole('heading', { name: 'The Royal Concept EP' })).toBeVisible()
  // At first the set gives ids only: each row is "row N", loading, and selected.
  for (let n = 1; n <= 6; n++) await expect(checkbox(page, `row ${n}`)).toBeChecked()
  await expect(table(page).getByText('Loading details…')).toHaveCount(6)
  await expect(page.getByRole('status').filter({ hasText: /selected/ })).toHaveText(/^6 selected/)

  // One of the two lookup requests has answered; each row below waits for its own.
  const answered = await lookups
  expect(answered.ok()).toBe(true)

  // Row 6: its title, artist and length.
  await expect(checkbox(page, 'Knocked Up')).toBeChecked({ timeout: LOOKUPS_MS })
  await expect(row(page, 'Knocked Up')).toContainText('The Royal Concept')
  await expect(row(page, 'Knocked Up')).toContainText('3:42')

  // Row 1: a Go+ preview, so it says why and can't be selected; it left the selection.
  const preview = checkbox(page, 'World On Fire (Re-Mastered)')
  await expect(preview).toBeDisabled({ timeout: LOOKUPS_MS })
  await expect(preview).not.toBeChecked()
  await expect(row(page, 'World On Fire (Re-Mastered)')).toContainText('Preview only (Go+)')
  await preview.click({ force: true })
  await expect(preview).not.toBeChecked()

  // Rows 2–5: no details, but still downloadable.
  for (let n = 2; n <= 5; n++) {
    await expect(row(page, `row ${n}`)).toContainText("Couldn't load details")
    await expect(checkbox(page, `row ${n}`)).toBeChecked()
    await expect(checkbox(page, `row ${n}`)).toBeEnabled()
  }
  await expect(table(page).getByText('Loading details…')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: /selected/ })).toHaveText(/^5 selected/)
  await expect(page.getByRole('button', { name: 'Download 5 tracks' })).toBeEnabled()
})
