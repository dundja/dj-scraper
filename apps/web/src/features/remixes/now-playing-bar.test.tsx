// The now-playing bar (ADR-031): present only while a remix is prepared, plays, is paused or failed;
// its controls drive the one player (play/pause, seek, the speed grid, Keep pitch, Close), its
// Download records the job for the row that started it, and the section leaving takes it away.
// The server is the fake fetch; the element's play and pause are the stand-ins of src/test/setup.ts.
import { type CreateDownloadsResponse, DownloadRequestSchema } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { batch, jobWith, liveDownloads, settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { artyRemix, artyYoutube, extendedMix, extendedUpload, remixes } from '@/test/remixes.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { track } from '@/test/resolve.ts'
import { NowPlayingBar } from './now-playing-bar.tsx'
import { getPreviewState, previewAudio, resetPreviewPlayer } from './preview-player.ts'
import { createRemixJobs, latestJobId } from './remix-jobs.ts'
import { uploadRef } from './remix-request.ts'
import { RemixRow } from './remix-row.tsx'
import { RemixSection } from './remix-section.tsx'

const PREVIEWS = 'POST /api/previews'
const CREATE = 'POST /api/downloads'
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
  server.on('GET /api/settings', () => json(settings))
  server.on(CREATE, () =>
    json({
      batchId: batch.id,
      jobIds: [testUuid(50)],
      duplicates: 0,
    } satisfies CreateDownloadsResponse),
  )
})

afterEach(() => {
  // Inside act: the mounted rows and bar hear the player stop.
  act(() => resetPreviewPlayer())
  expect(server.unhandled).toEqual([])
})

/** Two rows of one section's jobs, and the bar, as the shell has it (the bar outside the list). */
function renderRowsAndBar() {
  const jobs = createRemixJobs()
  const rendered = renderWithQueryClient(
    <>
      <ul>
        <RemixRow suggestion={artyRemix} song={remixes.song} jobs={jobs} />
        <RemixRow suggestion={extendedMix} song={remixes.song} jobs={jobs} />
      </ul>
      <NowPlayingBar />
    </>,
  )
  return { ...rendered, jobs }
}

