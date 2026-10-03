import { HealthSchema } from '@dj-scraper/shared'
import type { Locator, Page } from '@playwright/test'
import { emptyState, linkBox } from './app.ts'
import { YOUTUBE_PLAYLIST } from './fake-urls.ts'
import { expect, test } from './fixtures.ts'

/** The header chip: the one button whose accessible name starts with "Engine status:". */
const chip = (page: Page): Locator => page.getByRole('button', { name: /^Engine status: / })

/** Opens the popover once the fake engine reports ready; it's a dialog named by its title. */
async function openEnginePopover(page: Page): Promise<Locator> {
  await expect(chip(page)).toHaveAccessibleName('Engine status: Engine ready')
  await chip(page).click()
  const popover = page.getByRole('dialog', { name: 'Engine ready' })
  await expect(popover).toBeVisible()
  return popover
}

const isRecheck = (url: string) => new URL(url).pathname === '/api/health/recheck'

/**
 * The element's box once its animations have ended and it held still for a frame: the popover
 * zooms in from 95% and is positioned asynchronously, so earlier boxes are not where it ends up.
 */
function settledBox(target: Locator) {
  return target.evaluate(async (element) => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    let previous = ''
    for (;;) {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      )
      await nextFrame()
      const { x, y, width, height } = element.getBoundingClientRect()
      const box = JSON.stringify({ x, y, width, height })
      if (box === previous) return { x, y, width, height }
      previous = box
    }
  })
}

/**
 * What a focus indicator can change, read once transitions have ended: the chip transitions all
 * properties, so a read right after focusing could still see the unfocused values.
 */
function focusIndicator(target: Locator) {
  return target.evaluate(async (element) => {
    // getAnimations() flushes pending style changes, so a transition that focus starts is included.
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => {})),
    )
    const style = getComputedStyle(element)
    // Colors in computed styles carry no px, so these are the shadows' offsets, blurs and spreads.
    const shadowPx = [...style.boxShadow.matchAll(/(-?[\d.]+)px/g)].map(([, px]) =>
      Math.abs(Number(px)),
    )
    const outlinePx = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth)
    return {
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      boxShadow: style.boxShadow,
      borderColor: style.borderColor,
      /** How far a ring (box-shadow) or outline reaches; 0 when neither draws anything. */
      ringPx: Math.max(outlinePx, ...shadowPx),
    }
  })
}

/** The longest computed animation or transition duration, in ms. */
function longestMotionMs(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    const durations = `${style.animationDuration}, ${style.transitionDuration}`.split(',')
    return Math.max(
      ...durations.map((duration) => {
        const value = Number.parseFloat(duration)
        return duration.trim().endsWith('ms') ? value : value * 1000
      }),
    )
  })
}

test('loads the shell with the engine ready, and checks the engine again on request', async ({
  page,
}) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  // The server refuses to be framed, like the dev server, so no site can click through the app.
  expect(await response?.headerValue('x-frame-options')).toBe('DENY')
  expect(await response?.headerValue('content-security-policy')).toContain("frame-ancestors 'none'")

  await expect(page).toHaveTitle('DJ Scraper')
  await expect(page.getByRole('banner').getByRole('link', { name: 'DJ Scraper' })).toBeVisible()

  const popover = await openEnginePopover(page)
  // Each row reads "<tool>: OK", then its version and path.
  await expect(
    popover.getByRole('list', { name: 'Engine tools' }).getByRole('listitem'),
  ).toHaveText([
    /^yt-dlp: OK\d{4}\.\d{2}\.\d{2}/,
    /^ffmpeg: OK8\.0/,
    /^ffprobe: OK8\.0/,
    /^node JS runtime: OK\d+\.\d+\.\d+/,
  ])

  const recheckSent = page.waitForRequest((request) => isRecheck(request.url()))
  const recheckAnswered = page.waitForResponse((answer) => isRecheck(answer.url()))
  await popover.getByRole('button', { name: 'Check again' }).click()

  const recheck = await recheckSent
  expect(recheck.method()).toBe('POST')
  // JSON-only mutations: without this header the server refuses the POST with 415.
  expect(await recheck.headerValue('content-type')).toBe('application/json')
  const answer = await recheckAnswered
  expect(answer.status()).toBe(200)
  const { checkedAt } = HealthSchema.parse(await answer.json())
  // The popover shows the fresh result.
  await expect(popover.locator('time')).toHaveAttribute('datetime', checkedAt)
  await expect(popover.getByRole('button', { name: 'Check again' })).toBeEnabled()
})

