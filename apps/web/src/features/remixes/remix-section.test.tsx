// The remix suggestions under a track card (ADR-027), against the fake server: the quick YouTube
// search and the full one at once, the rows, the notes and errors, the genre filter and downloads.
import {
  type CreateDownloadsResponse,
  DownloadRequestSchema,
  type RemixRequest,
  RemixRequestSchema,
  type RemixSuggestions,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { batch, jobWith, liveDownloads, settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import {
  artyRemix,
  artySoundcloud,
  artyYoutube,
  bareRemix,
  noRemixes,
  quickRemixes,
  remixes,
  remixesWith,
} from '@/test/remixes.ts'
import { createTestQueryClient, renderWithQueryClient } from '@/test/render.tsx'
import { track } from '@/test/resolve.ts'
import { remixRequestFor, uploadRef } from './remix-request.ts'
import { RemixSection } from './remix-section.tsx'

const REMIXES = 'POST /api/remixes'
const CREATE = 'POST /api/downloads'
const ARTY = 'Moby - Porcelain (Arty Remix)'

type Answer = () => Response | Promise<Response>

let server: ReturnType<typeof fakeApi>
/** How the server answers the quick search (YouTube alone) and the full one. */
let answers: { quick: Answer; full: Answer }

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
  answers = { quick: () => json(quickRemixes), full: () => json(remixes) }
  server.on(REMIXES, (call) => {
    const { platforms } = RemixRequestSchema.parse(jsonBody(call))
    return platforms === undefined ? answers.full() : answers.quick()
  })
  server.on(CREATE, () =>
    json({
      batchId: batch.id,
      jobIds: [testUuid(40)],
      duplicates: 0,
    } satisfies CreateDownloadsResponse),
  )
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

/** A response the test sends when it chooses. */
function later() {
  let send: (response: Response) => void = () => {}
  const answer = new Promise<Response>((resolve) => (send = resolve))
  return { answer: () => answer, send }
}

const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status)

function renderSection() {
  return renderWithQueryClient(<RemixSection track={track} />)
}

const list = () => screen.getByRole('list', { name: 'Remixes' })
/** The rows' titles, in order. */
const rowTitles = () =>
  within(list())
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label'))
const row = (title: string) => within(list()).getByRole('listitem', { name: title })
const toggle = (name: string | RegExp) => screen.getByRole('button', { name })
/** The section's own status line: each row has one too, for its download. */
const searchStatus = () => {
  const [status, ...others] = screen
    .getAllByRole('status')
    .filter((element) => element.closest('li') === null)
  if (status === undefined || others.length > 0) throw new Error('expected one search status')
  return status
}
const remixBodies = () => server.callsTo(REMIXES).map((call) => jsonBody(call) as RemixRequest)

describe('the search', () => {
  it('asks for YouTube alone and for both platforms at once, with a skeleton until an answer', async () => {
    answers = { quick: noAnswer, full: noAnswer }
    renderSection()

    await waitFor(() => expect(server.callsTo(REMIXES)).toHaveLength(2))
    const request = remixRequestFor(track)
    expect(remixBodies()).toEqual(
      expect.arrayContaining([request, { ...request, platforms: ['youtube'] }]),
    )
    expect(document.querySelector('[data-slot="remix-skeleton"]')).not.toBeNull()
    expect(searchStatus().textContent).toBe('Searching YouTube and SoundCloud for remixes…')
    expect(toggle('Remixes').getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the YouTube rows first, saying SoundCloud is still searched, then the full answer', async () => {
    const full = later()
    answers.full = full.answer
    renderSection()

    await screen.findByRole('list', { name: 'Remixes' })
    expect(rowTitles()).toEqual([ARTY, 'Moby - Porcelain (Extended Mix)'])
    expect(toggle('Remixes 2')).toBeTruthy()
    expect(screen.getByText('Searching SoundCloud…').closest('[aria-live="polite"]')).not.toBeNull()

    full.send(json(remixes))

    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(rowTitles()).toEqual([
      ARTY,
      'Moby - Porcelain (Night Ferry Bootleg) [Afro House]',
      'Moby - Porcelain (Extended Mix)',
      'Porcelain remix',
    ])
    expect(screen.queryByText('Searching SoundCloud…')).toBeNull()
    expect(toggle('Remixes 4')).toBeTruthy()
    expect(searchStatus().textContent).toBe(
      '4 remixes found. Remixes of Moby – Porcelain on YouTube and SoundCloud',
    )
  })

  it('shows a cached full answer at once, without searching again', async () => {
    const queryClient = createTestQueryClient()
    const ui = (
      <QueryClientProvider client={queryClient}>
        <RemixSection track={track} />
      </QueryClientProvider>
    )
    const first = render(ui)
    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    first.unmount()
    expect(server.callsTo(REMIXES)).toHaveLength(2)

    render(ui)

    expect(rowTitles()).toHaveLength(4)
    expect(server.callsTo(REMIXES)).toHaveLength(2)
  })
})

describe('the rows', () => {
  it('say what kind of version each is, its genre, platforms, plays and length', async () => {
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    const arty = row(ARTY)
    expect(arty.textContent).toContain('Remix by Arty')
    expect(arty.textContent).toContain('YouTube·908K views')
    expect(arty.textContent).toContain('SoundCloud·382K plays')
    expect(arty.textContent).toContain('Duration 3:34')
    const trance = within(arty).getByText('Trance')
    expect(trance.dataset.genreSource).toBe('platform')
    expect(trance.title).toBe('Genre set on SoundCloud')
    expect(trance.textContent).toBe('Trance (Genre set on SoundCloud)')

    const bootleg = row('Moby - Porcelain (Night Ferry Bootleg) [Afro House]')
    expect(bootleg.textContent).toContain('Bootleg by Night Ferry')
    const guess = within(bootleg).getByText('Afro House')
    expect(guess.dataset.genreSource).toBe('text')
    expect(guess.className).toContain('border-dashed')
    expect(guess.textContent).toBe('Afro House (Genre named in the title or tags)')

    expect(row('Moby - Porcelain (Extended Mix)').textContent).toContain('Extended mix')
    const bare = row('Porcelain remix')
    expect(bare.textContent).toBe('Porcelain remixRemixSoundCloudDownload')
  })

  it('offer another upload only for a version uploaded more than once', async () => {
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    expect(within(row(ARTY)).getByRole('button', { name: `Choose upload of ${ARTY}` })).toBeTruthy()
    expect(
      within(row('Porcelain remix')).queryByRole('button', { name: /^Choose upload/ }),
    ).toBeNull()
  })
})

/** A full answer whose SoundCloud search failed: YouTube's rows only. */
const soundcloudFailed = remixesWith({
  suggestions: quickRemixes.suggestions,
  searches: {
    youtube: { status: 'ok', found: 9 },
    soundcloud: {
      status: 'error',
      error: { code: 'rate_limited', message: 'SoundCloud is limiting requests.' },
    },
  },
})

describe('when a search fails', () => {
  it("keeps the other platform's rows beside a failed platform's note", async () => {
    answers.full = () => json(soundcloudFailed)
    answers.quick = noAnswer
    renderSection()

    expect(
      await screen.findByText('SoundCloud search failed: SoundCloud is limiting requests.'),
    ).toBeTruthy()
    expect(rowTitles()).toHaveLength(2)
  })

  it("searches a failed platform again on Try again, keeping the other's rows meanwhile", async () => {
    answers.full = () => json(soundcloudFailed)
    const user = userEvent.setup()
    renderSection()
    await screen.findByText('SoundCloud search failed: SoundCloud is limiting requests.')
    const fullCalls = () => remixBodies().filter((body) => body.platforms === undefined)
    expect(fullCalls()).toHaveLength(1)

    const retried = later()
    answers.full = retried.answer
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(fullCalls()).toHaveLength(2))
    expect(rowTitles()).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    retried.send(json(remixes))
    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(screen.queryByText(/search failed/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('searches again when the same track is pasted after a platform failed', async () => {
    answers.full = () => json(soundcloudFailed)
    const queryClient = createTestQueryClient()
    const ui = (
      <QueryClientProvider client={queryClient}>
        <RemixSection track={track} />
      </QueryClientProvider>
    )
    const first = render(ui)
    await screen.findByText('SoundCloud search failed: SoundCloud is limiting requests.')
    first.unmount()
    const calls = server.callsTo(REMIXES).length

    answers.full = () => json(remixes)
    render(ui)

    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(server.callsTo(REMIXES).length).toBeGreaterThan(calls)
    expect(screen.queryByText(/search failed/)).toBeNull()
  })

  it('keeps the quick rows when the full search fails, shows its error as SoundCloud’s, and tries again', async () => {
    answers.full = () => apiError(500, 'unknown', 'The search broke. Try `brew upgrade yt-dlp`.')
    renderSection()

    const text = await screen.findByText(/^SoundCloud search failed: The search broke\./)
    const note = text.closest('li')
    if (note === null) throw new Error('the note is not a list item')
    expect(note.textContent).toBe(
      'SoundCloud search failed: The search broke. Try brew upgrade yt-dlp.',
    )
    expect(within(note).getByText('brew upgrade yt-dlp', { selector: 'code' })).toBeTruthy()
    expect(rowTitles()).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Searching SoundCloud…')).toBeNull()

    answers.full = () => json(remixes)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(screen.queryByText(/search failed/)).toBeNull()
  })

  it('shows the error with a next step and Try again when nothing succeeded', async () => {
    const missing = () =>
      apiError(503, 'engine_missing', 'yt-dlp is not installed. Run `brew install yt-dlp`.')
    answers = { quick: missing, full: missing }
    const user = userEvent.setup()
    renderSection()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't search for remixes")
    expect(alert.textContent).toContain('yt-dlp is not installed. Run brew install yt-dlp.')
    // The server's commands show as code, not in backticks.
    expect(within(alert).getByText('brew install yt-dlp', { selector: 'code' })).toBeTruthy()
    expect(alert.textContent).toContain('brew install yt-dlp ffmpeg')
    expect(server.callsTo(REMIXES)).toHaveLength(2)

    answers = { quick: () => json(quickRemixes), full: () => json(remixes) }
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(server.callsTo(REMIXES)).toHaveLength(4)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers no Try again when the title has nothing to search for', async () => {
    const refused = () => apiError(400, 'invalid_request', 'The title has no words to search for.')
    answers = { quick: refused, full: refused }
    renderSection()

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The title has no words to search for.',
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

it('says so when no remix was found', async () => {
  answers = { quick: noAnswer, full: () => json(noRemixes) }
  renderSection()

  expect(await screen.findByText('No remixes found on YouTube or SoundCloud.')).toBeTruthy()
  expect(toggle('Remixes 0')).toBeTruthy()
  expect(screen.queryByRole('list', { name: 'Remixes' })).toBeNull()
})

describe('the genre filter', () => {
  it('shows All and each genre with its count, and filters the rows', async () => {
    const user = userEvent.setup()
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    const filter = screen.getByRole('group', { name: 'Filter remixes by genre' })
    const chips = within(filter).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['All 4', 'Afro House 2', 'Trance 1'])
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])

    await user.click(within(filter).getByRole('button', { name: 'Afro House 2' }))
    expect(rowTitles()).toEqual([
      'Moby - Porcelain (Night Ferry Bootleg) [Afro House]',
      'Moby - Porcelain (Extended Mix)',
    ])
    expect(
      within(filter).getByRole('button', { name: 'Afro House 2' }).getAttribute('aria-pressed'),
    ).toBe('true')

    await user.click(within(filter).getByRole('button', { name: 'All 4' }))
    expect(rowTitles()).toHaveLength(4)
  })

  it('is left out when the answer names fewer than two genres', async () => {
    answers = {
      quick: noAnswer,
      full: () => json(remixesWith({ suggestions: [artyRemix, bareRemix] })),
    }
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(2))

    expect(screen.queryByRole('group', { name: 'Filter remixes by genre' })).toBeNull()
  })
})

describe('a download', () => {
  it('queues the most played upload as one item, then shows its job', async () => {
    const user = userEvent.setup()
    const { queryClient } = renderSection()
    const { send } = await liveDownloads(queryClient)
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    await user.click(within(row(ARTY)).getByRole('button', { name: `Download ${ARTY}` }))

    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
    const sent = DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0]))
    expect(sent.items).toEqual([uploadRef(artyYoutube)])
    expect(sent.label).toBe(ARTY)
    await waitFor(() =>
      expect(within(row(ARTY)).getByRole('status').textContent).toBe('Added to downloads'),
    )

    await send({
      type: 'jobs.added',
      batch,
      jobs: [jobWith({ id: testUuid(40), status: 'queued', track: uploadRef(artyYoutube) })],
    })
    expect(row(ARTY).textContent).toContain('Download: Queued')
    // Nothing else was queued: a remix never downloads by itself.
    expect(server.callsTo(CREATE)).toHaveLength(1)
  })

  it('queues the upload picked in the menu instead', async () => {
    const user = userEvent.setup()
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    await user.click(within(row(ARTY)).getByRole('button', { name: `Choose upload of ${ARTY}` }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      `YouTube · Anjunabeats · 908K views · 3:34${ARTY}`,
      `SoundCloud · Anjunabeats · 382K plays · 3:35${ARTY}`,
      'YouTube · Trance Archive · 12K views · 3:33Porcelain (Arty Remix) [Trance Classics]',
    ])
    await user.click(screen.getByRole('menuitem', { name: /^SoundCloud · Anjunabeats/ }))

    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
    const sent = DownloadRequestSchema.parse(jsonBody(server.callsTo(CREATE)[0]))
    expect(sent.items).toEqual([uploadRef(artySoundcloud)])
  })

  it('keeps its job showing when the full answer replaces the quick one, and through the filter', async () => {
    const full = later()
    answers.full = full.answer
    const user = userEvent.setup()
    const { queryClient } = renderSection()
    const { send } = await liveDownloads(queryClient)
    await screen.findByRole('list', { name: 'Remixes' })

    await user.click(within(row(ARTY)).getByRole('button', { name: `Download ${ARTY}` }))
    await waitFor(() => expect(server.callsTo(CREATE)).toHaveLength(1))
    await send({
      type: 'jobs.added',
      batch,
      jobs: [jobWith({ id: testUuid(40), status: 'queued', track: uploadRef(artyYoutube) })],
    })
    await waitFor(() => expect(row(ARTY).textContent).toContain('Download: Queued'))

    // SoundCloud's upload is now the most played: the row's default upload changes.
    const scFirst: RemixSuggestions = remixesWith({
      suggestions: [
        { ...artyRemix, uploads: [artySoundcloud, artyYoutube] },
        ...remixes.suggestions.slice(1),
      ],
    })
    full.send(json(scFirst))
    await waitFor(() => expect(rowTitles()).toHaveLength(4))
    expect(row(ARTY).textContent).toContain('Download: Queued')

    await user.click(screen.getByRole('button', { name: 'Afro House 2' }))
    await user.click(screen.getByRole('button', { name: 'All 4' }))
    expect(row(ARTY).textContent).toContain('Download: Queued')
  })

  it('shows why a download could not be added', async () => {
    server.on(CREATE, () => apiError(409, 'folder_unavailable', 'The folder is gone.'))
    const user = userEvent.setup()
    renderSection()
    await waitFor(() => expect(rowTitles()).toHaveLength(4))

    await user.click(within(row(ARTY)).getByRole('button', { name: `Download ${ARTY}` }))

    expect((await within(row(ARTY)).findByRole('alert')).textContent).toBe('The folder is gone.')
  })
})

it('collapses and opens again, keeping the rows', async () => {
  const user = userEvent.setup()
  renderSection()
  await waitFor(() => expect(rowTitles()).toHaveLength(4))

  await user.click(toggle('Remixes 4'))
  expect(toggle('Remixes 4').getAttribute('aria-expanded')).toBe('false')
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Remixes' })).toBeNull())

  await user.click(toggle('Remixes 4'))
  expect(rowTitles()).toHaveLength(4)
})
