import type { Job } from '@dj-scraper/shared'
import { jobsByStatus, youtubeRef } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { startCommand } from '@/features/engine/start-command.ts'
import { downloadsQueryKey } from '@/lib/events.ts'
import { formatClock } from '@/lib/format.ts'
import { doneJob, downloadingJob, failedJob, jobWith, queuedJob } from '@/test/downloads.ts'
import { fakeApi, json, networkError, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { JOB_ROW_HEIGHT } from './job-layout.ts'
import { JobRow } from './job-row.tsx'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  vi.useRealTimers()
  expect(server.unhandled).toEqual([])
})

const TITLE = youtubeRef.title
const canceledJob = jobWith(jobsByStatus.canceled)
const skippedJob = jobWith(jobsByStatus.skipped)

/** A JobRow under a fresh QueryClient; `update` re-renders it with the job's next state. */
function renderRow(job: Job, wrap: (row: ReactElement) => ReactElement = (row) => row) {
  const rendered = renderWithQueryClient(wrap(<JobRow job={job} />))
  const update = (next: Job) =>
    rendered.rerender(
      <QueryClientProvider client={rendered.queryClient}>
        {wrap(<JobRow job={next} />)}
      </QueryClientProvider>,
    )
  return { ...rendered, update }
}

function row(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="job-row"]')
  if (element === null) throw new Error('No job row')
  return element
}

/** The status line, as a screen reader reads it (with the phase it may say first). */
function statusLine(): HTMLElement {
  const lines = row().querySelectorAll('p')
  const line = lines[lines.length - 1]
  if (line === undefined) throw new Error('No status line')
  return line
}

const reply = (job: Job) => () => json(job)

/** What assistive tech reads after a control's name: the text of its aria-describedby ids. */
function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

const botCheck = jobWith({
  ...jobsByStatus.failed,
  error: { code: 'bot_check', message: "YouTube wants to confirm you're not a bot." },
})
const BOT_CHECK_HINT = 'Updating yt-dlp usually fixes this: brew upgrade yt-dlp.'

