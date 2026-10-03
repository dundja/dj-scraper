import { type Batch, BatchSchema, type Job } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { startCommand } from '@/features/engine/start-command.ts'
import { downloadsQueryKey } from '@/lib/events.ts'
import { formatClock } from '@/lib/format.ts'
import {
  batch,
  doneJob,
  downloadingJob,
  failedJob,
  jobWith,
  liveDownloads,
  queuedJob,
  snapshotWith,
} from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, networkError } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { DownloadsPanel } from './downloads-panel.tsx'
import { JOB_ROW_HEIGHT } from './job-layout.ts'
import { BATCH_ROW_HEIGHT } from './panel-rows.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  vi.useRealTimers()
  // The panel only reads what the event stream wrote, and sends nothing but the bulk actions.
  expect(server.unhandled).toEqual([])
})

const LIST_HEIGHT = 600

/**
 * jsdom lays nothing out, so every element is 0 px tall and the virtualizer would render no rows:
 * give the list's scroller a height (the virtualizer reads offsetHeight and offsetWidth).
 */
function layOutList() {
  const size = (px: number) =>
    function (this: HTMLElement) {
      return this.dataset.slot === 'downloads-list' ? px : 0
    }
  const height = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(size(LIST_HEIGHT))
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(size(384))
  onTestFinished(() => {
    height.mockRestore()
    width.mockRestore()
  })
}

/** Renders the panel and feeds it `snapshot` through the real event stream. */
async function renderPanel(snapshot = snapshotWith()) {
  layOutList()
  const rendered = renderWithQueryClient(<DownloadsPanel />)
  const stream = await liveDownloads(rendered.queryClient, snapshot)
  return { ...rendered, ...stream }
}

const list = () => screen.getByRole('list', { name: 'Downloads by batch' })
const rowTexts = () =>
  within(list())
    .getAllByRole('listitem')
    .map((row) => row.textContent)
/** The alert of a failed bulk action (job rows may have alerts of their own), if any. */
const actionAlert = () =>
  screen.queryAllByRole('alert').find((alert) => alert.textContent?.startsWith("Couldn't"))
const findActionAlert = () =>
  vi.waitFor(() => {
    const alert = actionAlert()
    if (alert === undefined) throw new Error('No bulk action alert')
    return alert
  })

/** The counts line under the panel's heading, a live region. */
const counts = () => {
  const header = document.querySelector<HTMLElement>('[data-slot="downloads-header"]')
  if (header === null) throw new Error('No panel header')
  return within(header).getByRole('status')
}

const otherBatch: Batch = BatchSchema.parse({
  id: testUuid(101),
  label: 'Warm-up set',
  folder: '/Volumes/USB/Warm-up set',
  format: 'aiff',
  createdAt: '2026-10-02T09:00:00.000Z',
})
const finishedAt = '2026-10-02T09:01:00.000Z'

/** A queued job with its own title, so rows can be told apart. */
const titled = (n: number, inBatch: Batch = batch): Job =>
  jobWith(
    {
      id: testUuid(n),
      status: 'queued',
      track: {
        platform: 'youtube',
        id: `video${n}`,
        url: `https://www.youtube.com/watch?v=video${n}`,
        title: `Track ${n}`,
      },
    },
    inBatch,
  )

