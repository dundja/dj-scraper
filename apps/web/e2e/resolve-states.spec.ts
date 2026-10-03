import type { Page, Request } from '@playwright/test'
import { emptyState, linkBox } from './app.ts'
import {
  SPOTIFY_TRACK,
  YOUTUBE_BOT_CHECK,
  YOUTUBE_PRIVATE,
  YOUTUBE_SLOW_PLAYLIST,
} from './fake-urls.ts'
import { expect, failedLoad, test } from './fixtures.ts'

// What the page shows while a link loads, when it fails, and when it is refused without loading.

/** Every POST /api/resolve the page sends from now on. */
function resolveRequests(page: Page): Request[] {
  const requests: Request[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/resolve') requests.push(request)
  })
  return requests
}

async function load(page: Page, url: string) {
  await linkBox(page).fill(url)
  await linkBox(page).press('Enter')
}

test('a private video says so in an alert, and Try again asks the server again', async ({
  page,
  expectConsoleError,
}) => {
  expectConsoleError(failedLoad(422, '/api/resolve'))
  const requests = resolveRequests(page)
  await page.goto('/')
  await load(page, YOUTUBE_PRIVATE)

  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('Private video.')
  // A plain video link has no list to fall back to.
  await expect(page.getByRole('button', { name: /^Open the / })).toHaveCount(0)
  expect(requests).toHaveLength(1)

  await page.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => requests.length).toBe(2)
  await expect(alert).toHaveText('Private video.')
  // The button went away and came back: the focus waits in the link box.
  await expect(linkBox(page)).toBeFocused()
})

test('a bot check says what to do about it, with the command as code', async ({
  page,
  expectConsoleError,
}) => {
  expectConsoleError(failedLoad(422, '/api/resolve'))
  await page.goto('/')
  await load(page, YOUTUBE_BOT_CHECK)

  const alert = page.getByRole('alert')
  await expect(alert).toContainText(
    "YouTube wants to check that you're not a bot. Try again later.",
  )
  await expect(alert).toContainText('Updating yt-dlp usually fixes this')
  await expect(alert.locator('code')).toHaveText('brew upgrade yt-dlp')
})

test('a DRM service is refused as it is typed, without asking the server', async ({ page }) => {
  const requests = resolveRequests(page)
  await page.goto('/')
  await linkBox(page).fill(SPOTIFY_TRACK)
  await expect(linkBox(page)).toHaveAccessibleDescription(/DRM service: not supported/)
  await expect(page.getByText(/DRM-protected, so DJ Scraper can't download them/)).toBeVisible()

  await linkBox(page).press('Enter')
  await expect(linkBox(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(emptyState(page)).toBeVisible()
  expect(requests).toEqual([])
})

test('a slow list shows its loading state with the seconds and why, and Cancel goes back to the start', async ({
  page,
}) => {
  await page.goto('/')
  await load(page, YOUTUBE_SLOW_PLAYLIST)

  const status = page.getByRole('status').filter({ hasText: /^Loading the list…$/ })
  await expect(status).toBeAttached()
  const main = page.getByRole('main')
  await expect(main.locator('[aria-busy="true"]')).toBeVisible()
  // From 3 s on: the seconds so far, and why big lists take a while (a longer wait than the
  // default 5 s, which would leave under 2 s to spare).
  await expect(main.getByText(/^\d+ s$/)).toBeVisible({ timeout: 10_000 })
  await expect(
    main.getByText('Big lists take a while: 1,800 videos ≈ 20 s, 5,000 ≈ 1 min.'),
  ).toBeVisible()

  // Cancel closes the request (the server then stops yt-dlp) and shows the start again.
  const aborted = page.waitForEvent(
    'requestfailed',
    (request) => new URL(request.url()).pathname === '/api/resolve',
  )
  await main.getByRole('button', { name: 'Cancel' }).click()
  await aborted
  await expect(emptyState(page)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^Canceled\.$/ })).toBeAttached()
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(linkBox(page)).toBeFocused()
  await expect(linkBox(page)).toHaveValue(YOUTUBE_SLOW_PLAYLIST)
})
