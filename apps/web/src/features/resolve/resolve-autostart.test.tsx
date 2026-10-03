// From a paste to its download with the real TrackCard (no doubles, unlike resolve-page.test.tsx):
// under StrictMode each paste queues the track exactly once, and the ['settings'] refetch that a
// created download sets off doesn't queue it again.
import { type CreateDownloadsResponse, DownloadRequestSchema } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { batch, settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { track, trackResult, urls } from '@/test/resolve.ts'
import { ResolvePage } from './resolve-page.tsx'

const CREATE = 'POST /api/downloads'
const SETTINGS = 'GET /api/settings'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  server.on(SETTINGS, () => json(settings))
  server.on('POST /api/resolve', () => json(trackResult()))
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
  screen.getByRole('textbox', { name: 'YouTube or SoundCloud link' })
const cardStatus = () =>
  within(screen.getByRole('article', { name: track.title })).getByRole('status')

it('queues a pasted track once per paste under StrictMode, also after the settings refetch', async () => {
  const user = userEvent.setup()
  renderWithQueryClient(
    <StrictMode>
      <ResolvePage />
    </StrictMode>,
  )
  act(() => urlBox().blur())

  await user.paste(urls.track)
  await waitFor(() => expect(cardStatus().textContent).toBe('Queued…'))
  expect(server.callsTo('POST /api/resolve')).toHaveLength(1)
  expect(server.callsTo(CREATE)).toHaveLength(1)
  expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0])).items).toEqual([
    toTrackRef(track),
  ])

  // The created download invalidates ['settings'] (recent folders): the refetch re-renders the
  // result, which must not queue the track again.
  await waitFor(() => expect(server.callsTo(SETTINGS).length).toBeGreaterThanOrEqual(2))
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
  expect(server.callsTo(CREATE)).toHaveLength(1)

  // The same link pasted again is a new load with a new card: one more download, not two.
  act(() => urlBox().blur())
  await user.paste(urls.track)
  await waitFor(() => expect(server.callsTo('POST /api/resolve')).toHaveLength(2))
  await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(2))
  await waitFor(() => expect(server.callsTo(SETTINGS).length).toBeGreaterThanOrEqual(3))
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
  expect(server.callsTo(CREATE)).toHaveLength(2)
  expect(screen.getAllByRole('article', { name: track.title })).toHaveLength(1)
})
