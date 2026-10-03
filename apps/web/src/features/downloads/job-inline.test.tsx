import type { Job } from '@dj-scraper/shared'
import { jobsByStatus, testUuid } from '@dj-scraper/shared/test-helpers'
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DownloadsState, downloadsQueryKey } from '@/lib/events.ts'
import { formatClock } from '@/lib/format.ts'
import { batch, jobWith, liveDownloads, snapshotWith } from '@/test/downloads.ts'
import { fakeApi, json, networkError } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { JobInline } from './job-inline.tsx'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  vi.useRealTimers()
  expect(server.unhandled).toEqual([])
})

const JOB_ID = testUuid(30)
const CANCEL = `POST /api/downloads/${JOB_ID}/cancel` as const
const RETRY = `POST /api/downloads/${JOB_ID}/retry` as const
const REVEAL = `POST /api/downloads/${JOB_ID}/reveal` as const

/** The fixtures' job of `status`, as the job the track card waits for. */
const jobAt = (status: Job['status'], fields: Record<string, unknown> = {}): Job =>
  jobWith({ ...jobsByStatus[status], id: JOB_ID, ...fields })

/** JobInline fed by the event stream, which starts with `jobs` in its snapshot. */
async function renderInline(jobs: Job[] = [], onDownloadAgain?: () => void) {
  const rendered = renderWithQueryClient(
    <JobInline jobId={JOB_ID} {...(onDownloadAgain ? { onDownloadAgain } : {})} />,
  )
  const stream = await liveDownloads(rendered.queryClient, snapshotWith({ jobs, batches: [batch] }))
  const update = (job: Job) => stream.send({ type: 'jobs.updated', jobs: [job] })
  return { ...rendered, ...stream, update }
}

/** The live region: the status and the words that come with it. */
const status = () => screen.getByRole('status')

