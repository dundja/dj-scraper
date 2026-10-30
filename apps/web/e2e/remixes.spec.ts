import { readdir } from 'node:fs/promises'
import { RemixRequestSchema } from '@dj-scraper/shared'
import type { Locator, Page } from '@playwright/test'
import { downloadsPanel, jobRow, linkBox, nextDownloads, nextPost, trackCard } from './app.ts'
import { SOUNDCLOUD_TRACK, YOUTUBE_MIX } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// Remix suggestions under a single track's card (ADR-027), on the recorded searches of the mix's
// seed track (fake-urls.ts). The track itself never downloads here (nothing does by itself, ADR-031), and the
// remix downloaded is a SoundCloud upload: this spec spends none of YouTube's pacing.

const MIX_TRACK = 'Never Gonna Give You Up (Official Video) (4K Remaster)'
const KRYPTONIK = 'Rick Astley - Never Gonna Give You Up (Kryptonik Remix) [Electro House]'
const KRYSIEK = 'Rick Astley - Never Gonna Give You Up (Krysiek Remix)'

const section = (page: Page) => page.getByRole('region', { name: /^Remixes/ })
const rows = (page: Page) =>
  section(page).getByRole('list', { name: 'Remixes' }).getByRole('listitem')
/** A row by its upload's whole title, which names it (it shows only what tells it apart). */
const row = (page: Page, title: string) =>
  section(page)
    .getByRole('list', { name: 'Remixes' })
    .getByRole('listitem', { name: title, exact: true })

/** The rows' titles, in order: each row is named by its upload's whole title. */
const titles = (list: Locator) =>
  list.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))

/** Loads `url` as typed: fill the box, then Enter. */
async function load(page: Page, url: string) {
  await linkBox(page).fill(url)
  await linkBox(page).press('Enter')
}

