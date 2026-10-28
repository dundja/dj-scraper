import type { Locator, Page } from '@playwright/test'
import { linkBox, nextPost, pasteAnywhere } from './app.ts'
import { SPOTIFY_TRACK, SPOTIFY_TRACK_2, SPOTIFY_TRACK_3 } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// Several Spotify track links pasted at once, as the Spotify desktop app copies a playlist's tracks
// (⌘A, ⌘C): one list whose partial rows fill in from each track's embed page as they come into
// view. Nothing downloads here: YouTube's burst of 10 is shared by the whole run.

const TITLES = ['Never Gonna Give You Up', 'Whenever You Need Somebody', 'Together Forever']

const table = (page: Page): Locator => page.getByRole('table', { name: 'Tracks' })
const row = (page: Page, title: string): Locator =>
  table(page)
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `Select ${title}` }) })

test('Spotify track links pasted at once load as one list whose rows fill in', async ({ page }) => {
  await page.goto('/')
  await expect(linkBox(page)).toBeFocused()
  const resolved = nextPost(page, '/api/resolve/links')
  // Two links and a URI, as different versions of the Spotify app copy them, one per line.
  const id3 = new URL(SPOTIFY_TRACK_3).pathname.split('/').at(-1)
  await pasteAnywhere(
    page,
    `${SPOTIFY_TRACK}\n${SPOTIFY_TRACK_2}?si=0a1b2c3d\nspotify:track:${id3}\n`,
  )

  const request = (await resolved).request()
  expect(request.postDataJSON()).toEqual({
    urls: [SPOTIFY_TRACK, SPOTIFY_TRACK_2, SPOTIFY_TRACK_3],
  })

  // The box holds one link: it is emptied, and says what the paste became.
  await expect(linkBox(page)).toHaveValue('')
  await expect(linkBox(page)).toHaveAccessibleDescription(
    'Pasted 3 Spotify track links: they load as one list.',
  )

  // One list, not a page of its own: no owner, the kind says what it is.
  const list = page.getByRole('region', { name: 'Pasted Spotify tracks' })
  await expect(list.getByRole('heading', { name: 'Pasted Spotify tracks' })).toBeVisible()
  await expect(list.getByText('Pasted links', { exact: true })).toBeVisible()
  await expect(
    list.getByText(
      'Spotify streams are DRM-protected: each track is found on YouTube and downloaded from there.',
    ),
  ).toBeVisible()

  // The rows fill in, in paste order, with Spotify's names and lengths; all selected.
  for (const title of TITLES) await expect(row(page, title)).toHaveCount(1)
  await expect(table(page).getByRole('checkbox', { name: /^Select / })).toHaveCount(3)
  await expect(row(page, TITLES[1] ?? '')).toContainText('Rick Astley')
  await expect(row(page, TITLES[1] ?? '')).toContainText('3:54')
  await expect(row(page, TITLES[2] ?? '')).toContainText('3:26')
  await expect(page.locator('[data-slot="selection-summary"]')).toHaveText(/^3 selected · /)
  await expect(page.getByRole('button', { name: 'Download 3 tracks' })).toBeVisible()
})
