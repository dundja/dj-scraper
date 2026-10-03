import { ResolveRequestSchema } from '@dj-scraper/shared'
import type { Page, Request } from '@playwright/test'
import { linkBox, nextPost, trackCard } from './app.ts'
import { YOUTUBE_MIX, YOUTUBE_PRIVATE_IN_PLAYLIST, YOUTUBE_WATCH_LIST } from './fake-urls.ts'
import { expect, failedLoad, test } from './fixtures.ts'

// `watch?v=…&list=…` links: the track, or its list? Nothing here downloads.

const tracks = (page: Page) => page.getByRole('table', { name: 'Tracks' })

/** What a resolve request asked for. */
const asked = (request: Request) => ResolveRequestSchema.parse(request.postDataJSON())

/** Loads `url` as typed: fill the box, then Enter. */
async function load(page: Page, url: string) {
  await linkBox(page).fill(url)
  await linkBox(page).press('Enter')
}

test('a track in a playlist asks first: This track shows its card at once, Whole playlist lists the playlist', async ({
  page,
  settings,
}) => {
  // The card shows a Download button instead of downloading: no YouTube download from this spec.
  await settings.set({ autoDownloadSingles: false })
  const resolves: Request[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/resolve') resolves.push(request)
  })
  await page.goto('/')
  await linkBox(page).fill(YOUTUBE_WATCH_LIST)
  await expect(linkBox(page)).toHaveAccessibleDescription(/YouTube.*Track in a playlist/)
  await linkBox(page).press('Enter')

  const prompt = page.getByRole('region', { name: 'This track or the whole playlist?' })
  await expect(prompt).toContainText('The link opens a track inside a playlist.')
  await expect(prompt).toContainText('dlp test video title primary (en-GB)')
  await expect(prompt).toContainText('cole-dlp-test-acc')
  // Auto mode: the server looked up the track only, and offers the list.
  expect(resolves.map(asked)).toEqual([{ url: YOUTUBE_WATCH_LIST, mode: 'auto' }])

  // The track is already in the answer: its card shows without a second lookup.
  await prompt.getByRole('button', { name: 'This track' }).click()
  const card = trackCard(page, 'dlp test video title primary (en-GB)')
  await expect(card.getByRole('button', { name: 'Download' })).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect(resolves).toHaveLength(1)

  // The same link again, and the other choice: the whole list.
  await load(page, YOUTUBE_WATCH_LIST)
  await expect(prompt.getByRole('button', { name: 'Whole playlist' })).toBeVisible()
  const listed = nextPost(page, '/api/resolve')
  await prompt.getByRole('button', { name: 'Whole playlist' }).click()
  expect(asked((await listed).request())).toMatchObject({ mode: 'collection' })
  await expect(page.getByRole('heading', { name: 'dlp test playlist' })).toBeVisible()
  await expect(
    tracks(page).getByRole('checkbox', { name: 'Select dlp test video title translated (en)' }),
  ).toBeChecked()
  await expect(page.getByRole('button', { name: 'Download 1 track' })).toBeEnabled()
})

test('a track in a mix defaults to the track, and the mix loads only its first 50 tracks', async ({
  page,
}) => {
  await page.goto('/')
  await load(page, YOUTUBE_MIX)

  const prompt = page.getByRole('region', { name: 'This track or the mix?' })
  await expect(prompt).toContainText('which never ends: loading it lists the first 50 tracks')
  await expect(prompt).toContainText('Never Gonna Give You Up (Official Video) (4K Remaster)')
  // A mix never ends, so the track is the default, focused for Enter.
  await expect(prompt.getByRole('button', { name: 'This track' })).toBeFocused()

  await prompt.getByRole('button', { name: 'Load the mix (first 50)' }).click()
  await expect(tracks(page)).toBeVisible()
  await expect(page.getByText('A mix never ends: showing its first 50 tracks.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download 50 tracks' })).toBeVisible()
})

test('when the track of a playlist link is private, the playlist itself still opens', async ({
  page,
  expectConsoleError,
}) => {
  // The track lookup answers 422, which the browser logs.
  expectConsoleError(failedLoad(422, '/api/resolve'))
  await page.goto('/')
  await load(page, YOUTUBE_PRIVATE_IN_PLAYLIST)

  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Private video.')
  await expect(alert).toContainText('The playlist itself may still load.')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  const opened = nextPost(page, '/api/resolve')
  await page.getByRole('button', { name: 'Open the playlist' }).click()
  const request = asked((await opened).request())
  expect(request.mode).toBe('collection')
  expect(request.url).toContain('bM7SZ5SBzyY')

  await expect(page.getByRole('heading', { name: 'dlp test playlist' })).toBeVisible()
  await expect(
    tracks(page).getByRole('checkbox', { name: 'Select dlp test video title translated (en)' }),
  ).toBeChecked()
  await expect(alert).toHaveCount(0)
})