/** A click inside act(), with time for the fake server and the player to answer. */
const click = (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const queryBar = () => screen.queryByRole('region', { name: 'Now playing' })
const bar = () => screen.getByRole('region', { name: 'Now playing' })
const inBar = () => within(bar())
/**
 * What the player says: a status region beside the bar, in the page while nothing plays too (the
 * Download in the bar has a status of its own).
 */
const playerStatus = () => {
  const status = document.querySelector<HTMLElement>('[data-slot="now-playing-status"]')
  if (status?.getAttribute('role') !== 'status') throw new Error('No player status')
  return status
}
const playRow = (title: string) => screen.getByRole('button', { name: `Play ${title}` })

async function playing(title = artyYoutube.title) {
  const rendered = renderRowsAndBar()
  await click(playRow(title))
  await screen.findByRole('button', { name: `Pause ${title}` })
  return rendered
}

describe('the bar', () => {
  it('is absent while nothing plays', () => {
    renderRowsAndBar()
    expect(queryBar()).toBeNull()
  })

  it('says what the player does in a status region that was there before it had words', async () => {
    server.on(PREVIEWS, noAnswer)
    renderRowsAndBar()
    const status = playerStatus()
    expect(status.textContent).toBe('')

    await click(playRow(artyYoutube.title))

    // The same element: a live region added with its first words isn't read.
    expect(playerStatus()).toBe(status)
    expect(status.textContent).toBe('Preparing audio…')
    expect(bar().contains(status)).toBe(false)
  })

  it('shows what plays: cover, title, credit, platform, and the honest source', async () => {
    await playing()

    expect(bar().dataset.status).toBe('playing')
    // What tells it apart, as its row says it; the whole title in the tooltip.
    expect(inBar().getByText('Arty Remix').getAttribute('title')).toBe(artyYoutube.title)
    expect(inBar().getByText('Remix by Arty')).toBeTruthy()
    expect(inBar().getByText('YouTube')).toBeTruthy()
    expect(playerStatus().textContent).toBe('Playing. Preview: YouTube stream')
  })

  it('says it prepares the audio, and its button cancels', async () => {
    server.on(PREVIEWS, noAnswer)
    renderRowsAndBar()

    await click(playRow(artyYoutube.title))
    expect(playerStatus().textContent).toBe('Preparing audio…')
    await click(inBar().getByRole('button', { name: 'Cancel preparing' }))

    expect(server.callsTo(PREVIEWS)[0]?.signal?.aborted).toBe(true)
    expect(queryBar()).toBeNull()
  })

  it('hands the focus to the row when its cancel takes the bar away', async () => {
    server.on(PREVIEWS, noAnswer)
    renderRowsAndBar()
    await click(playRow(artyYoutube.title))
    const cancel = inBar().getByRole('button', { name: 'Cancel preparing' })
    cancel.focus()

    await click(cancel)

    expect(queryBar()).toBeNull()
    expect(document.activeElement).toBe(playRow(artyYoutube.title))
  })

  it('pauses and plays again, as the row does', async () => {
    await playing()

    await click(inBar().getByRole('button', { name: 'Pause' }))
    expect(playerStatus().textContent).toBe('Paused. Preview: YouTube stream')
    expect(playRow(artyYoutube.title)).toBeTruthy()
    await click(inBar().getByRole('button', { name: 'Play' }))

    expect(playerStatus().textContent).toMatch(/^Playing\./)
    expect(server.callsTo(PREVIEWS)).toHaveLength(1)
  })

  it('follows the row playing now: one at a time', async () => {
    await playing()

    await click(playRow(extendedUpload.title))
    await screen.findByRole('button', { name: `Pause ${extendedUpload.title}` })

    expect(inBar().getByText('Extended Mix').getAttribute('title')).toBe(extendedUpload.title)
    expect(inBar().getByText('Extended mix')).toBeTruthy()
    expect(playRow(artyYoutube.title)).toBeTruthy()
  })

  it('closes: the audio stops, the bar goes and the focus returns to the row', async () => {
    await playing()
    const close = inBar().getByRole('button', { name: 'Close player' })
    close.focus()

    await click(close)

    expect(queryBar()).toBeNull()
    expect(getPreviewState().status).toBe('idle')
    expect(previewAudio().hasAttribute('src')).toBe(false)
    expect(document.activeElement).toBe(playRow(artyYoutube.title))
  })

  it('shows a failure with its icon, hint and Try again, which plays', async () => {
    server.on(PREVIEWS, () =>
      json({ error: { code: 'rate_limited', message: 'YouTube is limiting requests.' } }, 429),
    )
    renderRowsAndBar()
    await click(playRow(artyYoutube.title))

    const alert = inBar().getByRole('alert')
    expect(alert.textContent).toContain('YouTube is limiting requests.')
    expect(alert.textContent).toContain('Limits usually lift within a few minutes')
    const playButton = inBar().getByRole('button', { name: 'Play' })
    expect(playButton.getAttribute('aria-disabled')).toBe('true')

    server.on(PREVIEWS, () =>
      json({
        id: 'a'.repeat(32),
        src: `/api/previews/${'a'.repeat(32)}`,
        mime: 'audio/mp4',
        sizeBytes: 1,
      }),
    )
    await click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(inBar().getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(inBar().getByText('Remix by Arty')).toBeTruthy()
  })
})

describe('the focus through a failure', () => {
  const limited = () =>
    json({ error: { code: 'rate_limited', message: 'YouTube is limiting requests.' } }, 429)
  /** The first preparation fails when `fail` is called (at once without it); the next never ends. */
  const failOnce = () => {
    let fail: () => void = () => {}
    let calls = 0
    server.on(PREVIEWS, () => {
      calls += 1
      if (calls > 1) return noAnswer()
      return new Promise<Response>((resolve) => (fail = () => resolve(limited())))
    })
    return () => fail()
  }

  it('stays on play/pause when preparing fails: it stays, disabled', async () => {
    const fail = failOnce()
    renderRowsAndBar()
    await click(playRow(artyYoutube.title))
    const button = inBar().getByRole('button', { name: 'Cancel preparing' })
    button.focus()

    await act(async () => {
      fail()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(bar().dataset.status).toBe('error')
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-label')).toBe('Play')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // Disabled: a click does nothing.
    await click(button)
    expect(server.callsTo(PREVIEWS)).toHaveLength(1)
  })

  it('moves from Try again to play/pause once the audio is prepared again', async () => {
    const fail = failOnce()
    renderRowsAndBar()
    await click(playRow(artyYoutube.title))
    await act(async () => {
      fail()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const retry = within(inBar().getByRole('alert')).getByRole('button', { name: 'Try again' })
    retry.focus()

    await click(retry)

    expect(inBar().queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(inBar().getByRole('button', { name: 'Cancel preparing' }))
  })
})

describe('the seek bar', () => {
  it('shows elapsed time and duration, and the keyboard moves it', async () => {
    await playing()
    const audio = previewAudio()
    Object.defineProperty(audio, 'duration', { configurable: true, value: 214 })
    act(() => audio.dispatchEvent(new Event('durationchange')))

    const seek = inBar().getByRole('slider', { name: 'Seek' })
    expect(seek.getAttribute('aria-valuetext')).toBe('0:00 of 3:34')
    fireEvent.change(seek, { target: { value: '12' } })

    expect(audio.currentTime).toBe(12)
    expect(seek.getAttribute('aria-valuetext')).toBe('0:12 of 3:34')
    expect(inBar().getByText('0:12')).toBeTruthy()
    expect(inBar().getByText('3:34')).toBeTruthy()
  })
})

describe('the speed grid', () => {
  it('has preset speeds, one pressed, that set the element’s speed', async () => {
    await playing()

    expect(inBar().getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('true')
    await click(inBar().getByRole('button', { name: '1.25x' }))

    expect(previewAudio().playbackRate).toBe(1.25)
    expect(inBar().getByRole('button', { name: '1.25x' }).getAttribute('aria-pressed')).toBe('true')
    expect(inBar().getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('false')
    expect(inBar().getByLabelText('Current speed').textContent).toBe('1.25x')
  })

  it('nudges by 0.01, shows the exact value and resets to 1x', async () => {
    await playing()

    for (let i = 0; i < 3; i++) {
      await click(inBar().getByRole('button', { name: 'Faster by 0.01x' }))
    }
    expect(inBar().getByLabelText('Current speed').textContent).toBe('1.03x')
    expect(previewAudio().playbackRate).toBe(1.03)
    // Between presets: none is pressed.
    expect(inBar().queryAllByRole('button', { pressed: true })).toEqual([])

    await click(inBar().getByRole('button', { name: 'Reset to 1x' }))
    expect(previewAudio().playbackRate).toBe(1)
  })

  it('binds Keep pitch to the element, on by default', async () => {
    await playing()
    const lock = inBar().getByRole('switch', { name: 'Keep pitch' })

    expect(lock.getAttribute('aria-checked')).toBe('true')
    await click(lock)

    expect(previewAudio().preservesPitch).toBe(false)
    expect(lock.getAttribute('aria-checked')).toBe('false')
  })

  it('opens as a popover with the fine slider, on a narrower window', async () => {
    await playing()

    await click(inBar().getByRole('button', { name: 'Playback speed, 1.00x' }))
    fireEvent.change(await screen.findByRole('slider', { name: 'Speed' }), {
      target: { value: '0.87' },
    })

    expect(previewAudio().playbackRate).toBe(0.87)
    expect(inBar().getByRole('button', { name: 'Playback speed, 0.87x' })).toBeTruthy()
  })

  it('keeps the speed for the next row', async () => {
    await playing()
    await click(inBar().getByRole('button', { name: '1.1x' }))

    await click(playRow(extendedUpload.title))
    await screen.findByRole('button', { name: `Pause ${extendedUpload.title}` })

    expect(previewAudio().playbackRate).toBe(1.1)
    expect(inBar().getByLabelText('Current speed').textContent).toBe('1.10x')
  })
})

describe('Download', () => {
  const said = (element: HTMLElement) =>
    within(element)
      .queryAllByRole('status')
      .map((status) => status.textContent)
  const rowOf = (title: string) => screen.getByRole('listitem', { name: title })

  it('says "Added to downloads" only where it was pressed: the bar', async () => {
    await playing()

    await click(inBar().getByRole('button', { name: 'Download playing remix' }))

    expect(said(bar())).toContain('Added to downloads')
    expect(said(rowOf(artyYoutube.title))).not.toContain('Added to downloads')
  })

  it('says "Added to downloads" only where it was pressed: the row', async () => {
    await playing()

    await click(
      within(rowOf(artyYoutube.title)).getByRole('button', {
        name: `Download ${artyYoutube.title}`,
      }),
    )

    expect(said(rowOf(artyYoutube.title))).toContain('Added to downloads')
    expect(said(bar())).not.toContain('Added to downloads')
  })

  it('queues the playing upload and records its job for the row that started it', async () => {
    const { jobs, queryClient } = await playing()
    const { send } = await liveDownloads(queryClient)

    await click(inBar().getByRole('button', { name: 'Download playing remix' }))

    const sent = DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0]))
    expect(sent.items).toEqual([uploadRef(artyYoutube)])
    expect(sent.label).toBe(artyYoutube.title)
    expect(latestJobId(jobs.get(), artyRemix.uploads)).toBe(testUuid(50))

    await send({
      type: 'jobs.added',
      batch,
      jobs: [jobWith({ id: testUuid(50), status: 'queued', track: uploadRef(artyYoutube) })],
    })
    const row = screen.getByRole('listitem', { name: artyYoutube.title })
    expect(row.textContent).toContain('Download: Queued')
    expect(bar().textContent).toContain('Download: Queued')
    expect(server.callsTo(CREATE)).toHaveLength(1)
  })
})

it('goes when the remix section leaves the page (a new paste), stopping the audio', async () => {
  server.on('POST /api/remixes', () => json(remixes))
  const page = (section: boolean) => (
    <>
      {section && <RemixSection track={track} />}
      <NowPlayingBar />
    </>
  )
  const { rerender, queryClient } = renderWithQueryClient(page(true))
  await click(await screen.findByRole('button', { name: `Play ${artyYoutube.title}` }))
  await screen.findByRole('region', { name: 'Now playing' })

  rerender(<QueryClientProvider client={queryClient}>{page(false)}</QueryClientProvider>)

  expect(queryBar()).toBeNull()
  expect(previewAudio().hasAttribute('src')).toBe(false)
})
