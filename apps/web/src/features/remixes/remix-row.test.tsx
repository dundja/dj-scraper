// A remix row's player (ADR-029): the Play button, the strip with the seek bar and the speed grid,
// one row at a time, and what an unmount does. The server is the fake fetch; the element's play and
// pause are the stand-ins from src/test/setup.ts.
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeApi, json, noAnswer } from '@/test/fake-api.ts'
import { artyRemix, artyYoutube, extendedMix, extendedUpload } from '@/test/remixes.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { previewAudio, resetPreviewPlayer } from './preview-player.ts'
import { RemixRow } from './remix-row.tsx'

const PREVIEWS = 'POST /api/previews'
let server: ReturnType<typeof fakeApi>
let served = 0

beforeEach(() => {
  server = fakeApi()
  served = 0
  server.on(PREVIEWS, () => {
    served += 1
    const id = served.toString(16).padStart(32, '0')
    return json({ id, src: `/api/previews/${id}`, mime: 'audio/mp4', sizeBytes: 10 })
  })
})

afterEach(() => {
  // Inside act: the mounted rows hear the player stop.
  act(() => resetPreviewPlayer())
  expect(server.unhandled).toEqual([])
})

const noop = () => {}
function renderRows() {
  return renderWithQueryClient(
    <ul>
      <RemixRow suggestion={artyRemix} jobId={undefined} onQueued={noop} />
      <RemixRow suggestion={extendedMix} jobId={undefined} onQueued={noop} />
    </ul>,
  )
}
/**
 * A click inside act(), with time for the fake server and the player to answer: they update the
 * row from outside React, after the click returns.
 */