describe('JobRow', () => {
  it('is exactly JOB_ROW_HEIGHT tall, with the artwork, title and artist', () => {
    renderRow(queuedJob)

    expect(row().style.height).toBe(`${JOB_ROW_HEIGHT}px`)
    expect(row().querySelector('img')?.getAttribute('src')).toBe(youtubeRef.thumbnailUrl)
    expect(row().querySelector('p')?.textContent).toBe(`${TITLE} · Rick Astley`)
    expect(statusLine().textContent).toBe('Queued')
  })

  it('names a set row by its platform and id until its title is known', () => {
    renderRow(failedJob)
    expect(row().querySelector('p')?.textContent).toBe('SoundCloud track 1234567893')
    expect(row().querySelector('[data-slot="artwork"]')?.tagName).toBe('DIV')
  })

  it('shows a thin progress bar and the numbers while downloading', () => {
    renderRow(downloadingJob)

    const bar = screen.getByRole('progressbar', { name: `${TITLE}: downloaded` })
    expect(bar.getAttribute('aria-valuenow')).toBe('42.5')
    expect(statusLine().textContent).toBe('Downloading: 42 % · 851 kB/s · 0:03 left')
  })

  it('says what the finished file is and where it came from', () => {
    renderRow(doneJob)

    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(statusLine().textContent).toBe('Done: MP3 · 320 kbps · re-encoded from Opus 136 kbps')
  })

  it("shows a failure's message in red, and a requeued job's reason in amber", () => {
    const { update } = renderRow(failedJob)
    expect(statusLine().textContent).toBe('Failed: The connection dropped. Retry to try again.')
    expect(statusLine().className).toContain('text-destructive')

    update(
      jobWith({
        ...jobsByStatus.queued,
        lastError: { code: 'rate_limited', message: 'SoundCloud is limiting requests.' },
      }),
    )
    expect(statusLine().textContent).toBe(
      'Rate-limited, retrying soon: SoundCloud is limiting requests.',
    )
    expect(statusLine().className).toContain('text-warning')
  })

  it('cancels with one click, and leaves the downloads cache to the event stream', async () => {
    const asked = jobWith({ ...jobsByStatus.downloading, cancelRequested: true })
    server.on(`POST /api/downloads/${downloadingJob.id}/cancel`, reply(asked))
    const user = userEvent.setup()
    const { queryClient } = renderRow(downloadingJob)

    await user.click(screen.getByRole('button', { name: `Cancel ${TITLE}` }))

    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${downloadingJob.id}/cancel`)).toHaveLength(1),
    )
    expect(queryClient.getQueryData(downloadsQueryKey)).toBeUndefined()
  })

  it('is busy while the request is out, so a double click sends one request', async () => {
    server.on(`POST /api/downloads/${queuedJob.id}/cancel`, noAnswer)
    const user = userEvent.setup()
    renderRow(queuedJob)

    const button = screen.getByRole('button', { name: `Cancel ${TITLE}` })
    await user.dblClick(button)

    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(server.callsTo(`POST /api/downloads/${queuedJob.id}/cancel`)).toHaveLength(1)
  })

  it('shows a cancel underway as busy and sends nothing more', async () => {
    const user = userEvent.setup()
    renderRow(jobWith({ ...jobsByStatus.downloading, cancelRequested: true }))

    expect(statusLine().textContent).toBe('Canceling…')
    const button = screen.getByRole('button', { name: `Canceling ${TITLE}…` })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await user.click(button)
    // No route is set: a request would show up in `server.unhandled`.
  })

  it('retries a canceled job and a failure a new try may fix', async () => {
    server.on(`POST /api/downloads/${canceledJob.id}/retry`, reply(queuedJob))
    server.on(`POST /api/downloads/${failedJob.id}/retry`, reply(queuedJob))
    const user = userEvent.setup()
    const { update } = renderRow(canceledJob)

    await user.click(screen.getByRole('button', { name: `Retry ${TITLE}` }))
    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${canceledJob.id}/retry`)).toHaveLength(1),
    )

    update(failedJob)
    await user.click(screen.getByRole('button', { name: 'Retry SoundCloud track 1234567893' }))
    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${failedJob.id}/retry`)).toHaveLength(1),
    )
  })

  it('shows the next step when hovering a failure, its commands without backticks', () => {
    renderRow(
      jobWith({
        ...jobsByStatus.failed,
        error: { code: 'bot_check', message: "YouTube wants to confirm you're not a bot." },
      }),
    )
    expect(statusLine().title).toBe(
      "YouTube wants to confirm you're not a bot.\nUpdating yt-dlp usually fixes this: brew upgrade yt-dlp.",
    )
  })

  it("describes a failure's Retry with its whole message and next step, also in its tooltip", async () => {
    const user = userEvent.setup()
    renderRow(botCheck, (row) => <TooltipProvider delay={0}>{row}</TooltipProvider>)
    const button = screen.getByRole('button', { name: 'Retry SoundCloud track 1234567893' })

    expect(description(button)).toBe(
      `Failed: YouTube wants to confirm you're not a bot. ${BOT_CHECK_HINT}`,
    )
    // Also read in the row, for a failure with no button.
    expect(row().textContent).toContain(BOT_CHECK_HINT)

    // The line is cut to fit; the keyboard reaches it all through the button's tooltip.
    await user.tab()
    expect(document.activeElement).toBe(button)
    const tooltip = await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
      if (content === null) throw new Error('No tooltip')
      return content
    })
    expect(tooltip.textContent).toBe(
      `RetryYouTube wants to confirm you're not a bot.${BOT_CHECK_HINT}`,
    )
    expect(tooltip.querySelector('code')?.textContent).toBe('brew upgrade yt-dlp')
  })

  it('describes only a failure, not a job doing well', () => {
    renderRow(doneJob)
    const button = screen.getByRole('button', { name: `Reveal ${TITLE} in Finder` })
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  it("says Retry needs the job's own folder back, not another one", () => {
    renderRow(
      jobWith({
        ...jobsByStatus.failed,
        error: { code: 'folder_unavailable', message: 'The download folder was moved.' },
      }),
    )
    const button = screen.getByRole('button', { name: 'Retry SoundCloud track 1234567893' })
    expect(description(button)).toBe(
      'Failed: The download folder was moved. Reconnect the drive or put the folder back, then retry.',
    )
    expect(row().textContent).not.toContain('pick another folder')
  })

  it('offers nothing for a failure retrying cannot fix', () => {
    renderRow(
      jobWith({
        ...jobsByStatus.failed,
        error: { code: 'private', message: 'This video is private.' },
      }),
    )
    expect(statusLine().textContent).toBe('Failed: This video is private.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    ['done', doneJob],
    ['skipped', skippedJob],
  ])('reveals a %s file in Finder', async (_, job) => {
    server.on(`POST /api/downloads/${job.id}/reveal`, () => new Response(null, { status: 204 }))
    const user = userEvent.setup()
    renderRow(job)

    await user.click(screen.getByRole('button', { name: `Reveal ${TITLE} in Finder` }))

    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${job.id}/reveal`)).toHaveLength(1),
    )
    expect(statusLine().className).not.toContain('text-destructive')
  })

  it('says the file was moved or deleted when Finder has nothing to show', async () => {
    server.on(`POST /api/downloads/${doneJob.id}/reveal`, () =>
      json({ error: { code: 'not_found', message: 'This download has no file.' } }, 404),
    )
    const user = userEvent.setup()
    renderRow(doneJob)

    await user.click(screen.getByRole('button', { name: `Reveal ${TITLE} in Finder` }))

    await waitFor(() =>
      expect(statusLine().textContent).toBe('Done: The file was moved or deleted.'),
    )
    expect(statusLine().className).toContain('text-destructive')
    // The focus stays on the button, so the row announces it.
    expect(screen.getByRole('alert').textContent).toBe(`${TITLE}: The file was moved or deleted.`)
  })

  it("announces a cancel that didn't reach the server, with how to start it", async () => {
    server.on(`POST /api/downloads/${queuedJob.id}/cancel`, networkError)
    const user = userEvent.setup()
    renderRow(queuedJob)

    await user.click(screen.getByRole('button', { name: `Cancel ${TITLE}` }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      `${TITLE}: Couldn't cancel: Can't reach the DJ Scraper server. Start it with ${startCommand()} in the project folder.`,
    )
  })

  it('announces nothing while its actions go well', () => {
    renderRow(downloadingJob)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("names the action in a tooltip, the button's name carrying the title", async () => {
    const user = userEvent.setup()
    renderRow(doneJob, (row) => <TooltipProvider delay={0}>{row}</TooltipProvider>)

    await user.hover(screen.getByRole('button', { name: `Reveal ${TITLE} in Finder` }))

    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
        'Reveal in Finder',
      ),
    )
  })

  it('keeps keyboard focus on its button when Cancel turns into Retry', async () => {
    server.on(`POST /api/downloads/${canceledJob.id}/cancel`, reply(canceledJob))
    const user = userEvent.setup()
    const { update } = renderRow(jobWith({ ...jobsByStatus.queued, id: canceledJob.id }))

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Cancel ${TITLE}` }))
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(server.callsTo(`POST /api/downloads/${canceledJob.id}/cancel`)).toHaveLength(1),
    )

    update(canceledJob)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Retry ${TITLE}` }))
  })

  it('turns a wait into Starting… when its time comes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T08:01:00.000Z') })
    const until = '2026-10-02T08:02:00.000Z'
    renderRow(jobWith({ ...jobsByStatus.downloading, progress: { waitingUntil: until } }))

    expect(statusLine().textContent).toBe(`Waiting until ${formatClock(until)} (YouTube)`)
    await act(() => vi.advanceTimersByTimeAsync(59_000))
    expect(statusLine().textContent).toContain('Waiting until')

    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(statusLine().textContent).toBe('Starting…')
  })
})
