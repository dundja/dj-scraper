import { readdir } from 'node:fs/promises'
import { PreviewRequestSchema } from '@dj-scraper/shared'
import type { Page } from '@playwright/test'
import { linkBox, nextDownloads } from './app.ts'
import { YOUTUBE_MIX } from './fake-urls.ts'
import { expect, failedLoad, test } from './fixtures.ts'

// Playing a remix in the app (ADR-029, ADR-031): a row's Play button, and the now-playing bar that
// holds the one player: play/pause, the seek bar, the speed grid (in one row on a wide window, in a
// popover on a narrow one), Keep pitch, Download and Close. The recorded searches give the rows
// (fake-urls.ts). The audio is a real, tiny WAV
// served here by page.route, with range answers: the fake engine's preview bytes carry a header
// and filler, which no browser can decode, so playback itself needs a file it can play. The
// server's own route is tested by the server's suites.

const KRYSIEK = 'Rick Astley - Never Gonna Give You Up (Krysiek Remix)'
const TIMMO = 'Rick Astley - Never Gonna Give You Up (Timmo Hendriks Remix)'
/** A SoundCloud upload the fake engine downloads: the bar's Download spends no YouTube pacing. */
const KRYPTONIK = 'Rick Astley - Never Gonna Give You Up (Kryptonik Remix) [Electro House]'
const SECONDS = 20

/** SECONDS of silence as a mono 8 kHz 16-bit WAV. */
function silence(): Buffer {
  const data = 8000 * 2 * SECONDS
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data, 40)
  return Buffer.concat([header, Buffer.alloc(data)])
}

type Preparing = {
  delayMs?: number
  /** The answer to the first `failures` requests (all of them when undefined). */
  failWith?: { status: number; code: string; message: string }
  failures?: number
}

/** Answers POST /api/previews and the audio GET (with ranges, as the server does). */
async function fakePreviews(page: Page, options: Preparing = {}) {
  const wav = silence()
  const posted: unknown[] = []
  await page.route('**/api/previews', async (route) => {
    posted.push(PreviewRequestSchema.parse(route.request().postDataJSON()))
    if (options.delayMs !== undefined) await new Promise((r) => setTimeout(r, options.delayMs))
    const failure = options.failWith
    if (failure !== undefined && posted.length <= (options.failures ?? Number.POSITIVE_INFINITY)) {
      await route.fulfill({
        status: failure.status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: failure.code, message: failure.message } }),
      })
      return
    }
    const n = posted.length.toString(16).padStart(32, '0')
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: n,
        src: `/api/previews/${n}`,
        mime: 'audio/wav',
        sizeBytes: wav.length,
      }),
    })
  })
  await page.route(/\/api\/previews\/[0-9a-f]{32}$/, async (route) => {
    const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : wav.length - 1
    const body = wav.subarray(start, end + 1)
    await route.fulfill({
      status: match ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(body.length),
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
      },
      body,
    })
  })
  return posted
}

/** Opens the mix's seed track alone, so its 20 remixes list under the card. */
async function openRemixes(page: Page) {
  await page.goto('/')
  await linkBox(page).fill(YOUTUBE_MIX)
  await linkBox(page).press('Enter')
  await page.getByRole('button', { name: 'This track' }).click()
  await expect(page.getByRole('list', { name: 'Remixes' }).getByRole('listitem')).toHaveCount(20)
}

const row = (page: Page, title: string) =>
  page.getByRole('list', { name: 'Remixes' }).getByRole('listitem', { name: title })
const play = (page: Page, title: string) => page.getByRole('button', { name: `Play ${title}` })
const pause = (page: Page, title: string) => page.getByRole('button', { name: `Pause ${title}` })
const bar = (page: Page) => page.getByRole('region', { name: 'Now playing' })
/** What the player says: "Preparing audio…", "Playing. Preview: YouTube stream". */
const said = (page: Page) => page.locator('[data-slot="now-playing-status"]')
type AudioField = 'currentTime' | 'playbackRate' | 'preservesPitch' | 'paused'
/** A field of the one player's element. */
const audio = (page: Page, field: AudioField) =>
  page.evaluate(
    (name) => document.querySelector<HTMLAudioElement>('[data-slot="preview-audio"]')?.[name],
    field,
  )

