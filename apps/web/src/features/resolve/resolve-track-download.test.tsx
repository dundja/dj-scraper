// From a paste to its download with the real TrackCard (no doubles, unlike resolve-page.test.tsx):
// a pasted track waits for Download or ⌘D (ADR-031), under StrictMode one press queues it exactly
// once, and the ['settings'] refetch that a created download sets off doesn't queue it again. A
// Spotify track goes the same way (ADR-026).
// The remix search under the card never answers here: remix-section.test.tsx covers it.
import { type CreateDownloadsResponse, DownloadRequestSchema } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { batch, liveDownloads, settings, spotifyJob, spotifyMatch } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { spotifyTrack, track, trackResult, urls } from '@/test/resolve.ts'
import { ResolvePage } from './resolve-page.tsx'

const CREATE = 'POST /api/downloads'
const SETTINGS = 'GET /api/settings'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  server.on(SETTINGS, () => json(settings))
  server.on('POST /api/resolve', () => json(trackResult()))
  server.on('POST /api/remixes', noAnswer)
  let next = 40
  server.on(CREATE, () =>
    json({
      batchId: batch.id,
      jobIds: [testUuid(next++)],
      duplicates: 0,
    } satisfies CreateDownloadsResponse),
  )
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

const urlBox = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'YouTube, SoundCloud or Spotify link' })
const card = () => screen.getByRole('article', { name: track.title })
const cardStatus = () => within(card()).getByRole('status')
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

it('waits for Download, then queues the track once under StrictMode, also after the settings refetch', async () => {
  const user = userEvent.setup()
  renderWithQueryClient(
    <StrictMode>
      <ResolvePage />
    </StrictMode>,
  )
  act(() => urlBox().blur())

  await user.paste(urls.track)
  const download = await within(
    await screen.findByRole('article', { name: track.title }),
  ).findByRole('button', { name: 'Download' })
  await settle()
  expect(server.callsTo(CREATE)).toEqual([])

  await user.click(download)
  await waitFor(() => expect(cardStatus().textContent).toBe('Queued…'))
  expect(server.callsTo('POST /api/resolve')).toHaveLength(1)
  expect(server.callsTo(CREATE)).toHaveLength(1)
  expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0])).items).toEqual([
    toTrackRef(track),
  ])

  // The created download invalidates ['settings'] (recent folders): the refetch re-renders the
  // result, which must not queue the track again.
  await waitFor(() => expect(server.callsTo(SETTINGS).length).toBeGreaterThanOrEqual(2))
  await settle()
  expect(server.callsTo(CREATE)).toHaveLength(1)

  // The same link pasted again is a new load with a new card, which waits for Download again.
  act(() => urlBox().blur())
  await user.paste(urls.track)
  await waitFor(() => expect(server.callsTo('POST /api/resolve')).toHaveLength(2))
  await within(card()).findByRole('button', { name: 'Download' })
  await settle()
  expect(server.callsTo(CREATE)).toHaveLength(1)
  expect(screen.getAllByRole('article', { name: track.title })).toHaveLength(1)
})

it('downloads with ⌘D right after a paste, while the focus is still in the link box', async () => {
  const user = userEvent.setup()
  renderWithQueryClient(<ResolvePage />)
  act(() => urlBox().blur())

  await user.paste(urls.track)
  await within(await screen.findByRole('article', { name: track.title })).findByRole('button', {
    name: 'Download',
  })
  expect(document.activeElement).toBe(urlBox())

  await user.keyboard('{Meta>}d{/Meta}')

  await waitFor(() => expect(cardStatus().textContent).toBe('Queued…'))
  expect(server.callsTo(CREATE)).toHaveLength(1)
  expect(document.activeElement).toBe(urlBox())
})

it('downloads a pasted Spotify track like any other, and shows the YouTube upload it matched', async () => {
  server.on('POST /api/resolve', () => json(trackResult(spotifyTrack)))
  const user = userEvent.setup()
  const { queryClient } = renderWithQueryClient(<ResolvePage />)
  const { send } = await liveDownloads(queryClient)
  act(() => urlBox().blur())

  await user.paste(`${urls.spotifyTrack}?si=1b2c3d4e5f6a7b8c`)
  const card = await screen.findByRole('article', { name: 'Never Gonna Give You Up' })
  expect(jsonBody(server.callsTo('POST /api/resolve')[0])).toEqual({ url: urls.spotifyTrack })
  await user.click(within(card).getByRole('button', { name: 'Download' }))
  await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
  expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0])).items).toEqual([
    toTrackRef(spotifyTrack),
  ])

  const jobId = testUuid(40)
  await send({
    type: 'jobs.added',
    batch,
    jobs: [spotifyJob({ id: jobId, status: 'downloading', match: spotifyMatch })],
  })
  expect(within(card).getByRole('link').getAttribute('href')).toBe(spotifyMatch.url)
  expect(within(card).getByRole('status').textContent).toBe('Starting…')
})
