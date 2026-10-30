// A remix row's Play button (ADR-029, ADR-031): preparing, playing, one row at a time, the one
// raised row, and what an unmount does. The player's controls are the now-playing bar's
// (now-playing-bar.test.tsx). The server is the fake fetch; the element's play and pause are the
// stand-ins from src/test/setup.ts.
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeApi, json, noAnswer } from '@/test/fake-api.ts'
import { artyRemix, artyYoutube, extendedMix, extendedUpload, remixes } from '@/test/remixes.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { getPreviewState, previewAudio, resetPreviewPlayer } from './preview-player.ts'
import { createRemixJobs } from './remix-jobs.ts'
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

function renderRows() {
  const jobs = createRemixJobs()
  const rendered = renderWithQueryClient(
    <ul>
      <RemixRow suggestion={artyRemix} song={remixes.song} jobs={jobs} />
      <RemixRow suggestion={extendedMix} song={remixes.song} jobs={jobs} />
    </ul>,
  )
  return { ...rendered, jobs }
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
const rowOf = (title: string) => screen.getByRole('listitem', { name: title })

describe('the title', () => {
  it('shows what tells the version apart, on one line from @4xl; the whole title names the row', () => {
    renderRows()
    const row = rowOf(artyYoutube.title)

    const title = within(row).getByText('Arty Remix')
    expect(title.getAttribute('title')).toBe(artyYoutube.title)
    expect(title.className).toContain('@4xl:line-clamp-1')
    expect(within(rowOf(extendedUpload.title)).getByText('Extended Mix')).toBeTruthy()
  })
})

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

  it('prepares, then plays as the one raised row, telling the player what the bar shows', async () => {
    const { jobs } = renderRows()

    await click(play(artyYoutube.title))

    expect(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })).toBeTruthy()
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('playing')
    expect(rowOf(artyYoutube.title).className).toContain('bg-card')
    expect(rowOf(extendedUpload.title).dataset.preview).toBe('idle')
    expect(rowOf(extendedUpload.title).className).not.toContain('bg-card')
    expect(getPreviewState().nowPlaying).toEqual({
      upload: artyYoutube,
      credit: 'Remix by Arty',
      version: 'Arty Remix',
      jobs,
    })
  })

  it('shows a spinner while the audio is prepared, and a click cancels it', async () => {
    server.on(PREVIEWS, noAnswer)
    renderRows()

    await click(play(artyYoutube.title))
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('preparing')
    await click(screen.getByRole('button', { name: `Cancel preparing ${artyYoutube.title}` }))

    expect(server.callsTo(PREVIEWS)[0]?.signal?.aborted).toBe(true)
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('idle')
    expect(play(artyYoutube.title)).toBeTruthy()
  })

  it('pauses on a second click and plays again on a third, staying raised', async () => {
    renderRows()
    await click(play(artyYoutube.title))

    await click(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` }))
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('paused')
    expect(rowOf(artyYoutube.title).className).toContain('bg-card')
    await click(play(artyYoutube.title))

    expect(rowOf(artyYoutube.title).dataset.preview).toBe('playing')
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
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('idle')
  })

  it('keeps the audio playing when the row unmounts: the bar plays on', async () => {
    const { unmount } = renderRows()
    await click(play(artyYoutube.title))
    await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })

    unmount()

    expect(previewAudio().paused).toBe(false)
    expect(getPreviewState().status).toBe('playing')
  })

  it('stays raised after a failure, which the bar shows; the button tries again', async () => {
    server.on(PREVIEWS, () =>
      json({ error: { code: 'rate_limited', message: 'YouTube is limiting requests.' } }, 429),
    )
    renderRows()

    await click(play(artyYoutube.title))
    expect(rowOf(artyYoutube.title).dataset.preview).toBe('error')
    expect(screen.queryByRole('alert')).toBeNull()

    server.on(PREVIEWS, () =>
      json({
        id: 'a'.repeat(32),
        src: `/api/previews/${'a'.repeat(32)}`,
        mime: 'audio/mp4',
        sizeBytes: 1,
      }),
    )
    await click(play(artyYoutube.title))
    expect(await screen.findByRole('button', { name: `Pause ${artyYoutube.title}` })).toBeTruthy()
  })
})
