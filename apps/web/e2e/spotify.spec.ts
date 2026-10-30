import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  downloadsPanel,
  emptyState,
  inlineJob,
  jobRow,
  linkBox,
  nextDownloads,
  pasteAnywhere,
  trackCard,
} from './app.ts'
import { SPOTIFY_ALBUM, SPOTIFY_PLAYLIST_TRUNCATED, SPOTIFY_TRACK } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

// Spotify links (ADR-026), read from the e2e server's Spotify fixture server: a track list only.
// Each track's audio is matched on YouTube and downloaded from there, so its downloads are paced
// as YouTube's: this spec queues 3 per browser (the track and 2 album rows), inside YouTube's
// burst of 10 per run.

const TITLE = 'Never Gonna Give You Up'
const MATCH_TITLE = 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)'
const MATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
/** MP3 from YouTube's Opus stream, re-encoded: the finished line names the site it came from. */
const FROM_YOUTUBE = /MP3 · 320 kbps · re-encoded from YouTube's Opus \d+ kbps/

/** The badge at the end of the paste box: the platform's name with its brand-colored dot. */
const pasteBadge = (page: Page): Locator =>
  page
    .locator('[data-slot="badge"]')
    .filter({ hasText: /^Spotify$/ })
    .first()

const box = (page: Page, title: string): Locator =>
  page.getByRole('table', { name: 'Tracks' }).getByRole('checkbox', { name: `Select ${title}` })

/** The line under the toolbar: "3 selected · 4:56". */
const selection = (page: Page): Locator => page.locator('[data-slot="selection-summary"]')

test('a pasted Spotify track says where its audio comes from, downloads its YouTube match, and names it', async ({
  page,
  settings,
  downloadFolder,
  server,
}) => {
  await settings.set({ format: 'mp3' })
  await page.goto('/')
  await expect(linkBox(page)).toBeFocused()
  await emptyState(page).click()
  const created = nextDownloads(page)
  await pasteAnywhere(page, SPOTIFY_TRACK)

  // The badge: Spotify, green, a track.
  await expect(linkBox(page)).toHaveValue(SPOTIFY_TRACK)
  await expect(linkBox(page)).toHaveAccessibleDescription(/Spotify.*Track/)
  await expect(pasteBadge(page).locator('.bg-platform-spotify')).toHaveCount(1)

  // The card: why its audio comes from YouTube while the match is found. Download queues it,
  // then it searches YouTube (the e2e search takes 1.5 s).
  const card = trackCard(page, TITLE)
  const note = card.locator('[data-slot="track-match"]')
  await expect(note).toHaveText(
    'Spotify streams are DRM-protected: DJ Scraper finds this track on YouTube and downloads it from there.',
  )
  await card.getByRole('button', { name: 'Download' }).click()
  const status = inlineJob(card)
  await expect(status).toContainText('Finding it on YouTube…')
  const {
    jobIds: [jobId],
  } = await created
  // Spotify's names and length.
  await expect(card).toContainText('Rick Astley')
  await expect(card).toContainText('3:34')

  // The match, linked, so the DJ can check the version; then the finished line names YouTube.
  const link = note.getByRole('link', { name: new RegExp(`^${escapeRegExp(MATCH_TITLE)}`) })
  await expect(link).toHaveAttribute('href', MATCH_URL)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(note).toHaveText(
    `Audio from YouTube: ${MATCH_TITLE} (opens in a new tab) · Rick Astley`,
  )
  await expect(status).toHaveAttribute('data-status', 'done')
  await expect(status).toContainText(FROM_YOUTUBE)
  await expect(card.getByRole('button', { name: 'Download' })).toHaveCount(0)

  // The panel's row: the Spotify title, done, from YouTube.
  const row = jobRow(page, TITLE)
  await expect(row).toHaveAttribute('data-status', 'done')
  await expect(row).toContainText(FROM_YOUTUBE)

  // The file, named with Spotify's names; the job keeps its Spotify link and the match.
  const job = (await server.downloads()).jobs.find((candidate) => candidate.id === jobId)
  if (job?.status !== 'done') throw new Error(`job ${jobId} is ${job?.status ?? 'gone'}`)
  expect(job.track.url).toBe(SPOTIFY_TRACK)
  expect(job.match).toMatchObject({ platform: 'youtube', id: 'dQw4w9WgXcQ', url: MATCH_URL })
  expect(await realpath(path.dirname(job.outputPath))).toBe(await realpath(downloadFolder))
  expect(path.basename(job.outputPath)).toBe('Rick Astley - Never Gonna Give You Up.mp3')
})

