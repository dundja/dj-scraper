import { type CreateDownloadsResponse, DownloadRequestSchema, type Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type ReactElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { batch, jobWith, liveDownloads, settings, snapshotWith } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { previewTrack, scTrack, track, trackWith } from '@/test/resolve.ts'
import { TrackCard } from './track-card.tsx'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

const FIRST_JOB = testUuid(31)
const SECOND_JOB = testUuid(32)
const CREATE = 'POST /api/downloads'

const created = (jobId: string): CreateDownloadsResponse => ({
  batchId: batch.id,
  jobIds: [jobId],
  duplicates: 0,
})

/** The track's job as the event stream reports it. */
const jobOf = (id: string, fields: Record<string, unknown> = {}): Job =>
  jobWith({ id, status: 'queued', track: toTrackRef(track), ...fields })

/** Answers each `POST /api/downloads` with the next job id. */
function queueJobs(...ids: string[]) {
  let next = 0
  server.on(CREATE, () => {
    const id = ids[next++]
    if (id === undefined) throw new Error('More downloads than expected')
    return json(created(id))
  })
}

/** The card, its QueryClient, and the event stream feeding `['downloads']` (no jobs yet). */
async function renderCard(ui: ReactElement, jobs: Job[] = []) {
  const rendered = renderWithQueryClient(ui)
  const stream = await liveDownloads(rendered.queryClient, snapshotWith({ jobs, batches: [batch] }))
  return { ...rendered, ...stream }
}

const card = () => screen.getByRole('article', { name: track.title })
const status = () => within(card()).getByRole('status')
/** The card's download area, which keeps the focus while a pressed button gives way. */
const downloadArea = () => {
  const area = card().querySelector<HTMLElement>('[data-slot="track-download"]')
  if (area === null) throw new Error('No download area')
  return area
}

describe('TrackCard', () => {
  it('shows the artwork, title, artist, duration, platform and source quality', async () => {
    await renderCard(<TrackCard track={track} autoStart={false} />)

    expect(within(card()).getByRole('heading', { level: 2, name: 'The Chill Zone' })).toBeDefined()
    expect(card().querySelector('img')?.getAttribute('src')).toBe(track.thumbnailUrl)
    expect(within(card()).getByText('Royalty Free Music')).toBeDefined()
    expect(within(card()).getByText('4:27')).toBeDefined()
    expect(within(card()).getByText('YouTube')).toBeDefined()
    // yt-dlp measures 129.553 kbps for YouTube's nominal 128 kbps AAC stream.
    expect(within(card()).getByText('Source: AAC 128 kbps')).toBeDefined()
  })

  it("shows a SoundCloud track's MP3 source", async () => {
    await renderCard(<TrackCard track={scTrack} autoStart={false} />)
    const article = screen.getByRole('article', { name: 'Robo Kitty' })
    expect(within(article).getByText('SoundCloud')).toBeDefined()
    expect(within(article).getByText('Source: MP3 128 kbps')).toBeDefined()
    expect(within(article).getByText('4:05')).toBeDefined()
  })

  it('names the uploader when there is no artist, and says when the source is unknown', async () => {
    const bare = trackWith({ artist: undefined, source: undefined, durationSec: undefined })
    await renderCard(<TrackCard track={bare} autoStart={false} />)

    expect(within(card()).getByText('Royalty Free Music Crew')).toBeDefined()
    expect(within(card()).getByText('Source quality shown after download')).toBeDefined()
    expect(within(card()).queryByText(/Duration/)).toBeNull()
  })

  it('names the stream the download really fetched once the job reports it', async () => {
    // Resolve's best guess is YouTube's Opus stream; an M4A download takes the AAC one instead.
    const opus = trackWith({ source: { codec: 'opus', bitrateKbps: 136 } })
    queueJobs(FIRST_JOB)
    const { send } = await renderCard(<TrackCard track={opus} autoStart />)
    expect(within(card()).getByText('Source: Opus 136 kbps')).toBeDefined()
    await waitFor(() => expect(status().textContent).toBe('Queued…'))

    await send({ type: 'jobs.added', batch, jobs: [jobOf(FIRST_JOB)] })
    expect(within(card()).getByText('Source: Opus 136 kbps')).toBeDefined()
    await send({
      type: 'jobs.updated',
      jobs: [
        jobOf(FIRST_JOB, {
          status: 'downloading',
          format: 'm4a',
          source: { codec: 'mp4a.40.2', bitrateKbps: 129.553 },
        }),
      ],
    })
    expect(within(card()).getByText('Source: AAC 128 kbps')).toBeDefined()
    expect(within(card()).queryByText('Source: Opus 136 kbps')).toBeNull()
  })

  it('says why an unavailable track cannot be downloaded, and never starts it', async () => {
    await renderCard(<TrackCard track={previewTrack} autoStart />)
    const article = screen.getByRole('article', { name: 'World On Fire' })

    expect(within(article).getByText('Preview only (Go+)')).toBeDefined()
    expect(within(article).getByText("This track can't be downloaded.")).toBeDefined()
    expect(
      within(article).getByText('DJ Scraper has no sign-ins yet; they come in a later version.'),
    ).toBeDefined()
    expect(within(article).queryByText('Source quality shown after download')).toBeNull()
    expect(within(article).queryByRole('button')).toBeNull()
    expect(server.callsTo(CREATE)).toEqual([])
  })

  it('downloads at once, exactly once under StrictMode, then follows the job', async () => {
    queueJobs(FIRST_JOB)
    const { send } = await renderCard(
      <StrictMode>
        <TrackCard track={track} autoStart />
      </StrictMode>,
    )
    expect(within(card()).queryByRole('button', { name: 'Download' })).toBeNull()

    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    expect(server.callsTo(CREATE)).toHaveLength(1)
    expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0]))).toEqual({
      items: [toTrackRef(track)],
      folder: settings.folder,
      options: {
        format: 'mp3',
        filenameTemplate: '{artist} - {title}',
        embedArtwork: true,
        sourceUrlComment: true,
      },
      label: 'The Chill Zone',
    })

    await send({ type: 'jobs.added', batch, jobs: [jobOf(FIRST_JOB)] })
    expect(status().textContent).toBe('Queued')
    await send({
      type: 'jobs.updated',
      jobs: [jobOf(FIRST_JOB, { status: 'downloading', progress: { percent: 12 } })],
    })
    expect(status().textContent).toBe('Downloading')
    expect(within(card()).getByRole('button', { name: 'Cancel' })).toBeDefined()
    expect(server.callsTo(CREATE)).toHaveLength(1)
  })

  it('says it is adding the download while the server answers, without a Download button', () => {
    server.on(CREATE, noAnswer)
    renderWithQueryClient(<TrackCard track={track} autoStart />)

    expect(status().textContent).toBe('Adding to downloads…')
    expect(within(card()).queryByRole('button')).toBeNull()
  })

  it('shows the job a duplicate request maps to', async () => {
    server.on(CREATE, () => json({ jobIds: [FIRST_JOB], duplicates: 1 }))
    const running = jobOf(FIRST_JOB, { status: 'downloading', progress: { percent: 60 } })
    await renderCard(<TrackCard track={track} autoStart />, [running])

    await waitFor(() => expect(status().textContent).toBe('Downloading'))
  })

  it('waits for a click when auto-download is off', async () => {
    queueJobs(FIRST_JOB)
    const user = userEvent.setup()
    await renderCard(<TrackCard track={track} autoStart={false} />)
    expect(server.callsTo(CREATE)).toEqual([])

    await user.click(within(card()).getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    expect(server.callsTo(CREATE)).toHaveLength(1)
  })

  it('says why queuing failed and tries again', async () => {
    let attempt = 0
    server.on(CREATE, () =>
      attempt++ === 0
        ? json(
            {
              error: {
                code: 'folder_unavailable',
                message: 'The folder ~/Music/Gone is no longer there.',
              },
            },
            422,
          )
        : json(created(FIRST_JOB)),
    )
    const user = userEvent.setup()
    await renderCard(<TrackCard track={track} autoStart />)

    const alert = await within(card()).findByRole('alert')
    expect(alert.textContent).toBe(
      'The folder ~/Music/Gone is no longer there.You can pick another folder in the header.',
    )
    await user.click(within(card()).getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    expect(server.callsTo(CREATE)).toHaveLength(2)
  })

  it('downloads again once the job left the list', async () => {
    queueJobs(FIRST_JOB, SECOND_JOB)
    const user = userEvent.setup()
    const { send } = await renderCard(<TrackCard track={track} autoStart />)
    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    const canceled = jobOf(FIRST_JOB, {
      status: 'canceled',
      finishedAt: '2026-10-02T08:01:00.000Z',
    })
    await send({ type: 'jobs.added', batch, jobs: [canceled] })
    await send({ type: 'jobs.removed', ids: [FIRST_JOB], batchIds: [batch.id] })

    await user.click(within(card()).getByRole('button', { name: 'Download again' }))

    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(2))
    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    await send({ type: 'jobs.added', batch, jobs: [jobOf(SECOND_JOB)] })
    expect(status().textContent).toBe('Queued')
  })

  it('downloads again after a failure retrying cannot fix', async () => {
    queueJobs(FIRST_JOB, SECOND_JOB)
    const user = userEvent.setup()
    const { send } = await renderCard(<TrackCard track={track} autoStart />)
    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    const failed = jobOf(FIRST_JOB, {
      status: 'failed',
      error: { code: 'geo_blocked', message: 'Not available in your country.' },
      finishedAt: '2026-10-02T08:01:00.000Z',
    })
    await send({ type: 'jobs.added', batch, jobs: [failed] })
    expect(status().textContent).toBe('FailedNot available in your country.')

    await user.click(within(card()).getByRole('button', { name: 'Download again' }))
    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(2))
  })

  describe('keeps the keyboard focus in the card when the pressed button gives way', () => {
    it('after Download, then Tab goes on to the job', async () => {
      queueJobs(FIRST_JOB)
      const user = userEvent.setup()
      const { send } = await renderCard(<TrackCard track={track} autoStart={false} />)
      within(card()).getByRole('button', { name: 'Download' }).focus()

      await user.keyboard('{Enter}')
      expect(document.activeElement).toBe(downloadArea())
      await waitFor(() => expect(status().textContent).toBe('Queued…'))
      await send({ type: 'jobs.added', batch, jobs: [jobOf(FIRST_JOB)] })
      expect(document.activeElement).toBe(downloadArea())

      await user.tab()
      expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Cancel' }))
    })

    it('after Try again', async () => {
      server.on(CREATE, () =>
        json({ error: { code: 'unknown', message: 'Something broke.' } }, 500),
      )
      const user = userEvent.setup()
      await renderCard(<TrackCard track={track} autoStart />)
      const tryAgain = await within(card()).findByRole('button', { name: 'Try again' })
      tryAgain.focus()

      await user.keyboard('{Enter}')
      expect(document.activeElement).toBe(downloadArea())
      await within(card()).findByRole('button', { name: 'Try again' })
      expect(server.callsTo(CREATE)).toHaveLength(2)
      expect(document.activeElement).toBe(downloadArea())
    })

    it('after Download again', async () => {
      queueJobs(FIRST_JOB, SECOND_JOB)
      const user = userEvent.setup()
      const { send } = await renderCard(<TrackCard track={track} autoStart />)
      await waitFor(() => expect(status().textContent).toBe('Queued…'))
      const failed = jobOf(FIRST_JOB, {
        status: 'failed',
        error: { code: 'geo_blocked', message: 'Not available in your country.' },
        finishedAt: '2026-10-02T08:01:00.000Z',
      })
      await send({ type: 'jobs.added', batch, jobs: [failed] })
      within(card()).getByRole('button', { name: 'Download again' }).focus()

      await user.keyboard('{Enter}')
      expect(document.activeElement).toBe(downloadArea())
      await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(2))
      await send({ type: 'jobs.added', batch, jobs: [jobOf(SECOND_JOB)] })
      expect(document.activeElement).toBe(downloadArea())
    })

    it('but leaves it alone when the download starts by itself', async () => {
      queueJobs(FIRST_JOB)
      await renderCard(<TrackCard track={track} autoStart />)
      await waitFor(() => expect(status().textContent).toBe('Queued…'))
      expect(document.activeElement).toBe(document.body)
    })
  })
})