const click = (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const play = (title: string) => screen.getByRole('button', { name: `Play ${title}` })

describe('the Play button', () => {
  it('sits left of Download, named for the default upload', () => {
    renderRows()
    const buttons = within(screen.getAllByRole('listitem')[0] as HTMLElement).getAllByRole('button')
    const names = buttons.map((button) => button.getAttribute('aria-label'))
    expect(names.indexOf(`Play ${artyYoutube.title}`)).toBeGreaterThanOrEqual(0)
    expect(names.indexOf(`Play ${artyYoutube.title}`)).toBeLessThan(
      names.indexOf(`Download ${artyYoutube.title}`),
    )
  })

  it('prepares, then plays and offers Pause with the honest source line', async () => {
    renderRows()

    await click(play(artyYoutube.title))

    expect(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })).toBeTruthy()
    const strip = screen.getByRole('region', { name: `Preview of ${artyYoutube.title}` })
    expect(strip.textContent).toContain('Preview: YouTube stream')
  })

  it('shows "Preparing audio…" and a click cancels it', async () => {
    server.on(PREVIEWS, noAnswer)
    renderRows()

    await click(play(artyYoutube.title))
    expect(screen.getByText('Preparing audio…')).toBeTruthy()
    await click(screen.getByRole('button', { name: `Cancel preparing ${artyYoutube.title}` }))

    expect(server.callsTo(PREVIEWS)[0]?.signal?.aborted).toBe(true)
    expect(screen.queryByText('Preparing audio…')).toBeNull()
    expect(play(artyYoutube.title)).toBeTruthy()
  })

  it('pauses on a second click and plays again on a third', async () => {
    renderRows()
    await click(play(artyYoutube.title))

    await click(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` }))
    expect(await screen.findByText(/^Paused\./)).toBeTruthy()
    await click(play(artyYoutube.title))

    expect(await screen.findByText(/^Playing\./)).toBeTruthy()
    expect(server.callsTo(PREVIEWS)).toHaveLength(1)
  })

  it('plays one row at a time: the second row takes over and the first goes back to Play', async () => {
    renderRows()
    await click(play(artyYoutube.title))
    await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })

    await click(play(extendedUpload.title))

    expect(
      await screen.findByRole('button', { name: `Pause ${extendedUpload.title}` }),
    ).toBeTruthy()
    expect(play(artyYoutube.title)).toBeTruthy()
    expect(screen.queryByRole('region', { name: `Preview of ${artyYoutube.title}` })).toBeNull()
  })

  it('stops the audio when the row unmounts', async () => {
    const { unmount } = renderRows()
    await click(play(artyYoutube.title))
    await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })
    const audio = previewAudio()

    unmount()

    expect(audio.paused).toBe(true)
    expect(audio.hasAttribute('src')).toBe(false)
  })

  it('shows a failure with its hint and Try again', async () => {
    server.on(PREVIEWS, () =>
      json({ error: { code: 'rate_limited', message: 'YouTube is limiting requests.' } }, 429),
    )
    renderRows()

    await click(play(artyYoutube.title))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('YouTube is limiting requests.')
    expect(alert.textContent).toContain('Limits usually lift within a few minutes')

    server.on(PREVIEWS, () =>
      json({
        id: 'a'.repeat(32),
        src: `/api/previews/${'a'.repeat(32)}`,
        mime: 'audio/mp4',
        sizeBytes: 1,
      }),
    )
    await click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })).toBeTruthy()
  })
})

describe('the strip', () => {
  async function playing() {
    renderRows()
    await click(play(artyYoutube.title))
    await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })
  }

  it('shows elapsed time and duration, and a seek bar the keyboard moves', async () => {
    await playing()
    const audio = previewAudio()
    Object.defineProperty(audio, 'duration', { configurable: true, value: 214 })
    act(() => audio.dispatchEvent(new Event('durationchange')))

    const seek = screen.getByRole('slider', { name: 'Seek' })
    expect(seek.getAttribute('aria-valuetext')).toBe('0:00 of 3:34')
    fireEvent.change(seek, { target: { value: '12' } })

    expect(audio.currentTime).toBe(12)
    expect(seek.getAttribute('aria-valuetext')).toBe('0:12 of 3:34')
    expect(screen.getByText('0:12')).toBeTruthy()
  })

  it('has preset speeds, one pressed, that set the element’s speed', async () => {
    await playing()
    const strip = screen.getByRole('region', { name: `Preview of ${artyYoutube.title}` })

    expect(within(strip).getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    await click(within(strip).getByRole('button', { name: '1.25x' }))

    expect(previewAudio().playbackRate).toBe(1.25)
    expect(within(strip).getByRole('button', { name: '1.25x' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(within(strip).getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
    expect(within(strip).getByLabelText('Current speed').textContent).toBe('1.25x')
  })

  it('nudges by 0.01, shows the exact value and resets to 1x', async () => {
    await playing()

    await click(screen.getByRole('button', { name: 'Faster by 0.01x' }))
    await click(screen.getByRole('button', { name: 'Faster by 0.01x' }))
    await click(screen.getByRole('button', { name: 'Faster by 0.01x' }))
    expect(screen.getByLabelText('Current speed').textContent).toBe('1.03x')
    expect(screen.getByRole('slider', { name: 'Speed' }).getAttribute('aria-valuetext')).toBe(
      '1.03x',
    )
    expect(previewAudio().playbackRate).toBe(1.03)
    // Between presets: none is pressed.
    expect(screen.queryAllByRole('button', { pressed: true })).toEqual([])

    await click(screen.getByRole('button', { name: 'Reset to 1x' }))
    expect(previewAudio().playbackRate).toBe(1)
  })

  it('moves the speed with the slider', async () => {
    await playing()

    fireEvent.change(screen.getByRole('slider', { name: 'Speed' }), { target: { value: '0.87' } })

    expect(previewAudio().playbackRate).toBe(0.87)
    expect(screen.getByLabelText('Current speed').textContent).toBe('0.87x')
  })

  it('binds Keep pitch to the element, on by default', async () => {
    await playing()
    const lock = screen.getByRole('switch', { name: 'Keep pitch' })

    expect(lock.getAttribute('aria-checked')).toBe('true')
    expect(previewAudio().preservesPitch).toBe(true)
    await click(lock)

    expect(previewAudio().preservesPitch).toBe(false)
    expect(lock.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the speed for the next row', async () => {
    await playing()
    await click(screen.getByRole('button', { name: '1.1x' }))

    await click(play(extendedUpload.title))
    await screen.findByRole('button', { name: `Pause ${extendedUpload.title}` })

    expect(previewAudio().playbackRate).toBe(1.1)
    expect(screen.getByLabelText('Current speed').textContent).toBe('1.10x')
  })
})
