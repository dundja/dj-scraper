import { type CreateDownloadsResponse, DownloadRequestSchema, type Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { act, screen, waitFor, within } from '@testing-library/react'
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
type User = ReturnType<typeof userEvent.setup>
/** Presses the card's Download button (the only one before the download is queued). */
const clickDownload = (user: User) => user.click(screen.getByRole('button', { name: 'Download' }))
const status = () => within(card()).getByRole('status')
/** The card's download area, which keeps the focus while a pressed button gives way. */
const downloadArea = () => {
  const area = card().querySelector<HTMLElement>('[data-slot="track-download"]')
  if (area === null) throw new Error('No download area')
  return area
}

describe('TrackCard', () => {
  it('shows the artwork, title, artist, duration, platform and source quality', async () => {
    await renderCard(<TrackCard track={track} />)

    expect(within(card()).getByRole('heading', { level: 2, name: 'The Chill Zone' })).toBeDefined()
    expect(card().querySelector('img')?.getAttribute('src')).toBe(track.thumbnailUrl)
    expect(within(card()).getByText('Royalty Free Music')).toBeDefined()
    expect(within(card()).getByText('4:27')).toBeDefined()
    expect(within(card()).getByText('YouTube')).toBeDefined()
    // yt-dlp measures 129.553 kbps for YouTube's nominal 128 kbps AAC stream.
    expect(within(card()).getByText('Source: AAC 128 kbps')).toBeDefined()
  })

  it("shows a SoundCloud track's MP3 source", async () => {
    await renderCard(<TrackCard track={scTrack} />)
    const article = screen.getByRole('article', { name: 'Robo Kitty' })
    expect(within(article).getByText('SoundCloud')).toBeDefined()
    expect(within(article).getByText('Source: MP3 128 kbps')).toBeDefined()
    expect(within(article).getByText('4:05')).toBeDefined()
  })

  it('names the uploader when there is no artist, and says when the source is unknown', async () => {
    const bare = trackWith({ artist: undefined, source: undefined, durationSec: undefined })
    await renderCard(<TrackCard track={bare} />)

    expect(within(card()).getByText('Royalty Free Music Crew')).toBeDefined()
    expect(within(card()).getByText('Source quality shown after download')).toBeDefined()
    expect(within(card()).queryByText(/Duration/)).toBeNull()
  })

  it('names the stream the download really fetched once the job reports it', async () => {
    // Resolve's best guess is YouTube's Opus stream; an M4A download takes the AAC one instead.
    const opus = trackWith({ source: { codec: 'opus', bitrateKbps: 136 } })
    queueJobs(FIRST_JOB)
    const user = userEvent.setup()
    const { send } = await renderCard(<TrackCard track={opus} />)
    expect(within(card()).getByText('Source: Opus 136 kbps')).toBeDefined()
    await clickDownload(user)
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
    await renderCard(<TrackCard track={previewTrack} />)
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

  it('waits for Download, then queues the track once under StrictMode and follows the job', async () => {
    queueJobs(FIRST_JOB)
    const user = userEvent.setup()
    const { send } = await renderCard(
      <StrictMode>
        <TrackCard track={track} />
      </StrictMode>,
    )
    const download = within(card()).getByRole('button', { name: 'Download' })
    expect(download.getAttribute('aria-keyshortcuts')).toBe('Meta+D')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toEqual([])

    await user.click(download)
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

  it('says it is adding the download while the server answers, without a Download button', async () => {
    server.on(CREATE, noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<TrackCard track={track} />)
    await clickDownload(user)

    expect(status().textContent).toBe('Adding to downloads…')
    expect(within(card()).queryByRole('button')).toBeNull()
  })

  it('shows the job a duplicate request maps to', async () => {
    server.on(CREATE, () => json({ jobIds: [FIRST_JOB], duplicates: 1 }))
    const running = jobOf(FIRST_JOB, { status: 'downloading', progress: { percent: 60 } })
    const user = userEvent.setup()
    await renderCard(<TrackCard track={track} />, [running])
    await clickDownload(user)

    await waitFor(() => expect(status().textContent).toBe('Downloading'))
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
    await renderCard(<TrackCard track={track} />)
    await clickDownload(user)

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
    const { send } = await renderCard(<TrackCard track={track} />)
    await clickDownload(user)
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
    const { send } = await renderCard(<TrackCard track={track} />)
    await clickDownload(user)
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
      const { send } = await renderCard(<TrackCard track={track} />)
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
      await renderCard(<TrackCard track={track} />)
      await clickDownload(user)
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
      const { send } = await renderCard(<TrackCard track={track} />)
      await clickDownload(user)
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
  })
})

describe('TrackCard: ⌘D', () => {
  /** A ⌘D keydown on `target`, as the browser sends it; false when the app took it. */
  const pressCommandD = (target: Element = document.body, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: 'd',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    act(() => {
      target.dispatchEvent(event)
    })
    return !event.defaultPrevented
  }

  it('downloads like the button, without opening the bookmark dialog or moving the focus', async () => {
    queueJobs(FIRST_JOB)
    const user = userEvent.setup()
    await renderCard(<TrackCard track={track} />)

    await user.keyboard('{Meta>}d{/Meta}')

    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    expect(server.callsTo(CREATE)).toHaveLength(1)
    expect(DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0])).items).toEqual([
      toTrackRef(track),
    ])
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps the bookmark dialog shut and moves the focus off the Download button it replaces', async () => {
    queueJobs(FIRST_JOB)
    await renderCard(<TrackCard track={track} />)
    const download = within(card()).getByRole('button', { name: 'Download' })
    download.focus()

    expect(pressCommandD(download)).toBe(false)

    expect(document.activeElement).toBe(downloadArea())
    await waitFor(() => expect(status().textContent).toBe('Queued…'))
  })

  it('takes Ctrl+D too, but not with Shift or Option', async () => {
    queueJobs(FIRST_JOB)
    await renderCard(<TrackCard track={track} />)

    expect(pressCommandD(document.body, { shiftKey: true })).toBe(true)
    expect(pressCommandD(document.body, { altKey: true })).toBe(true)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toEqual([])

    expect(pressCommandD(document.body, { metaKey: false, ctrlKey: true })).toBe(false)
    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
  })

  it('is ignored inside another text field', async () => {
    const user = userEvent.setup()
    await renderCard(
      <>
        <input aria-label="Notes" />
        <TrackCard track={track} />
      </>,
    )
    await user.click(screen.getByRole('textbox', { name: 'Notes' }))

    await user.keyboard('{Meta>}d{/Meta}')
    expect(pressCommandD(screen.getByRole('textbox', { name: 'Notes' }))).toBe(true)

    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toEqual([])
    expect(within(card()).getByRole('button', { name: 'Download' })).toBeDefined()
  })

  it('works in a field marked for it (the link box)', async () => {
    queueJobs(FIRST_JOB)
    await renderCard(
      <>
        <input aria-label="Link" data-download-shortcut="" />
        <TrackCard track={track} />
      </>,
    )
    const box = screen.getByRole('textbox', { name: 'Link' })
    box.focus()

    // Ctrl+D edits text there on macOS (it deletes forward), so only ⌘D counts.
    expect(pressCommandD(box, { metaKey: false, ctrlKey: true })).toBe(true)
    expect(pressCommandD(box)).toBe(false)

    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
    expect(document.activeElement).toBe(box)
  })

  it('does nothing while the download is being added or its job runs', async () => {
    let answer = (_response: Response) => {}
    server.on(CREATE, () => new Promise<Response>((resolve) => (answer = resolve)))
    const { send } = await renderCard(<TrackCard track={track} />)

    expect(pressCommandD()).toBe(false)
    await waitFor(() => expect(status().textContent).toBe('Adding to downloads…'))
    expect(pressCommandD()).toBe(false)

    answer(json(created(FIRST_JOB)))
    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    await send({
      type: 'jobs.added',
      batch,
      jobs: [jobOf(FIRST_JOB, { status: 'downloading', progress: { percent: 30 } })],
    })
    expect(status().textContent).toBe('Downloading')
    // Still the app's: the bookmark dialog stays shut, and no second download goes out.
    expect(pressCommandD()).toBe(false)

    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toHaveLength(1)
  })

  it('ignores a held key: a repeat press downloads nothing, but stays the app’s', async () => {
    await renderCard(<TrackCard track={track} />)

    // While Download shows: only a fresh press would add it.
    expect(pressCommandD(document.body, { repeat: true })).toBe(false)

    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toEqual([])
    expect(within(card()).getByRole('button', { name: 'Download' })).toBeDefined()
  })

  it('tries again after a failed attempt', async () => {
    let attempt = 0
    server.on(CREATE, () =>
      attempt++ === 0
        ? json({ error: { code: 'unknown', message: 'Something broke.' } }, 500)
        : json(created(FIRST_JOB)),
    )
    await renderCard(<TrackCard track={track} />)

    pressCommandD()
    await within(card()).findByRole('button', { name: 'Try again' })
    pressCommandD()

    await waitFor(() => expect(status().textContent).toBe('Queued…'))
    expect(server.callsTo(CREATE)).toHaveLength(2)
  })

  it('never downloads an unavailable track', async () => {
    await renderCard(<TrackCard track={previewTrack} />)

    pressCommandD()

    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    expect(server.callsTo(CREATE)).toEqual([])
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
    await renderCard(<TrackCard track={spotifyTrack} />)

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
    const user = userEvent.setup()
    const { send } = await renderCard(<TrackCard track={spotifyTrack} />)
    await clickDownload(user)
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
    const user = userEvent.setup()
    await renderCard(<TrackCard track={spotifyTrack} />, [done])
    await clickDownload(user)

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
    const { send } = await renderCard(<TrackCard track={spotifyTrack} />)
    await clickDownload(user)
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
    await renderCard(<TrackCard track={track} />)
    expect(card().querySelector('[data-slot="track-match"]')).toBeNull()
  })
})