test('serves the app for a deep link, which shows Page not found with a way back', async ({
  page,
}) => {
  const response = await page.goto('/no-such-page')
  // The server's SPA fallback answers with the app, and the client router decides.
  expect(response?.status()).toBe(200)
  expect(await response?.headerValue('content-type')).toMatch(/^text\/html/)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  // The shell stays (header, downloads); only the page is missing.
  await expect(linkBox(page)).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Downloads' })).toBeVisible()

  await page.getByRole('link', { name: 'Back to start' }).click()

  await expect(page).toHaveURL('/')
  await expect(emptyState(page)).toBeVisible()
  await expect(linkBox(page)).toBeVisible()
})

test('focuses the link box on load; the keyboard reaches the folder and the engine chip, which shows a focus ring', async ({
  page,
  browserName,
}) => {
  // Safari's Tab skips links (unless "Press Tab to highlight each item" is on); Option-Tab doesn't.
  const back = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab'
  await page.goto('/')
  await expect(linkBox(page)).toBeFocused()
  const button = chip(page)
  await expect(button).toHaveAccessibleName('Engine status: Engine ready')
  const unfocused = await focusIndicator(button)

  // The header comes before the page: logo, download folder, engine chip, then the link box.
  await page.keyboard.press(back)
  await expect(button).toBeFocused()
  expect(await button.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  const focused = await focusIndicator(button)
  expect(focused).not.toEqual(unfocused)
  // A ring or an outline that actually draws, not just a subtle border change.
  expect(focused.ringPx).toBeGreaterThan(0)

  await page.keyboard.press(back)
  await expect(page.getByRole('button', { name: /^Download folder: ~?\// })).toBeFocused()
  await page.keyboard.press(back)
  await expect(page.getByRole('link', { name: 'DJ Scraper' })).toBeFocused()
})

test.describe('in a 420×800 window', () => {
  test.use({ viewport: { width: 420, height: 800 } })

  const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth)

  test('never scrolls sideways, empty or showing a playlist', async ({ page }) => {
    await page.goto('/')
    await expect(linkBox(page)).toBeFocused()
    await expect(emptyState(page)).toBeVisible()
    expect(await scrollWidth(page)).toBeLessThanOrEqual(420)

    await linkBox(page).fill(YOUTUBE_PLAYLIST)
    await linkBox(page).press('Enter')
    await expect(page.getByRole('table', { name: 'Tracks' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download 20 tracks' })).toBeVisible()
    expect(await scrollWidth(page)).toBeLessThanOrEqual(420)
  })

  test('keeps the open engine popover inside the window', async ({ page }) => {
    await page.goto('/')
    const popover = await openEnginePopover(page)

    const box = await settledBox(popover)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(420)
    expect(box.y + box.height).toBeLessThanOrEqual(800)
    // Nor does it make the page scroll sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420)
  })
})

test('opens the engine popover without animation when reduced motion is requested', async ({
  page,
}) => {
  await page.goto('/')
  // By default it animates in, which shows the measurement below looks at the right element.
  const animated = await openEnginePopover(page)
  expect(await longestMotionMs(animated)).toBeGreaterThanOrEqual(50)
  await page.keyboard.press('Escape')
  await expect(animated).toBeHidden()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await openEnginePopover(page)
  expect(await longestMotionMs(reduced)).toBeLessThan(1)
})