test.describe('on a wide window', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a remix plays in the bar: seek, speed grid, keep pitch; one at a time', async ({
    page,
  }) => {
    const posted = await fakePreviews(page, { delayMs: 300 })
    await openRemixes(page)
    await expect(bar(page)).toHaveCount(0)

    await play(page, KRYSIEK).click()
    await expect(said(page)).toHaveText('Preparing audio…')
    await expect(pause(page, KRYSIEK)).toBeVisible()
    expect(posted).toEqual([
      expect.objectContaining({ id: expect.any(String), url: expect.stringContaining('http') }),
    ])
    // The playing row is the one raised row; the bar names what plays, and says it's a preview.
    await expect(row(page, KRYSIEK)).toHaveAttribute('data-preview', 'playing')
    await expect(row(page, TIMMO)).toHaveAttribute('data-preview', 'idle')
    // What tells the version apart, as its row says it; the whole title in its tooltip.
    await expect(bar(page).getByTitle(KRYSIEK)).toHaveText('Krysiek Remix')
    await expect(bar(page)).toContainText('Remix by Krysiek')
    await expect(said(page)).toHaveText('Playing. Preview: YouTube stream')

    // Time moves; the seek bar reaches the file's length.
    const seek = bar(page).getByRole('slider', { name: 'Seek' })
    await expect(seek).toHaveAttribute('max', String(SECONDS))
    await expect.poll(() => seek.inputValue()).not.toBe('0')
    await seek.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => audio(page, 'currentTime')).toBeGreaterThanOrEqual(3)

    // Speed: a preset, then a nudge off it and back, then Reset.
    await bar(page).getByRole('button', { name: '1.25x' }).click()
    await expect(bar(page).getByRole('button', { name: '1.25x' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await audio(page, 'playbackRate')).toBe(1.25)
    await bar(page).getByRole('button', { name: 'Faster by 0.01x' }).click()
    await expect(bar(page).getByLabel('Current speed')).toHaveText('1.26x')
    await expect(bar(page).getByRole('button', { pressed: true })).toHaveCount(0)
    expect(await audio(page, 'playbackRate')).toBe(1.26)
    await bar(page).getByRole('button', { name: 'Slower by 0.01x' }).click()
    await expect(bar(page).getByLabel('Current speed')).toHaveText('1.25x')
    await bar(page).getByRole('button', { name: 'Reset to 1x' }).click()
    expect(await audio(page, 'playbackRate')).toBe(1)

    // Keep pitch is on, bound to the element, and can be turned off.
    const lock = bar(page).getByRole('switch', { name: 'Keep pitch' })
    await expect(lock).toBeChecked()
    expect(await audio(page, 'preservesPitch')).toBe(true)
    await lock.click()
    expect(await audio(page, 'preservesPitch')).toBe(false)

    // The speed is the session's: another row starts at it, and takes over the bar.
    await bar(page).getByRole('button', { name: '0.9x' }).click()
    await play(page, TIMMO).click()
    await expect(pause(page, TIMMO)).toBeVisible()
    await expect(play(page, KRYSIEK)).toBeVisible()
    await expect(row(page, KRYSIEK)).toHaveAttribute('data-preview', 'idle')
    await expect(bar(page).getByTitle(TIMMO)).toHaveText('Timmo Hendriks Remix')
    await expect(bar(page).getByLabel('Current speed')).toHaveText('0.90x')
    expect(await audio(page, 'playbackRate')).toBe(0.9)
    await expect(bar(page).getByRole('switch', { name: 'Keep pitch' })).not.toBeChecked()

    // Pause and resume, from the bar and from the row.
    await bar(page).getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(said(page)).toHaveText(/^Paused\./)
    await expect(row(page, TIMMO)).toHaveAttribute('data-preview', 'paused')
    await play(page, TIMMO).click()
    await expect(said(page)).toHaveText(/^Playing\./)

    // Close: the audio stops, the bar goes, the focus goes back to the row's button.
    await bar(page).getByRole('button', { name: 'Close player' }).click()
    await expect(bar(page)).toHaveCount(0)
    await expect(play(page, TIMMO)).toBeFocused()
    expect(await audio(page, 'paused')).toBe(true)
  })

  test("the bar's Download queues the playing upload as the row's job", async ({
    page,
    downloadFolder,
  }) => {
    await fakePreviews(page)
    await openRemixes(page)

    await play(page, KRYPTONIK).click()
    await expect(said(page)).toHaveText('Playing. Preview: SoundCloud stream')
    const created = nextDownloads(page)
    await bar(page).getByRole('button', { name: 'Download playing remix' }).click()

    expect((await created).jobIds).toHaveLength(1)
    await expect(row(page, KRYPTONIK)).toContainText('Download: Done', { timeout: 10_000 })
    await expect(bar(page)).toContainText('Download: Done')
    expect(await readdir(downloadFolder)).toEqual([
      expect.stringMatching(/Kryptonik Remix.*\.mp3$/),
    ])
  })

  test('a click while the audio is being prepared cancels it', async ({ page }) => {
    await fakePreviews(page, { delayMs: 5000 })
    await openRemixes(page)

    await play(page, KRYSIEK).click()
    await expect(said(page)).toHaveText('Preparing audio…')
    await bar(page).getByRole('button', { name: 'Cancel preparing' }).click()

    await expect(bar(page)).toHaveCount(0)
    await expect(play(page, KRYSIEK)).toBeVisible()
    await expect(row(page, KRYSIEK)).toHaveAttribute('data-preview', 'idle')
  })

  test('a failed preparation says why in the bar, with a hint, and Try again plays', async ({
    page,
    expectConsoleError,
  }) => {
    await fakePreviews(page, {
      failWith: { status: 429, code: 'rate_limited', message: 'YouTube is limiting requests.' },
      failures: 1,
    })
    expectConsoleError(failedLoad(429, '/api/previews'))
    await openRemixes(page)

    await play(page, KRYSIEK).click()

    const alert = bar(page).getByRole('alert')
    await expect(alert).toContainText('YouTube is limiting requests.')
    await expect(alert).toContainText('Limits usually lift within a few minutes')
    await expect(row(page, KRYSIEK)).toHaveAttribute('data-preview', 'error')
    await alert.getByRole('button', { name: 'Try again' }).click()
    await expect(said(page)).toHaveText(/^Playing\./)
    await expect(pause(page, KRYSIEK)).toBeVisible()
  })

  test('a new paste stops the audio and takes the bar away', async ({ page }) => {
    await fakePreviews(page)
    await openRemixes(page)
    await play(page, KRYSIEK).click()
    await expect(said(page)).toHaveText(/^Playing\./)

    await linkBox(page).fill(YOUTUBE_MIX)
    await linkBox(page).press('Enter')

    await expect(bar(page)).toHaveCount(0)
    expect(await audio(page, 'paused')).toBe(true)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the bar fits, sits below the page, and keeps the speed grid in a popover', async ({
    page,
  }) => {
    await fakePreviews(page)
    await openRemixes(page)
    await play(page, KRYSIEK).click()
    await expect(said(page)).toHaveText(/^Playing\./)

    // Nothing runs off the side, and the bar sits at the window's bottom.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    const box = await bar(page).boundingBox()
    expect(box === null ? 0 : Math.round(box.y + box.height)).toBe(844)
    // At the page's end, the last row shows above the bar: it covers nothing.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const last = await page.getByRole('complementary', { name: 'Downloads' }).boundingBox()
    const barNow = await bar(page).boundingBox()
    expect(Math.round(last === null ? 0 : last.y + last.height)).toBeLessThanOrEqual(
      Math.round(barNow?.y ?? 0),
    )

    await bar(page)
      .getByRole('button', { name: /^Playback speed, 1\.00x/ })
      .click()
    const speed = page.getByRole('slider', { name: 'Speed' })
    await speed.focus()
    await page.keyboard.press('ArrowRight')
    await expect(bar(page).getByRole('button', { name: /^Playback speed, 1\.01x/ })).toBeVisible()
    expect(await audio(page, 'playbackRate')).toBe(1.01)
    await page.getByRole('button', { name: '1.5x' }).click()
    expect(await audio(page, 'playbackRate')).toBe(1.5)
  })
})
