import { type CreateDownloadsResponse, CreateDownloadsResponseSchema } from '@dj-scraper/shared'
import type { Locator, Page, Response } from '@playwright/test'

// Locators and actions shared by the specs, by role and accessible name as a user finds them.

/** The paste box at the top of the page. */
export const linkBox = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'YouTube or SoundCloud link' })

/** The heading of the empty state under the paste box: nothing loaded (or loading) yet. */
export const emptyState = (page: Page): Locator =>
  page.getByRole('heading', { name: 'Paste a YouTube or SoundCloud link' })

/** The downloads column: `<aside aria-label="Downloads">`. */
export const downloadsPanel = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Downloads' })

/** A job's row in the downloads panel, by its title; `data-status` holds the job's status. */
export const jobRow = (page: Page, title: string | RegExp): Locator =>
  downloadsPanel(page).locator('[data-slot="job-row"]').filter({ hasText: title })

/** A resolved single track: the card is an article named by its title. */
export const trackCard = (page: Page, title: string | RegExp): Locator =>
  page.getByRole('article', { name: title })

/** The job status inside a track card; `data-status` holds the job's status once it is known. */
export const inlineJob = (card: Locator): Locator => card.locator('[data-slot="job-inline"]')

/**
 * Pastes `text` the way Edit › Paste does with the focus outside any text field: a `paste` event on
 * the body, carrying the text as text/plain, with no key pressed. The page's paste-anywhere
 * listener takes it from there. ⌘V itself has its own spec (single-track.spec.ts).
 */
export async function pasteAnywhere(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(event)
  }, text)
}

const isPost = (response: Response, pathname: string) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === pathname

/** The next answer to POST `pathname`, e.g. '/api/resolve'. Start waiting before the action. */
export const nextPost = (page: Page, pathname: string): Promise<Response> =>
  page.waitForResponse((response) => isPost(response, pathname))

/** The job ids of the next POST /api/downloads. Start waiting before the action. */
export async function nextDownloads(page: Page): Promise<CreateDownloadsResponse> {
  const response = await nextPost(page, '/api/downloads')
  return CreateDownloadsResponseSchema.parse(await response.json())
}
