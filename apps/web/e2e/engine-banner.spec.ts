import { type Health, HealthSchema } from '@dj-scraper/shared'
import type { Locator, Page } from '@playwright/test'
import { linkBox } from './app.ts'
import { expect, test } from './fixtures.ts'

// The banner under the header, for an engine that can't download (a red alert) or only warns (a
// dismissible note). The e2e engine is always healthy, so these specs change its health on the way
// to the page: the server's real answer, edited.

const chip = (page: Page): Locator => page.getByRole('button', { name: /^Engine status: / })

/**
 * Answers GET /api/health and POST /api/health/recheck with the server's own answer, edited by
 * `edit` (read at each request, so a spec can change it mid-test). Validated against the contract.
 */
async function editHealth(page: Page, edit: () => (health: Health) => Health) {
  await page.route(
    (url) => url.pathname === '/api/health' || url.pathname === '/api/health/recheck',
    async (route) => {
      const response = await route.fetch()
      const health = HealthSchema.parse(await response.json())
      await route.fulfill({ response, json: HealthSchema.parse(edit()(health)) })
    },
  )
}

/** No yt-dlp on PATH, in the server's words (engine/binaries.ts). */
const missingYtdlp = (health: Health): Health => ({
  ...health,
  ok: false,
  ytdlp: {
    status: 'missing',
    message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
  },
})

/** A yt-dlp past the 60 days after which YouTube fixes may be missing: a warning only. */
const staleYtdlp = (health: Health): Health => {
  if (health.ytdlp.status !== 'ok') throw new Error('the e2e engine has a yt-dlp')
  return {
    ...health,
    ytdlp: {
      ...health.ytdlp,
      version: '2026.06.09',
      releaseDate: '2026-06-09',
      ageDays: 116,
      stale: true,
    },
  }
}

const asIs = (health: Health): Health => health

test('a missing yt-dlp shows a red banner with the install command, and Check again clears it once installed', async ({
  page,
}) => {
  let edit = missingYtdlp
  await editHealth(page, () => edit)
  await page.goto('/')

  const banner = page.getByRole('alert', { name: "Downloads won't work until the engine is fixed" })
  await expect(banner).toBeVisible()
  await expect(banner.getByRole('list', { name: 'Problems' })).toHaveText(
    'Problem: yt-dlp is not on PATH. Run brew install yt-dlp or set YTDLP_PATH.',
  )
  await expect(banner.locator('code')).toHaveText(['brew install yt-dlp'])
  await expect(chip(page)).toHaveAccessibleName('Engine status: Engine needs attention')

  // After installing it, Check again asks the server to look again.
  edit = asIs
  const recheck = page.waitForRequest((request) => request.url().endsWith('/api/health/recheck'))
  await banner.getByRole('button', { name: 'Check again' }).click()
  expect((await recheck).method()).toBe('POST')
  await expect(banner).toHaveCount(0)
  await expect(chip(page)).toHaveAccessibleName('Engine status: Engine ready')
})

test('a stale yt-dlp warns without blocking, and the warning stays dismissed for the session', async ({
  page,
}) => {
  await editHealth(page, () => staleYtdlp)
  await page.goto('/')

  const banner = page.getByRole('status', { name: 'Engine warning' })
  await expect(banner).toContainText(
    'yt-dlp 2026.06.09 is 116 days old (over 60). If YouTube fails, run brew upgrade yt-dlp or point YTDLP_PATH at a nightly build.',
  )
  await expect(banner.locator('code')).toHaveText(['brew upgrade yt-dlp'])
  await expect(chip(page)).toHaveAccessibleName('Engine status: Engine ready, 1 warning')
  // Not an alert: downloads still work, and the page is usable.
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(linkBox(page)).toBeEnabled()

  await banner.getByRole('button', { name: 'Dismiss for this session' }).click()
  await expect(banner).toHaveCount(0)

  // A reload in the same session keeps it dismissed; the chip still says there is a warning.
  await page.reload()
  await expect(chip(page)).toHaveAccessibleName('Engine status: Engine ready, 1 warning')
  await expect(page.getByRole('status', { name: 'Engine warning' })).toHaveCount(0)
})