describe('JobInline', () => {
  it('says Queued… until the event stream brings the job, then follows it to done', async () => {
    const { send, update } = await renderInline()
    expect(status().textContent).toBe('Queued…')

    await send({ type: 'jobs.added', batch, jobs: [jobAt('queued')] })
    expect(status().textContent).toBe('Queued')

    await update(jobAt('downloading', { progress: undefined }))
    expect(status().textContent).toBe('Starting…')
    expect(screen.queryByRole('progressbar')).toBeNull()

    await send({
      type: 'job.progress',
      jobId: JOB_ID,
      progress: { percent: 42.5, speedBps: 851_200, etaSec: 3 },
    })
    expect(status().textContent).toBe('Downloading')
    expect(
      screen.getByRole('progressbar', { name: 'Download progress' }).getAttribute('aria-valuenow'),
    ).toBe('42.5')
    // The numbers change twice a second, so they stay out of the live region.
    expect(status().contains(screen.getByText('42 % · 851 kB/s · 0:03 left'))).toBe(false)

    await update(jobAt('processing'))
    expect(status().textContent).toBe('Converting and tagging…')
    expect(screen.queryByRole('progressbar')).toBeNull()

    await update(jobAt('done'))
    expect(status().textContent).toBe('DoneMP3 · 320 kbps · re-encoded from Opus 136 kbps')
    const folder = screen.getByText('~/Music/DJ Scraper/Summer 2026')
    expect(folder.closest('p')?.textContent).toBe('In ~/Music/DJ Scraper/Summer 2026')
    expect(folder.closest('[title]')?.getAttribute('title')).toBe(
      '/Users/dj/Music/DJ Scraper/Summer 2026',
    )
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeDefined()
  })

  it('shows an indeterminate bar while only the size is known', async () => {
    await renderInline([
      jobAt('downloading', { progress: { downloadedBytes: 1_712_128, totalBytes: 4_028_536 } }),
    ])
    const bar = screen.getByRole('progressbar', { name: 'Download progress' })
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getByText('1.7 MB of 4.0 MB')).toBeDefined()
  })

  it('cancels with one click, then offers Retry on the same, still focused button', async () => {
    server.on(CANCEL, () => json(jobAt('downloading', { cancelRequested: true })))
    server.on(RETRY, () => json(jobAt('queued', { attempt: 2 })))
    const user = userEvent.setup()
    const { update } = await renderInline([jobAt('downloading')])

    const button = screen.getByRole('button', { name: 'Cancel' })
    await user.click(button)
    await waitFor(() => expect(server.callsTo(CANCEL)).toHaveLength(1))

    await update(jobAt('downloading', { cancelRequested: true }))
    expect(status().textContent).toBe('Canceling…')
    expect(button.textContent).toBe('Canceling…')
    expect(button.getAttribute('aria-disabled')).toBe('true')

    await update(jobAt('canceled'))
    expect(status().textContent).toBe('Canceled')
    expect(button.textContent).toBe('Retry')
    expect(document.activeElement).toBe(button)

    await user.click(button)
    await waitFor(() => expect(server.callsTo(RETRY)).toHaveLength(1))
  })

  it('explains a job a rate limit sent back to the queue', async () => {
    await renderInline([
      jobAt('queued', {
        lastError: { code: 'rate_limited', message: 'SoundCloud is limiting requests for now.' },
      }),
    ])
    expect(status().textContent).toBe(
      'Rate-limited, retrying soonSoundCloud is limiting requests for now.',
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined()
  })

  it("says why a queued job waits: its platform's pacing or pause, outside the live region", async () => {
    const nextStartAt = '2026-10-02T09:05:00.000Z'
    const pausedUntil = '2026-10-02T09:20:00.000Z'
    const rendered = renderWithQueryClient(<JobInline jobId={JOB_ID} />)
    const { send } = await liveDownloads(
      rendered.queryClient,
      snapshotWith({
        jobs: [jobAt('queued')],
        batches: [batch],
        queue: { platforms: [{ platform: 'youtube', nextStartAt }] },
      }),
    )
    const note = () => document.querySelector('[data-slot="queue-note"]')

    expect(status().textContent).toBe('Queued')
    expect(note()?.textContent).toBe(
      `YouTube: next start at ${formatClock(nextStartAt)} (paced to stay under its limits)`,
    )
    expect(status().contains(note())).toBe(false)

    // Another platform's state says nothing about this job.
    await send({
      type: 'queue.updated',
      queue: { platforms: [{ platform: 'soundcloud', pausedUntil, pauseCode: 'rate_limited' }] },
    })
    expect(note()).toBeNull()

    await send({
      type: 'queue.updated',
      queue: { platforms: [{ platform: 'youtube', pausedUntil, pauseCode: 'rate_limited' }] },
    })
    expect(note()?.textContent).toBe(
      `YouTube paused until ${formatClock(pausedUntil)}: rate-limited (retries on its own)`,
    )

    // Once it runs, the queue no longer holds it back.
    await send({ type: 'jobs.updated', jobs: [jobAt('downloading')] })
    expect(note()).toBeNull()
  })

  it('shows why it failed with a next step, and Retry when a new try may help', async () => {
    const onDownloadAgain = vi.fn()
    await renderInline(
      [
        jobAt('failed', {
          error: { code: 'bot_check', message: "YouTube wants to confirm you're not a bot." },
        }),
      ],
      onDownloadAgain,
    )

    expect(status().textContent).toBe("FailedYouTube wants to confirm you're not a bot.")
    const code = document.querySelector('code')
    expect(code?.textContent).toBe('brew upgrade yt-dlp')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Download again' })).toBeNull()
  })

  it('offers Download again when retrying cannot help', async () => {
    const onDownloadAgain = vi.fn()
    const user = userEvent.setup()
    await renderInline(
      [jobAt('failed', { error: { code: 'age_restricted', message: 'Age-restricted video.' } })],
      onDownloadAgain,
    )

    expect(
      screen.getByText('DJ Scraper has no sign-ins yet; they come in a later version.'),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Download again' }))
    expect(onDownloadAgain).toHaveBeenCalledOnce()
  })

  it("offers Download again beside Retry when the job's folder is gone", async () => {
    const onDownloadAgain = vi.fn()
    const user = userEvent.setup()
    await renderInline(
      [
        jobAt('failed', {
          error: {
            code: 'folder_unavailable',
            message: 'The download folder was moved, renamed or its drive was disconnected.',
          },
        }),
      ],
      onDownloadAgain,
    )

    // Retry saves into the same folder; a new download takes the one in the header.
    expect(screen.queryByText('You can pick another folder in the header.')).toBeNull()
    expect(
      screen.getByText(
        'Reconnect the drive or put the folder back, then retry. Or pick another folder in the header and download again.',
      ),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Download again' }))
    expect(onDownloadAgain).toHaveBeenCalledOnce()
  })

  it("doesn't suggest another format for a failed conversion: Retry keeps the job's", async () => {
    await renderInline([
      jobAt('failed', {
        error: { code: 'postprocess_failed', message: 'ffmpeg failed to convert the file.' },
      }),
    ])
    expect(screen.getByText(/Retry; if it keeps failing, update ffmpeg:/)).toBeDefined()
    expect(screen.queryByText(/another format/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('offers no Download again without a way to start one', async () => {
    await renderInline([
      jobAt('failed', { error: { code: 'private', message: 'This video is private.' } }),
    ])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says when the job left the list, and offers to download it again', async () => {
    const onDownloadAgain = vi.fn()
    const user = userEvent.setup()
    const { send } = await renderInline([jobAt('done')], onDownloadAgain)

    await send({ type: 'jobs.removed', ids: [JOB_ID], batchIds: [batch.id] })

    expect(status().textContent).toBe('No longer in the downloads list')
    await user.click(screen.getByRole('button', { name: 'Download again' }))
    expect(onDownloadAgain).toHaveBeenCalledOnce()
  })

  it('says the file is already there when the download was skipped', async () => {
    await renderInline([jobAt('skipped')])
    expect(status().textContent).toBe(
      'Already in the folderKept the file that was there: Rick Astley - Never Gonna Give You Up.mp3',
    )
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeDefined()
  })

  it('reveals the file, and says when it was moved or deleted', async () => {
    server.on(REVEAL, () => new Response(null, { status: 204 }))
    const user = userEvent.setup()
    await renderInline([jobAt('done')])

    await user.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    await waitFor(() => expect(server.callsTo(REVEAL)).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()

    server.on(REVEAL, () =>
      json({ error: { code: 'not_found', message: 'This download has no file.' } }, 404),
    )
    await user.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The file was moved or deleted.')
  })

  it('says how to start the server when a cancel cannot reach it', async () => {
    server.on(CANCEL, networkError)
    const user = userEvent.setup()
    await renderInline([jobAt('queued')])

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't cancel: Can't reach the DJ Scraper server.")
    expect(alert.querySelector('code')).not.toBeNull()
  })

  it('shows until when the site holds the download, then Starting…', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T08:01:00.000Z') })
    const until = '2026-10-02T08:01:30.000Z'
    const job = jobAt('downloading', { progress: { waitingUntil: until } })
    const { queryClient } = renderWithQueryClient(<JobInline jobId={JOB_ID} />)
    act(() =>
      queryClient.setQueryData<DownloadsState>(downloadsQueryKey, {
        connection: 'open',
        order: [JOB_ID],
        byId: { [JOB_ID]: job },
        batches: {},
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(status().textContent).toBe(`Waiting until ${formatClock(until)} (YouTube)`)

    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(status().textContent).toBe('Starting…')
  })
})