test('a Spotify album says where its audio comes from, and downloads the rows picked from YouTube', async ({
  page,
  settings,
  downloadFolder,
  server,
}) => {
  await settings.set({ format: 'mp3', playlistSubfolder: false })
  await page.goto('/')
  await linkBox(page).fill(SPOTIFY_ALBUM)
  await expect(linkBox(page)).toHaveAccessibleDescription(/Spotify.*Album/)
  await linkBox(page).press('Enter')

  // The header and its note; every row complete and selected, no lookups.
  await expect(page.getByRole('heading', { name: 'Whenever You Need Somebody' })).toBeVisible()
  await expect(
    page.getByText(
      'Spotify streams are DRM-protected: each track is found on YouTube and downloaded from there.',
    ),
  ).toBeVisible()
  await expect(selection(page)).toHaveText(/^10 selected · /)
  const download = page.getByRole('button', { name: /^Download \d+ tracks?$|^Select tracks$/ })
  await expect(download).toHaveText('Download 10 tracks')

  // Two rows: the e2e burst of YouTube downloads is shared by the whole run.
  const picked = ['Whenever You Need Somebody', 'Together Forever']
  await page.getByRole('button', { name: 'Select none' }).click()
  await expect(selection(page)).toHaveText('None selected')
  for (const title of picked) await box(page, title).click()
  await expect(selection(page)).toHaveText(/^2 selected · /)

  const created = nextDownloads(page)
  await expect(download).toHaveText('Download 2 tracks')
  await download.click()
  const { jobIds } = await created
  expect(jobIds).toHaveLength(2)

  const panel = downloadsPanel(page)
  await expect(panel.locator('[data-slot="job-row"]')).toHaveCount(2)
  for (const title of picked) {
    const row = jobRow(page, title)
    await expect(row).toHaveAttribute('data-status', 'done')
    await expect(row).toContainText(FROM_YOUTUBE)
  }

  // Each file under its Spotify names, each from its own YouTube match.
  const jobs = (await server.downloads()).jobs.filter((job) => jobIds.includes(job.id))
  const files: string[] = []
  for (const job of jobs) {
    if (job.status !== 'done') throw new Error(`job ${job.id} is ${job.status}`)
    expect(await realpath(path.dirname(job.outputPath))).toBe(await realpath(downloadFolder))
    files.push(path.basename(job.outputPath))
  }
  expect(files.sort()).toEqual(picked.map((title) => `Rick Astley - ${title}.mp3`).sort())
  expect(new Set(jobs.map((job) => job.match?.id)).size).toBe(2)

  // Hide downloaded: the two Done rows leave the table and the selection, their checks kept.
  const hide = page.getByRole('button', { name: 'Hide downloaded (2)' })
  await expect(hide).toHaveAttribute('aria-pressed', 'false')
  await hide.click()
  await expect(hide).toHaveAttribute('aria-pressed', 'true')
  for (const title of picked) await expect(box(page, title)).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Tracks' }).getByRole('checkbox')).toHaveCount(8)
  await expect(selection(page)).toHaveText('None selected')
  await hide.click()
  for (const title of picked) await expect(box(page, title)).toBeChecked()
  await expect(selection(page)).toHaveText(/^2 selected · /)
})

test('a Spotify playlist the page cuts at 100 tracks says so', async ({ page }) => {
  await page.goto('/')
  await linkBox(page).fill(SPOTIFY_PLAYLIST_TRUNCATED)
  await expect(linkBox(page)).toHaveAccessibleDescription(/Spotify.*Playlist/)
  await linkBox(page).press('Enter')

  await expect(page.getByRole('heading', { name: 'All Out 80s' })).toBeVisible()
  await expect(
    page.getByText(
      'Spotify shows only the first 100 tracks of a playlist. To load them all, open it in the Spotify desktop app, select every track (⌘A), copy (⌘C) and paste here.',
    ),
  ).toBeVisible()
  await expect(selection(page)).toHaveText(/^100 selected · /)
})

/** `text` as a literal in a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
