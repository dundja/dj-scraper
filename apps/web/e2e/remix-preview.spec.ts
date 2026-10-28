import { PreviewRequestSchema } from '@dj-scraper/shared'
import type { Page } from '@playwright/test'
import { linkBox } from './app.ts'
import { YOUTUBE_MIX } from './fake-urls.ts'
import { expect, failedLoad, test } from './fixtures.ts'

// Playing a remix in the app (ADR-029): the Play button, the one player, the seek bar and the
// speed grid. The recorded searches give the rows (fake-urls.ts). The audio is a real, tiny WAV
// served here by page.route, with range answers: the fake engine's preview bytes carry a header
// and filler, which no browser can decode, so playback itself needs a file it can play. The
// server's own route is tested by the server's suites.

const KRYSIEK = 'Rick Astley - Never Gonna Give You Up (Krysiek Remix)'
const TIMMO = 'Rick Astley - Never Gonna Give You Up (Timmo Hendriks Remix)'
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

type Preparing = { delayMs?: number; failWith?: { status: number; code: string; message: string } }

/** Answers POST /api/previews and the audio GET (with ranges, as the server does). */
async function fakePreviews(page: Page, options: Preparing = {}) {
  const wav = silence()
  const posted: unknown[] = []
  await page.route('**/api/previews', async (route) => {
    posted.push(PreviewRequestSchema.parse(route.request().postDataJSON()))
    if (options.delayMs !== undefined) await new Promise((r) => setTimeout(r, options.delayMs))
    const failure = options.failWith
    if (failure !== undefined) {
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

const play = (page: Page, title: string) => page.getByRole('button', { name: `Play ${title}` })
const pause = (page: Page, title: string) => page.getByRole('button', { name: `Pause ${title}` })
const strip = (page: Page, title: string) =>
  page.getByRole('region', { name: `Preview of ${title}` })
const rate = (page: Page) =>
  page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('[data-slot="preview-audio"]')
    return audio?.playbackRate
  })

test('a remix plays, seeks, changes speed and keeps pitch; one row at a time', async ({
  page,
  settings,
}) => {
  await settings.set({ autoDownloadSingles: false })
  const posted = await fakePreviews(page, { delayMs: 300 })
  await openRemixes(page)

  await play(page, KRYSIEK).click()
  await expect(strip(page, KRYSIEK).getByText('Preparing audio…')).toBeVisible()
  await expect(pause(page, KRYSIEK)).toBeVisible()
  expect(posted).toEqual([
    expect.objectContaining({ id: expect.any(String), url: expect.stringContaining('http') }),
  ])
  const player = strip(page, KRYSIEK)
  await expect(player).toContainText('Preview: ')
  await expect(player).toContainText('stream')

  // Time moves; the seek bar reaches the file's length.
  const seek = player.getByRole('slider', { name: 'Seek' })
  await expect(seek).toHaveAttribute('max', String(SECONDS))
  await expect.poll(() => seek.inputValue()).not.toBe('0')
  await seek.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector<HTMLAudioElement>('[data-slot="preview-audio"]')?.currentTime ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(3)

  // Speed: a preset, then a nudge off it, then the slider, then Reset.
  await player.getByRole('button', { name: '1.25x' }).click()
  await expect(player.getByRole('button', { name: '1.25x' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await rate(page)).toBe(1.25)
  await player.getByRole('button', { name: 'Faster by 0.01x' }).click()
  await expect(player.getByLabel('Current speed')).toHaveText('1.26x')
  await expect(player.getByRole('button', { pressed: true })).toHaveCount(0)
  expect(await rate(page)).toBe(1.26)
  await player.getByRole('slider', { name: 'Speed' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(player.getByLabel('Current speed')).toHaveText('1.25x')
  await player.getByRole('button', { name: 'Reset to 1x' }).click()
  expect(await rate(page)).toBe(1)

  // Keep pitch is on, bound to the element, and can be turned off.
  const lock = player.getByRole('switch', { name: 'Keep pitch' })
  await expect(lock).toBeChecked()
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLAudioElement>('[data-slot="preview-audio"]')?.preservesPitch,
    ),
  ).toBe(true)
  await lock.click()
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLAudioElement>('[data-slot="preview-audio"]')?.preservesPitch,
    ),
  ).toBe(false)

  // The speed is the session's: another row starts at it, and takes over from the first.
  await player.getByRole('button', { name: '0.9x' }).click()
  await play(page, TIMMO).click()
  await expect(pause(page, TIMMO)).toBeVisible()
  await expect(play(page, KRYSIEK)).toBeVisible()
  await expect(strip(page, KRYSIEK)).toHaveCount(0)
  await expect(strip(page, TIMMO).getByLabel('Current speed')).toHaveText('0.90x')
  expect(await rate(page)).toBe(0.9)
  await expect(strip(page, TIMMO).getByRole('switch', { name: 'Keep pitch' })).not.toBeChecked()

  // Pause and resume.
  await pause(page, TIMMO).click()
  await expect(strip(page, TIMMO)).toContainText('Paused.')
  await play(page, TIMMO).click()
  await expect(strip(page, TIMMO)).toContainText('Playing.')
})

test('a click while the audio is being prepared cancels it', async ({ page, settings }) => {
  await settings.set({ autoDownloadSingles: false })
  await fakePreviews(page, { delayMs: 5000 })
  await openRemixes(page)

  await play(page, KRYSIEK).click()
  await expect(strip(page, KRYSIEK).getByText('Preparing audio…')).toBeVisible()
  await page.getByRole('button', { name: `Cancel preparing ${KRYSIEK}` }).click()

  await expect(strip(page, KRYSIEK)).toHaveCount(0)
  await expect(play(page, KRYSIEK)).toBeVisible()
})

test('a failed preparation says why, with a hint, and offers Try again', async ({
  page,
  settings,
  expectConsoleError,
}) => {
  await settings.set({ autoDownloadSingles: false })
  await fakePreviews(page, {
    failWith: { status: 429, code: 'rate_limited', message: 'YouTube is limiting requests.' },
  })
  expectConsoleError(failedLoad(429, '/api/previews'))
  await openRemixes(page)

  await play(page, KRYSIEK).click()

  const alert = strip(page, KRYSIEK).getByRole('alert')
  await expect(alert).toContainText('YouTube is limiting requests.')
  await expect(alert).toContainText('Limits usually lift within a few minutes')
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
})