test("a pasted track's remixes show under its card, most played first, and one downloads", async ({
  page,
  downloadFolder,
}) => {
  await page.goto('/')
  await load(page, YOUTUBE_MIX)
  const remixRequests = nextPost(page, '/api/remixes')
  await page.getByRole('button', { name: 'This track' }).click()

  const card = trackCard(page, MIX_TRACK)
  await expect(card).toBeVisible()
  // The web asks for the full answer, and for YouTube's alone first.
  expect(RemixRequestSchema.parse((await remixRequests).request().postDataJSON())).toMatchObject({
    title: MIX_TRACK,
    artist: 'Rick Astley',
    exclude: { platform: 'youtube', id: 'dQw4w9WgXcQ' },
  })
  await expect(section(page).getByRole('button', { name: 'Remixes 20' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(section(page)).toContainText(
    'Remixes of Rick Astley – Never Gonna Give You Up on YouTube and SoundCloud',
  )
  // Below the card.
  const cardBox = await card.boundingBox()
  const sectionBox = await section(page).boundingBox()
  expect(sectionBox?.y).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0) - 1)

  // Most played first: 579K views, then 556K plays, then 539K views.
  await expect(rows(page)).toHaveCount(20)
  expect((await titles(rows(page))).slice(0, 3)).toEqual([
    KRYSIEK,
    'Rick Astley - Never Gonna Give You Up (Timmo Hendriks Remix)',
    'Rick Astley - Never Gonna Give You Up (Stephen Gilham - PHD Extended Mix)',
  ])
  await expect(row(page, KRYSIEK)).toContainText('Remix by Krysiek')
  await expect(row(page, KRYSIEK)).toContainText('YouTube·579K views')
  await expect(rows(page).nth(1)).toContainText('SoundCloud·556K plays')
  // The same remix on both platforms is one row.
  const kaktuz = row(page, 'Rick Astley - Never Gonna Give You Up (KaktuZ Remix)')
  await expect(kaktuz).toContainText('YouTube·67K views')
  await expect(kaktuz).toContainText('SoundCloud·21K plays')
  // A genre SoundCloud's uploader set, and one only the title names (a guess).
  const kryptonik = row(page, KRYPTONIK)
  await expect(kryptonik).toContainText('Remix by Kryptonik')
  const genre = (item: Locator) => item.locator('[data-genre-source]')
  await expect(genre(kryptonik)).toHaveText('Electro House (Genre set on SoundCloud)')
  await expect(genre(kryptonik)).toHaveAttribute('data-genre-source', 'platform')
  const synthwave = genre(row(page, 'Rick Astley - Never Gonna Give You Up (Synthwave Remix)'))
  await expect(synthwave).toHaveText('Synthwave (Genre named in the title or tags)')
  await expect(synthwave).toHaveAttribute('data-genre-source', 'text')

  // The genre filter: All, then each genre with its count.
  const filter = section(page).getByRole('group', { name: 'Filter remixes by genre' })
  await expect(filter.getByRole('button')).toHaveText([
    'All 20',
    'Nu Disco 2',
    'Deep House 1',
    'Drum & Bass 1',
    'Electro House 1',
    'Jersey Club 1',
    'Lo-Fi 1',
    'Synthwave 1',
  ])
  await filter.getByRole('button', { name: 'Nu Disco 2' }).click()
  await expect(filter.getByRole('button', { name: 'Nu Disco 2' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(rows(page)).toHaveCount(2)
  await filter.getByRole('button', { name: 'All 20' }).click()
  await expect(rows(page)).toHaveCount(20)

  // Another upload of a remix uploaded three times: the menu lists them, most played first.
  await row(page, KRYSIEK)
    .getByRole('button', { name: `Choose upload of ${KRYSIEK}` })
    .click()
  const uploads = page.getByRole('menuitem')
  await expect(uploads).toHaveCount(3)
  await expect(uploads.first()).toContainText('YouTube · ')
  await expect(uploads.first()).toContainText('579K views · 3:27')
  await page.keyboard.press('Escape')
  await expect(uploads).toHaveCount(0)

  // Download: one item, the row follows its job to the end.
  const created = nextDownloads(page)
  await kryptonik.getByRole('button', { name: `Download ${KRYPTONIK}` }).click()
  expect((await created).jobIds).toHaveLength(1)
  await expect(kryptonik).toContainText('Download: Done', { timeout: 10_000 })
  // The panel: a batch named after the upload's title, the job with the names the download read
  // (artist split from the title).
  await expect(downloadsPanel(page).getByRole('heading', { name: KRYPTONIK })).toBeVisible()
  const job = jobRow(
    page,
    'Never Gonna Give You Up (Kryptonik Remix) [Electro House] · Rick Astley',
  )
  await expect(job).toHaveAttribute('data-status', 'done')
  // Only the remix: the pasted track itself didn't download.
  await expect(jobRow(page, MIX_TRACK)).toHaveCount(0)
  expect(await readdir(downloadFolder)).toEqual([expect.stringMatching(/Kryptonik Remix.*\.mp3$/)])
})

test('a platform whose remix search failed says so, and Try again searches again', async ({
  page,
}) => {
  await page.goto('/')
  await load(page, SOUNDCLOUD_TRACK)
  await expect(trackCard(page, /^Dl Test Video/)).toBeVisible()

  // The e2e server has an empty YouTube search for this track and none for SoundCloud's.
  await expect(section(page)).toContainText('No remixes found on YouTube.')
  await expect(section(page)).toContainText(/SoundCloud search failed: /)
  await expect(section(page).getByRole('button', { name: 'Remixes 0' })).toBeVisible()

  const retried = nextPost(page, '/api/remixes')
  await section(page).getByRole('button', { name: 'Try again' }).click()
  // The full search again: the server answers YouTube's from its cache.
  const request = RemixRequestSchema.parse((await retried).request().postDataJSON())
  expect(request.platforms).toBeUndefined()
  await expect(section(page)).toContainText(/SoundCloud search failed: /)
  await expect(section(page).getByRole('button', { name: 'Try again' })).toBeEnabled()
})