describe('DownloadsPanel: loading and empty', () => {
  it('shows the shape of the panel until the first snapshot arrives', async () => {
    layOutList()
    const { queryClient } = renderWithQueryClient(<DownloadsPanel />)

    expect(screen.getByRole('heading', { name: 'Downloads', level: 2 })).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe('Loading downloads…')
    expect(screen.queryByRole('list')).toBeNull()

    await liveDownloads(queryClient)
    expect(screen.queryByText('Loading downloads…')).toBeNull()
    expect(screen.getByRole('list', { name: 'Downloads by batch' })).toBeDefined()
  })

  it('says nothing is downloading yet when the server has no jobs', async () => {
    await renderPanel(snapshotWith({ jobs: [], batches: [] }))

    expect(screen.getByText('Nothing downloading yet')).toBeDefined()
    expect(screen.getByText('Paste a link to start.')).toBeDefined()
    expect(counts().textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Actions for all downloads' })).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})

describe('DownloadsPanel: header', () => {
  it('counts the jobs and shows the overall progress of the running batches', async () => {
    await renderPanel()

    // queued 0 + downloading 42.5 % × 0.9 + done 1 + failed 1, over 4 jobs: 59 %.
    expect(counts().textContent).toBe('1 done · 1 failed · 2 left')
    const overall = screen.getByRole('progressbar', { name: 'Overall progress' })
    expect(overall.getAttribute('aria-valuenow')).toBe('59')
    expect(overall.getAttribute('aria-valuetext')).toBe('59% done, 2 left')
  })

  it('announces each job that finishes, and follows the progress events', async () => {
    const { send } = await renderPanel()

    await send({ type: 'job.progress', jobId: downloadingJob.id, progress: { percent: 100 } })
    // 0 + 0.9 + 1 + 1 over 4: 72 %.
    expect(
      screen.getByRole('progressbar', { name: 'Overall progress' }).getAttribute('aria-valuenow'),
    ).toBe('72')

    const done = jobWith({ ...doneJob, id: downloadingJob.id })
    await send({ type: 'jobs.updated', jobs: [done] })
    expect(counts().textContent).toBe('2 done · 1 failed · 1 left')
    expect(counts().getAttribute('role')).toBe('status')
  })

  it('shows each finished job at once, but speaks a burst of them once, within 3 s', async () => {
    vi.useFakeTimers()
    const { send } = await renderPanel()
    const shown = () =>
      document.querySelector('[data-slot="downloads-header"] p[aria-hidden]')?.textContent

    await send({ type: 'jobs.updated', jobs: [jobWith({ ...doneJob, id: downloadingJob.id })] })
    expect(counts().textContent).toBe('2 done · 1 failed · 1 left')

    await send({ type: 'jobs.updated', jobs: [jobWith({ ...doneJob, id: queuedJob.id })] })
    expect(shown()).toBe('3 done · 1 failed')
    expect(counts().textContent).toBe('2 done · 1 failed · 1 left')

    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(counts().textContent).toBe('3 done · 1 failed')
  })

  it('drops the overall bar once every batch has finished, keeping the counts', async () => {
    await renderPanel(snapshotWith({ jobs: [doneJob, failedJob] }))

    expect(counts().textContent).toBe('1 done · 1 failed')
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('measures only the batches still at work, not the history before them', async () => {
    const old = Array.from({ length: 9 }, (_, i) =>
      jobWith({ id: testUuid(200 + i), status: 'canceled', finishedAt }, otherBatch),
    )
    await renderPanel(snapshotWith({ jobs: [...old, queuedJob], batches: [otherBatch, batch] }))

    expect(counts().textContent).toBe('9 canceled · 1 left')
    expect(
      screen.getByRole('progressbar', { name: 'Overall progress' }).getAttribute('aria-valuenow'),
    ).toBe('0')
  })
})

describe('DownloadsPanel: overall progress', () => {
  const overall = () =>
    screen.getByRole('progressbar', { name: 'Overall progress' }).getAttribute('aria-valuenow')
  const playlistA = (n: number, fields: Record<string, unknown>) =>
    jobWith({ ...doneJob, id: testUuid(400 + n), batchId: otherBatch.id, ...fields })

  it('keeps a batch that finishes in the bar until nothing is at work, so it never drops', async () => {
    // Playlist A at 19.45 of 20 when a single track was queued after it: 19.45 of 21, 92 %.
    const done = Array.from({ length: 19 }, (_, i) => playlistA(i, {}))
    const last = jobWith(
      {
        id: testUuid(419),
        status: 'downloading',
        startedAt: finishedAt,
        progress: { percent: 50 },
      },
      otherBatch,
    )
    const { send } = await renderPanel(
      snapshotWith({ jobs: [...done, last, queuedJob], batches: [otherBatch, batch] }),
    )
    expect(overall()).toBe('92')

    // A's last job finishes: 20 of 21, not 0 of 1 for the single track alone.
    await send({ type: 'jobs.updated', jobs: [playlistA(19, {})] })
    expect(overall()).toBe('95')

    // Once nothing is at work the bar goes, and the next batch starts it from zero.
    await send({ type: 'jobs.updated', jobs: [jobWith({ ...doneJob, id: queuedJob.id })] })
    expect(screen.queryByRole('progressbar', { name: 'Overall progress' })).toBeNull()
    const next = BatchSchema.parse({ ...batch, id: testUuid(102), label: 'Next' })
    await send({ type: 'jobs.added', batch: next, jobs: [titled(5, next)] })
    expect(overall()).toBe('0')
  })
})

describe('DownloadsPanel: list', () => {
  it('lists the batches newest first, each with its jobs in creation order', async () => {
    const jobs = [titled(1), titled(2), titled(3, otherBatch)]
    await renderPanel(snapshotWith({ jobs, batches: [batch, otherBatch] }))

    expect(
      within(list())
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Warm-up set', 'Summer 2026'])
    const rows = rowTexts()
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('Warm-up set')
    expect(rows[1]).toContain('Track 3')
    expect(rows[2]).toContain('Summer 2026')
    expect(rows[3]).toContain('Track 1')
    expect(rows[4]).toContain('Track 2')
  })

  it('heads a batch with its name, folder, format, finished count and own progress', async () => {
    const { label: _, ...unlabeled } = otherBatch
    await renderPanel(
      snapshotWith({
        jobs: [queuedJob, downloadingJob, doneJob, failedJob, titled(3, otherBatch)],
        batches: [batch, BatchSchema.parse(unlabeled)],
      }),
    )
    const [single, summer] = within(list())
      .getAllByRole('listitem')
      .filter((row) => row.querySelector('h3') !== null)

    expect(within(single as HTMLElement).getByRole('heading').textContent).toBe('Single track')
    expect(single?.textContent).toContain('/Volumes/USB/Warm-up set · AIFF')
    expect(single?.textContent).toContain('0 of 1 finished')

    expect(summer?.textContent).toContain('~/Music/DJ Scraper/Summer 2026 · MP3')
    expect(within(summer as HTMLElement).getByText('2/4')).toBeDefined()
    expect(summer?.textContent).toContain('2 of 4 finished')
    const progress = within(summer as HTMLElement).getByRole('progressbar', {
      name: 'Progress of Summer 2026',
    })
    expect(progress.getAttribute('aria-valuenow')).toBe('59')
  })

  it('positions every row by its fixed height and numbers it within the whole list', async () => {
    await renderPanel(snapshotWith({ jobs: [titled(1), titled(2)], batches: [batch] }))
    const rows = within(list()).getAllByRole('listitem')

    expect(rows.map((row) => row.style.height)).toEqual([
      `${BATCH_ROW_HEIGHT}px`,
      `${JOB_ROW_HEIGHT}px`,
      `${JOB_ROW_HEIGHT}px`,
    ])
    expect(rows.map((row) => row.style.transform)).toEqual([
      'translateY(0px)',
      `translateY(${BATCH_ROW_HEIGHT}px)`,
      `translateY(${BATCH_ROW_HEIGHT + JOB_ROW_HEIGHT}px)`,
    ])
    expect(rows.map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3'])
    expect(rows.every((row) => row.getAttribute('aria-setsize') === '3')).toBe(true)
  })

  it('renders only a window of 5,000 jobs and moves it with the scroll', async () => {
    const jobs = Array.from({ length: 5000 }, (_, i) => titled(1000 + i))
    await renderPanel(snapshotWith({ jobs, batches: [batch] }))

    const firstWindow = within(list()).getAllByRole('listitem')
    expect(firstWindow.length).toBeGreaterThan(LIST_HEIGHT / JOB_ROW_HEIGHT)
    expect(firstWindow.length).toBeLessThan(40)
    expect(firstWindow[0]?.getAttribute('aria-setsize')).toBe('5001')
    expect(firstWindow[0]?.textContent).toContain('Summer 2026')

    const scroller = document.querySelector<HTMLElement>('[data-slot="downloads-list"]')
    if (scroller === null) throw new Error('No list scroller')
    const end = BATCH_ROW_HEIGHT + 5000 * JOB_ROW_HEIGHT - LIST_HEIGHT
    act(() => {
      scroller.scrollTop = end
      fireEvent.scroll(scroller)
    })

    const lastWindow = within(list()).getAllByRole('listitem')
    expect(lastWindow.length).toBeLessThan(40)
    expect(lastWindow.at(-1)?.getAttribute('aria-posinset')).toBe('5001')
    expect(lastWindow.at(-1)?.textContent).toContain('Track 5999')
    expect(screen.queryByRole('heading', { name: 'Summer 2026' })).toBeNull()

    // The virtualizer notes the end of the scroll after a pause; the window stays put.
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(within(list()).getAllByRole('listitem').at(-1)?.getAttribute('aria-posinset')).toBe(
      '5001',
    )
  })
})

describe('DownloadsPanel: bulk actions', () => {
  it('cancels, retries and clears every job, leaving ["downloads"] to the stream', async () => {
    server.on('POST /api/downloads/cancel', () => json({ count: 2 }))
    server.on('POST /api/downloads/retry', () => json({ count: 1 }))
    server.on('POST /api/downloads/clear', () => json({ count: 2 }))
    const user = userEvent.setup()
    const { queryClient } = await renderPanel()
    const before = queryClient.getQueryData(downloadsQueryKey)

    const run = async (item: string) => {
      await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
      await user.click(await screen.findByRole('menuitem', { name: item }))
    }
    await run('Retry failed')
    await run('Clear finished')
    await run('Cancel all')

    expect(jsonBody(server.callsTo('POST /api/downloads/retry')[0])).toEqual({
      target: { scope: 'all' },
      statuses: ['failed'],
    })
    expect(jsonBody(server.callsTo('POST /api/downloads/clear')[0])).toEqual({
      target: { scope: 'all' },
    })
    await vi.waitFor(() => expect(server.callsTo('POST /api/downloads/cancel')).toHaveLength(1))
    expect(jsonBody(server.callsTo('POST /api/downloads/cancel')[0])).toEqual({
      target: { scope: 'all' },
    })
    // The answers are counts; the jobs change only when the stream says so.
    expect(queryClient.getQueryData(downloadsQueryKey)).toBe(before)
  })

  it("runs a batch's actions on that batch only", async () => {
    server.on('POST /api/downloads/cancel', () => json({ count: 1 }))
    const user = userEvent.setup()
    await renderPanel(
      snapshotWith({ jobs: [titled(1), titled(2, otherBatch)], batches: [batch, otherBatch] }),
    )

    await user.click(screen.getByRole('button', { name: 'Actions for Summer 2026' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel all' }))

    await vi.waitFor(() => expect(server.callsTo('POST /api/downloads/cancel')).toHaveLength(1))
    expect(jsonBody(server.callsTo('POST /api/downloads/cancel')[0])).toEqual({
      target: { scope: 'batch', batchId: batch.id },
    })
  })

  it('disables the actions with nothing to act on', async () => {
    const hopeless = jobWith({
      id: testUuid(30),
      status: 'failed',
      error: { code: 'private', message: 'This video is private.' },
      finishedAt,
    })
    const user = userEvent.setup()
    await renderPanel(snapshotWith({ jobs: [hopeless] }))

    await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
    const disabled = (name: string) =>
      screen.getByRole('menuitem', { name }).getAttribute('aria-disabled') === 'true'
    await screen.findByRole('menu')
    // A private video stays private: the server would skip it, so there is nothing to retry.
    expect(disabled('Retry failed')).toBe(true)
    expect(disabled('Clear finished')).toBe(false)
    expect(disabled('Cancel all')).toBe(true)
  })

  it('says why an action failed and what to do, until dismissed', async () => {
    server.on('POST /api/downloads/clear', networkError)
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear finished' }))

    const alert = await findActionAlert()
    expect(alert.textContent).toBe(
      `Couldn't clear the finished downloads. Can't reach the DJ Scraper server.Start it with ${startCommand()} in the project folder.`,
    )
    expect(alert.querySelector('code')?.textContent).toBe(startCommand())

    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(actionAlert()).toBeUndefined()
    // Dismiss went with the alert: the focus moved on to the next control, as Tab would.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for Summer 2026' }),
    )
  })

  it('hands the focus to the heading when Dismiss has nothing after it', async () => {
    server.on('POST /api/downloads/clear', networkError)
    const user = userEvent.setup()
    const { send } = await renderPanel(snapshotWith({ jobs: [doneJob] }))
    await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear finished' }))
    const alert = await findActionAlert()
    // The job went after all (another tab cleared it).
    await send({ type: 'jobs.removed', ids: [doneJob.id], batchIds: [batch.id] })

    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Downloads' }))
  })

  it('moves the focus to the heading when Clear finished empties the list with its menu', async () => {
    server.on('POST /api/downloads/clear', () => json({ count: 2 }))
    const user = userEvent.setup()
    const { send } = await renderPanel(snapshotWith({ jobs: [doneJob, failedJob] }))

    await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear finished' }))
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const heading = screen.getByRole('heading', { name: 'Downloads' })
    expect(document.activeElement).toBe(heading)

    await send({
      type: 'jobs.removed',
      ids: [doneJob.id, failedJob.id],
      batchIds: [batch.id],
    })
    expect(screen.queryByRole('button', { name: 'Actions for all downloads' })).toBeNull()
    expect(document.activeElement).toBe(heading)
  })

  it("moves the focus to the header's menu when Clear finished removes a batch's menu", async () => {
    server.on('POST /api/downloads/clear', () => json({ count: 1 }))
    const user = userEvent.setup()
    const finished = jobWith({ id: testUuid(5), status: 'canceled', finishedAt }, otherBatch)
    const { send } = await renderPanel(
      snapshotWith({ jobs: [titled(1), finished], batches: [batch, otherBatch] }),
    )

    await user.click(screen.getByRole('button', { name: 'Actions for Warm-up set' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Clear finished' }))
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const allMenu = screen.getByRole('button', { name: 'Actions for all downloads' })
    expect(document.activeElement).toBe(allMenu)

    await send({ type: 'jobs.removed', ids: [finished.id], batchIds: [otherBatch.id] })
    expect(screen.queryByRole('button', { name: 'Actions for Warm-up set' })).toBeNull()
    expect(document.activeElement).toBe(allMenu)
  })

  it('returns the focus to the menu when Clear finished leaves it in place', async () => {
    server.on('POST /api/downloads/clear', () => json({ count: 2 }))
    const user = userEvent.setup()
    await renderPanel()

    const allMenu = screen.getByRole('button', { name: 'Actions for all downloads' })
    await user.click(allMenu)
    await user.click(await screen.findByRole('menuitem', { name: 'Clear finished' }))
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(allMenu)
  })

  it("shows the server's own message for a refused action", async () => {
    server.on('POST /api/downloads/retry', () =>
      json({ error: { code: 'invalid_request', message: 'Nothing to retry.' } }, 409),
    )
    const user = userEvent.setup()
    await renderPanel()

    await user.click(screen.getByRole('button', { name: 'Actions for all downloads' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Retry failed' }))

    expect((await findActionAlert()).textContent).toBe(
      "Couldn't retry the failed downloads. Nothing to retry.",
    )
  })
})

describe('DownloadsPanel: notes', () => {
  it('says which platforms the queue pauses or paces, as the stream reports them', async () => {
    const pausedUntil = '2026-10-02T12:05:00.000Z'
    const nextStartAt = '2026-10-02T12:01:00.000Z'
    const { send } = await renderPanel(
      snapshotWith({
        queue: { platforms: [{ platform: 'soundcloud', pausedUntil, pauseCode: 'rate_limited' }] },
      }),
    )
    const paused = `SoundCloud paused until ${formatClock(pausedUntil)}: rate-limited (retries on its own)`
    const note = screen.getByText(paused)
    expect(note.closest('[aria-live="polite"]')).not.toBeNull()

    await send({
      type: 'queue.updated',
      queue: { platforms: [{ platform: 'youtube', nextStartAt }] },
    })
    expect(screen.queryByText(paused)).toBeNull()
    expect(
      screen.getByText(
        `YouTube: next start at ${formatClock(nextStartAt)} (paced to stay under its limits)`,
      ),
    ).toBeDefined()
  })

  it('keeps a paced next start out of the live region: it moves with every start', async () => {
    const pausedUntil = '2026-10-02T12:05:00.000Z'
    const nextStartAt = '2026-10-02T12:01:00.000Z'
    await renderPanel(
      snapshotWith({
        queue: {
          platforms: [
            { platform: 'youtube', nextStartAt },
            { platform: 'soundcloud', pausedUntil, pauseCode: 'rate_limited' },
          ],
        },
      }),
    )
    const paced = screen.getByText(
      `YouTube: next start at ${formatClock(nextStartAt)} (paced to stay under its limits)`,
    )
    expect(paced.closest('[aria-live]')).toBeNull()
    const paused = screen.getByText(
      `SoundCloud paused until ${formatClock(pausedUntil)}: rate-limited (retries on its own)`,
    )
    expect(paused.closest('[aria-live="polite"]')).not.toBeNull()
  })

  it('says live updates are lost while the stream is down, keeping the last jobs', async () => {
    vi.useFakeTimers()
    const { es } = await renderPanel()

    /**
     * Moves the clock, then 1 ms more: TanStack Query tells React on a 0 ms timer, which the fake
     * clock runs 1 ms later when a timer callback (the outage) sets it.
     */
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
        await vi.advanceTimersByTimeAsync(1)
      })

    // A drop that heals within 2 s goes unnoticed.
    act(() => es.current.drop())
    await advance(1000)
    expect(screen.queryByText('Live updates lost: reconnecting…')).toBeNull()

    await advance(1000)
    const note = screen.getByText('Live updates lost: reconnecting…')
    expect(note.closest('[aria-live="polite"]')).not.toBeNull()
    expect(counts().textContent).toBe('1 done · 1 failed · 2 left')
    expect(within(list()).getAllByRole('listitem')).toHaveLength(5)

    // The browser reconnects and the server sends a fresh snapshot.
    await act(async () => {
      es.current.open()
      es.current.send({ type: 'snapshot', ...snapshotWith({ jobs: [doneJob] }) })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.queryByText('Live updates lost: reconnecting…')).toBeNull()
    expect(counts().textContent).toBe('1 done')
  })
})
