import { type CreateDownloadsResponse, DownloadRequestSchema, type Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type ReactElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import {
  batch,
  jobWith,
  liveDownloads,
  settings,
  snapshotWith,
  spotifyJob,
  spotifyMatch,
} from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { previewTrack, scTrack, spotifyTrack, track, trackWith } from '@/test/resolve.ts'
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

describe('TrackCard for a Spotify track', () => {
  const spotifyCard = () => screen.getByRole('article', { name: 'Never Gonna Give You Up' })
  const spotifyStatus = () => within(spotifyCard()).getByRole('status')
  const note = () => spotifyCard().querySelector('[data-slot="track-match"]')
  const BEFORE_MATCH =
    'Spotify streams are DRM-protected: DJ Scraper finds this track on YouTube and downloads it from there.'
  /** YouTube's AAC stream (format 140), as the matched video's download reports it. */
  const youtubeAac = { codec: 'mp4a.40.2', bitrateKbps: 129.553 }

  it("shows Spotify's names, cover and duration, and says the audio comes from YouTube", async () => {
    await renderCard(<TrackCard track={spotifyTrack} autoStart={false} />)

    expect(
      within(spotifyCard()).getByRole('heading', { level: 2, name: 'Never Gonna Give You Up' }),
    ).toBeDefined()
    expect(spotifyCard().querySelector('img')?.getAttribute('src')).toBe(spotifyTrack.thumbnailUrl)
    expect(within(spotifyCard()).getByText('Rick Astley')).toBeDefined()
    expect(within(spotifyCard()).getByText('Spotify')).toBeDefined()
    // 213.573 s, rounded as everywhere else.
    expect(within(spotifyCard()).getByText('3:34')).toBeDefined()
    // Spotify names no stream: the quality is YouTube's, known once the download has it.
    expect(within(spotifyCard()).getByText('Source quality shown after download')).toBeDefined()
    expect(note()?.textContent).toBe(BEFORE_MATCH)
    expect(within(spotifyCard()).queryByRole('link')).toBeNull()
  })

  it('queues the Spotify track as it is, then names the YouTube upload it matched, linked', async () => {
    queueJobs(FIRST_JOB)
    const { send } = await renderCard(<TrackCard track={spotifyTrack} autoStart />)
    await waitFor(() => expect(spotifyStatus().textContent).toBe('Queued…'))
    expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0])).items).toEqual([
      toTrackRef(spotifyTrack),
    ])
    expect(toTrackRef(spotifyTrack)).toMatchObject({ platform: 'spotify', url: spotifyTrack.url })

    await send({
      type: 'jobs.added',
      batch,
      jobs: [spotifyJob({ id: FIRST_JOB, status: 'queued' })],
    })
    await send({
      type: 'jobs.updated',
      jobs: [spotifyJob({ id: FIRST_JOB, status: 'downloading' })],
    })
    // The attempt searches YouTube first, which can take a few seconds.
    expect(spotifyStatus().textContent).toBe('Finding it on YouTube…')
    expect(note()?.textContent).toBe(BEFORE_MATCH)

    await send({
      type: 'jobs.updated',
      jobs: [spotifyJob({ id: FIRST_JOB, status: 'downloading', match: spotifyMatch })],
    })
    expect(spotifyStatus().textContent).toBe('Starting…')
    expect(note()?.textContent).toBe(
      'Audio from YouTube: Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) (opens in a new tab) · Rick Astley',
    )
    const link = within(spotifyCard()).getByRole('link', {
      name: /^Rick Astley - Never Gonna Give You Up \(Official Video\) \(4K Remaster\) ?\(opens in a new tab\)$/,
    })
    expect(link.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')

    await send({
      type: 'jobs.updated',
      jobs: [
        spotifyJob({
          id: FIRST_JOB,
          status: 'downloading',
          match: spotifyMatch,
          source: youtubeAac,
          progress: { percent: 40 },
        }),
      ],
    })
    expect(spotifyStatus().textContent).toBe('Downloading')
    // The stream the file really comes from: YouTube's, never presented as Spotify's.
    expect(within(spotifyCard()).getByText('Source: YouTube AAC 128 kbps')).toBeDefined()
  })

  it("says a finished file's stream was YouTube's", async () => {
    server.on(CREATE, () => json({ jobIds: [FIRST_JOB], duplicates: 1 }))
    const done = spotifyJob({
      id: FIRST_JOB,
      status: 'done',
      format: 'm4a',
      match: spotifyMatch,
      source: youtubeAac,
      startedAt: '2026-10-02T08:00:05.000Z',
      outputPath: '/Users/dj/Music/DJ Scraper/Rick Astley - Never Gonna Give You Up.m4a',
      output: { ext: 'm4a', codec: 'aac', bitrateKbps: 129.553, channels: 2, encoded: false },
      finishedAt: '2026-10-02T08:01:00.000Z',
    })
    await renderCard(<TrackCard track={spotifyTrack} autoStart />, [done])

    await waitFor(() =>
      expect(spotifyStatus().textContent).toBe('DoneM4A · AAC 128 kbps · copied from YouTube'),
    )
    expect(within(spotifyCard()).getByRole('link').getAttribute('href')).toBe(spotifyMatch.url)
  })

  it('says when no YouTube upload matches, with a way out, and retries once asked', async () => {
    queueJobs(FIRST_JOB)
    server.on(`POST /api/downloads/${FIRST_JOB}/retry`, () =>
      json(spotifyJob({ id: FIRST_JOB, status: 'queued', attempt: 2 })),
    )
    const user = userEvent.setup()
    const { send } = await renderCard(<TrackCard track={spotifyTrack} autoStart />)
    await waitFor(() => expect(spotifyStatus().textContent).toBe('Queued…'))
    const failed = spotifyJob({
      id: FIRST_JOB,
      status: 'failed',
      startedAt: '2026-10-02T08:00:05.000Z',
      error: {
        code: 'no_match',
        message: "No YouTube upload matches this Spotify track's artist, title and length.",
      },
      finishedAt: '2026-10-02T08:00:20.000Z',
    })
    await send({ type: 'jobs.added', batch, jobs: [failed] })

    expect(spotifyStatus().textContent).toBe(
      "FailedNo YouTube upload matches this Spotify track's artist, title and length.",
    )
    expect(
      within(spotifyCard()).getByText(
        'Find the track on YouTube or SoundCloud and paste that link instead.',
      ),
    ).toBeDefined()
    // YouTube's results change, so the job's own Retry stays (not "Download again").
    expect(within(spotifyCard()).queryByRole('button', { name: 'Download again' })).toBeNull()
    await user.click(within(spotifyCard()).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${FIRST_JOB}/retry`)).toHaveLength(1),
    )
  })

  it('shows no Spotify note for a YouTube or SoundCloud track', async () => {
    await renderCard(<TrackCard track={track} autoStart={false} />)
    expect(card().querySelector('[data-slot="track-match"]')).toBeNull()
  })
})
