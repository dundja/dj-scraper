import type { Collection } from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Artwork } from '@/components/artwork.tsx'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { jobWith, liveDownloads, settings, snapshotWith } from '@/test/downloads.ts'
import { fakeApi, json } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import {
  collectionWith,
  PLAYLIST_SPECIAL_ROWS,
  playlist,
  SC_SET_PREVIEW_ROW,
  scSet,
  scSetTracks,
  userPage,
  userPageWithLists,
} from '@/test/resolve.ts'
import { CollectionView } from './collection-view.tsx'
import {
  enrich,
  initialRows,
  readyRow,
  resetFakeEnrichment,
  rowsWith,
  stubTableViewport,
  trackList,
  useFakeEnrichment,
} from './test-utils.ts'
import { useEnrichment } from './use-enrichment.ts'

vi.mock('./use-enrichment.ts', () => ({ useEnrichment: vi.fn() }))
// Not a double: the real Artwork, spied on to count how often the table's rows render.
vi.mock('@/components/artwork.tsx', async (importOriginal) => {
  const { Artwork } = await importOriginal<typeof import('@/components/artwork.tsx')>()
  return { Artwork: vi.fn(Artwork) }
})

let server: ReturnType<typeof fakeApi>
let viewport: ReturnType<typeof stubTableViewport>

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
  vi.mocked(useEnrichment).mockImplementation(useFakeEnrichment)
  resetFakeEnrichment()
  // Tall enough for the 30-row playlist to render whole; virtualization has its own tests.
  viewport = stubTableViewport(40)
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

function renderView(collection: Collection = playlist) {
  const onOpenList = vi.fn<(url: string) => void>()
  const result = renderWithQueryClient(
    <CollectionView collection={collection} onOpenList={onOpenList} />,
  )
  return { ...result, onOpenList, user: userEvent.setup() }
}

const checkbox = (title: string) => screen.getByRole('checkbox', { name: `Select ${title}` })
const isChecked = (box: HTMLElement) => box.getAttribute('aria-checked') === 'true'
const isDisabled = (box: HTMLElement) => box.hasAttribute('data-disabled')
const isButtonDisabled = (button: HTMLElement) =>
  button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled')

/** The data rows shown, as their titles (the table's own header row left out). */
function shownTitles(): string[] {
  return within(trackList())
    .getAllByRole('row')
    .map((row) => row.querySelector('[title]')?.getAttribute('title') ?? '')
}

/** The selection line, e.g. "27 selected · 3 h 38 min · 1 without a duration". */
const selectionLine = () =>
  screen.getByText(/selected/, { selector: '[data-slot="selection-summary"]' })
/** How many times a track row rendered (each renders its 32 px artwork once). */
const rowRenders = () => vi.mocked(Artwork).mock.calls.filter(([props]) => props.size === 32).length

describe('CollectionView header', () => {
  it('shows the title, owner, kind, platform, count and total duration', () => {
    renderView()
    expect(screen.getByRole('heading', { level: 2, name: 'Warm-up Selection' })).toBeTruthy()
    const header = screen.getByRole('region', { name: 'Warm-up Selection' })
    expect(header.textContent).toContain('Crate Diggers')
    expect(screen.getByText('Playlist')).toBeTruthy()
    expect(screen.getByText('YouTube')).toBeTruthy()
    // ≈: row 14 (a past live stream) has no duration.
    expect(screen.getByText('30 tracks · ≈ 3 h 43 min')).toBeTruthy()
  })

  it('says when the platform has more tracks than listed, and when our cap cut the list', () => {
    renderView(collectionWith(playlist, { trackCount: 214, truncated: true }))
    expect(screen.getByText('30 of 214 tracks · ≈ 3 h 43 min')).toBeTruthy()
    expect(screen.getByText('Showing the first 30 tracks.')).toBeTruthy()
  })

  it('takes a SoundCloud set its total from the platform', () => {
    renderView(scSet)
    expect(screen.getByText('8 tracks · 51 min')).toBeTruthy()
    expect(screen.getByText('Set')).toBeTruthy()
    expect(screen.getByText('SoundCloud')).toBeTruthy()
  })

  it('notes rows that are not tracks', () => {
    renderView(collectionWith(playlist, { skippedEntries: 2 }))
    expect(screen.getByText("2 rows aren't tracks.")).toBeTruthy()
  })

  it('links the sets a profile lists beside its tracks', async () => {
    const { onOpenList, user } = renderView(userPage)
    expect(screen.getByText('This page also lists 1 set.')).toBeTruthy()
    expect(screen.getByText("1 other row isn't a track.")).toBeTruthy()
    expect(screen.getByText('Profile')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Open Royal EP' }))
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith(
      'https://soundcloud.com/the-concept-band/sets/royal-ep',
    )
    // Its tracks are still there to pick.
    expect(checkbox('Night Shift')).toBeTruthy()
  })

  it('folds many linked lists away', async () => {
    const lists = userPageWithLists.lists ?? []
    const { onOpenList, user } = renderView(
      collectionWith(userPage, { lists, skippedEntries: lists.length }),
    )
    expect(screen.getByText('This page also lists 4 sets.')).toBeTruthy()
    await user.click(screen.getByText('Show them'))
    await user.click(screen.getByRole('button', { name: 'Open The Royal Concept EP' }))
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith(
      'https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep',
    )
  })
})

describe('CollectionView without tracks', () => {
  it('shows the lists of a Sets tab as what there is to open', async () => {
    const { onOpenList, user } = renderView(userPageWithLists)
    expect(screen.getByText('4 sets')).toBeTruthy()
    const lists = screen.getByRole('list', { name: 'Lists on this page' })
    expect(
      within(lists)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Goldrushed [2013 Album]', 'Royal EP', 'The Royal Concept EP', 'The Royal Concept'])
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull()

    await user.click(within(lists).getByRole('button', { name: 'Open Royal EP' }))
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith(
      'https://soundcloud.com/the-concept-band/sets/royal-ep',
    )
  })

  it('says there are no tracks when there are no lists either', () => {
    renderView(collectionWith(playlist, { entries: [], trackCount: 0, skippedEntries: 3 }))
    expect(screen.getByText('No tracks here')).toBeTruthy()
    // The header says why, once.
    expect(screen.getAllByText("3 rows aren't tracks.")).toHaveLength(1)
    expect(screen.getByText('Try another link.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says an empty list is empty', () => {
    renderView(collectionWith(playlist, { entries: [], trackCount: 0 }))
    expect(screen.getByText('This list is empty. Try another link.')).toBeTruthy()
  })
})

describe('CollectionView table', () => {
  it('lists every row with a labelled checkbox, the available ones selected', () => {
    renderView()
    expect(shownTitles()).toHaveLength(30)
    expect(shownTitles().slice(0, 3)).toEqual([
      'Tidal Drift',
      'Low Sun (Extended Mix)',
      '[Private video]',
    ])
    expect(isChecked(checkbox('Tidal Drift'))).toBe(true)
    // Unknown availability is normal in flat listings: selectable, and selected.
    expect(isChecked(checkbox('Low Sun (Extended Mix)'))).toBe(true)
    expect(selectionLine().textContent).toBe('27 selected · 3 h 38 min · 1 without a duration')
    expect(screen.getByRole('button', { name: 'Download 27 tracks' })).toBeTruthy()
  })

  it('greys out unavailable rows with their reason; they cant be selected', async () => {
    const { user } = renderView()
    const privateBox = checkbox('[Private video]')
    expect(isChecked(privateBox)).toBe(false)
    expect(isDisabled(privateBox)).toBe(true)
    const privateRow = privateBox.closest('[role="row"]')
    expect(privateRow?.textContent).toContain('Private')
    const deletedRow = checkbox('[Deleted video]').closest('[role="row"]')
    expect(deletedRow?.textContent).toContain('Unavailable')

    if (!(privateRow instanceof HTMLElement)) throw new Error('No row')
    await user.click(privateRow)
    expect(isChecked(privateBox)).toBe(false)
    expect(selectionLine().textContent).toMatch(/^27 selected/)
  })

  it('shows each row: number, title, artist (or uploader) and duration', () => {
    renderView()
    const row = checkbox('Sunset Session Mix 2026').closest('[role="row"]')
    if (!(row instanceof HTMLElement)) throw new Error('No row')
    const cells = within(row).getAllByRole('cell')
    expect(cells[1]?.textContent).toBe(String(PLAYLIST_SPECIAL_ROWS.noArtist + 1))
    expect(cells[3]?.textContent).toContain('Sunset Session Mix 2026')
    // No artist: the uploader names who made it.
    expect(cells[4]?.textContent).toBe('Lofi Garden')
    expect(cells[5]?.textContent).toBe('1:02:01')
  })

  it('toggles a row on a click anywhere on it, and a video listed twice with it', async () => {
    const { user } = renderView()
    const [first, again] = screen.getAllByRole('checkbox', { name: 'Select Copper Lines' })
    if (first === undefined || again === undefined) throw new Error('The duplicate is missing')

    await user.click(screen.getAllByText('Copper Lines')[0] ?? first)
    expect(isChecked(first)).toBe(false)
    expect(isChecked(again)).toBe(false)
    expect(selectionLine().textContent).toMatch(/^26 selected/)

    await user.click(again)
    expect(isChecked(first)).toBe(true)
    expect(selectionLine().textContent).toMatch(/^27 selected/)
  })

  it('shift-click gives the range from the last clicked row its new state', async () => {
    const { user } = renderView()
    await user.click(checkbox('Tidal Drift'))
    await user.keyboard('{Shift>}')
    await user.click(checkbox('Night Ferry (Original Mix)'))
    await user.keyboard('{/Shift}')

    expect(isChecked(checkbox('Tidal Drift'))).toBe(false)
    expect(isChecked(checkbox('Low Sun (Extended Mix)'))).toBe(false)
    expect(isChecked(checkbox('Glasshouse'))).toBe(false)
    expect(isChecked(checkbox('Night Ferry (Original Mix)'))).toBe(false)
    expect(isChecked(checkbox('Slow Motion City'))).toBe(true)
    expect(selectionLine().textContent).toMatch(/^23 selected/)

    // And back on, from the last clicked row upwards.
    await user.click(checkbox('Glasshouse'))
    await user.keyboard('{Shift>}')
    await user.click(checkbox('Tidal Drift'))
    await user.keyboard('{/Shift}')
    expect(selectionLine().textContent).toMatch(/^26 selected/)
    expect(isChecked(checkbox('Night Ferry (Original Mix)'))).toBe(false)
  })

  it('toggles the focused row with Space, and extends the range with Shift+Space', async () => {
    const { user } = renderView()
    act(() => checkbox('Tidal Drift').focus())
    await user.keyboard(' ')
    expect(isChecked(checkbox('Tidal Drift'))).toBe(false)

    act(() => checkbox('Glasshouse').focus())
    await user.keyboard('{Shift>} {/Shift}')
    expect(isChecked(checkbox('Low Sun (Extended Mix)'))).toBe(false)
    expect(isChecked(checkbox('Glasshouse'))).toBe(false)
  })

  it('is one Tab stop; arrows, Home and End move between rows', async () => {
    const { user } = renderView()
    const tabStops = screen
      .getAllByRole('checkbox')
      .filter((box) => box.getAttribute('tabindex') === '0')
    expect(tabStops).toEqual([checkbox('Tidal Drift')])

    await user.click(screen.getByRole('textbox', { name: 'Filter tracks' }))
    await user.tab()
    expect(document.activeElement).toBe(checkbox('Tidal Drift'))

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(checkbox('Low Sun (Extended Mix)'))
    // The page scrolls too when it must (below lg the list's edge can be out of the window).
    expect(viewport.scrollIntoView.mock.contexts.at(-1)).toBe(document.activeElement)
    expect(viewport.scrollIntoView.mock.lastCall).toEqual([{ block: 'nearest' }])
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(checkbox('Afterhours'))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(checkbox('Harbour Lights'))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(checkbox('Tidal Drift'))
    // The selection is untouched by moving.
    expect(selectionLine().textContent).toMatch(/^27 selected/)

    // Tab leaves the table from the focused row, and comes back to it.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await user.tab()
    expect(document.activeElement?.closest('table, [role="table"]')).toBeNull()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(checkbox('Glasshouse'))
  })
})

describe('CollectionView with another collection', () => {
  it('starts over: selection and filter', async () => {
    const { rerender, queryClient, user } = renderView()
    const show = (collection: Collection) =>
      rerender(
        <QueryClientProvider client={queryClient}>
          <CollectionView collection={collection} onOpenList={() => {}} />
        </QueryClientProvider>,
      )
    await user.click(checkbox('Tidal Drift'))
    await user.type(screen.getByRole('textbox', { name: 'Filter tracks' }), 'tidal')

    // The same collection again (a parent re-render) keeps both.
    show(playlist)
    expect(shownTitles()).toEqual(['Tidal Drift'])
    expect(isChecked(checkbox('Tidal Drift'))).toBe(false)

    // Resolved again: a new collection, even of the same list, starts over.
    show(collectionWith(playlist, {}))
    expect(shownTitles()).toHaveLength(30)
    expect(isChecked(checkbox('Tidal Drift'))).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Filter tracks' })).toHaveProperty('value', '')
  })
})

describe('CollectionView filter and bulk selection', () => {
  it('finds rows by title, artist or uploader, ignoring case and accents', async () => {
    const { user } = renderView()
    const filter = screen.getByRole('textbox', { name: 'Filter tracks' })
    await user.type(filter, 'AGUA')
    expect(shownTitles()).toEqual(['Água Viva'])
    expect(screen.getByText('1 of 30')).toBeTruthy()

    await user.clear(filter)
    await user.type(filter, 'kollektiv')
    expect(shownTitles()).toEqual(['Tidal Drift', 'Undertow', 'Breakwater'])
  })

  it('keeps the selection while filtering, and the buttons act on the shown rows only', async () => {
    const { user } = renderView()
    const filter = screen.getByRole('textbox', { name: 'Filter tracks' })
    await user.type(filter, 'kollektiv')
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    expect(selectionLine().textContent).toMatch(/^24 selected/)

    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(document.activeElement).toBe(filter)
    expect(shownTitles()).toHaveLength(30)
    expect(isChecked(checkbox('Tidal Drift'))).toBe(false)
    expect(isChecked(checkbox('Low Sun (Extended Mix)'))).toBe(true)

    await user.type(filter, 'mara vey')
    await user.click(screen.getByRole('button', { name: 'Invert selection' }))
    // Mara Vey's three rows were selected: now they aren't.
    expect(selectionLine().textContent).toMatch(/^21 selected/)
    await user.click(filter)
    await user.keyboard('{Escape}')
    expect(filter).toHaveProperty('value', '')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(selectionLine().textContent).toMatch(/^27 selected/)
  })

  it('shift-click ranges follow the filtered order', async () => {
    const { user } = renderView()
    await user.type(screen.getByRole('textbox', { name: 'Filter tracks' }), 'kollektiv')
    await user.click(checkbox('Tidal Drift'))
    await user.keyboard('{Shift>}')
    await user.click(checkbox('Breakwater'))
    await user.keyboard('{/Shift}')
    expect(selectionLine().textContent).toMatch(/^24 selected/)

    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    // The rows between, hidden by the filter, kept their state.
    expect(isChecked(checkbox('Low Sun (Extended Mix)'))).toBe(true)
    expect(isChecked(checkbox('Undertow'))).toBe(false)
  })

  it('says when nothing matches', async () => {
    const { user } = renderView()
    await user.type(screen.getByRole('textbox', { name: 'Filter tracks' }), 'zzz')
    expect(screen.getByText('No track matches “zzz”.')).toBeTruthy()
    expect(screen.getByText('0 of 30')).toBeTruthy()
  })

  it('selects all, none, or the inverse', async () => {
    const { user } = renderView()
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    expect(selectionLine().textContent).toBe('None selected')
    expect(isButtonDisabled(screen.getByRole('button', { name: 'Select tracks' }))).toBe(true)

    await user.click(checkbox('Tidal Drift'))
    await user.click(screen.getByRole('button', { name: 'Invert selection' }))
    expect(selectionLine().textContent).toMatch(/^26 selected/)
    expect(isChecked(checkbox('Tidal Drift'))).toBe(false)
    // Unavailable rows stay out, even of an inverse.
    expect(isChecked(checkbox('[Private video]'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(selectionLine().textContent).toMatch(/^27 selected/)
  })
})

describe('CollectionView partial rows', () => {
  it('shows placeholders for rows still loading; they start selected', () => {
    renderView(scSet)
    expect(checkbox('Night Shift')).toBeTruthy()
    expect(screen.getAllByText('Loading details…')).toHaveLength(6)
    // Partial rows have no title yet: they are labelled by number.
    expect(isChecked(checkbox('row 3'))).toBe(true)
    expect(selectionLine().textContent).toBe('8 selected · 13 min · 6 without a duration')
  })

  it('fills rows in as enrichment returns them, keeping their selection', async () => {
    const { user } = renderView(scSet)
    await user.click(checkbox('row 4'))
    const [tramLines, velvetStatic] = scSetTracks.slice(2, 4)
    if (tramLines === undefined || velvetStatic === undefined) throw new Error('fixture')
    enrich(rowsWith(scSet.entries, { 2: readyRow(tramLines), 3: readyRow(velvetStatic) }))

    expect(isChecked(checkbox('Tram Lines'))).toBe(true)
    expect(isChecked(checkbox('Velvet Static'))).toBe(false)
    expect(screen.getAllByText('Loading details…')).toHaveLength(4)
    expect(selectionLine().textContent).toBe('7 selected · 19 min · 4 without a duration')
  })

  it('announces the count when the selection changes, not the length as rows fill in', async () => {
    const { user } = renderView(scSet)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('8 selected')
    // The line with the length is no live region of its own.
    expect(selectionLine().closest('[role="status"], [aria-live]')).toBeNull()

    const [tramLines, velvetStatic] = scSetTracks.slice(2, 4)
    if (tramLines === undefined || velvetStatic === undefined) throw new Error('fixture')
    enrich(rowsWith(scSet.entries, { 2: readyRow(tramLines), 3: readyRow(velvetStatic) }))
    expect(selectionLine().textContent).toBe('8 selected · 25 min · 4 without a duration')
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('8 selected')

    await user.click(checkbox('Tram Lines'))
    expect(status.textContent).toBe('7 selected')
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    expect(status.textContent).toBe('None selected')
  })

  it('renders again only the rows that change as rows fill in', () => {
    renderView(scSet)
    const tramLines = scSetTracks[2]
    if (tramLines === undefined) throw new Error('fixture')
    const before = rowRenders()
    expect(before).toBeGreaterThanOrEqual(8)

    enrich(rowsWith(scSet.entries, { 2: readyRow(tramLines) }))
    expect(checkbox('Tram Lines')).toBeTruthy()
    expect(rowRenders() - before).toBe(1)
  })

  it('says when a row could not load; it stays selected and downloadable', () => {
    renderView(scSet)
    const error = { code: 'network', message: 'The connection dropped.' } as const
    const [row] = initialRows(scSet.entries.slice(4, 5))
    if (row === undefined) throw new Error('fixture')
    enrich(rowsWith(scSet.entries, { 4: { ...row, state: 'failed', error } }))
    const failed = screen.getByText("Couldn't load details")
    expect(failed.getAttribute('title')).toBe('The connection dropped.')
    expect(isChecked(checkbox('row 5'))).toBe(true)
    expect(selectionLine().textContent).toMatch(/^8 selected/)
  })

  it('takes a row that turns out unavailable out of the selection', () => {
    renderView(scSet)
    const preview = scSetTracks[SC_SET_PREVIEW_ROW]
    if (preview === undefined) throw new Error('fixture')
    enrich(rowsWith(scSet.entries, { [SC_SET_PREVIEW_ROW]: readyRow(preview) }))
    const box = checkbox('Go+ Exclusive')
    expect(isChecked(box)).toBe(false)
    expect(isDisabled(box)).toBe(true)
    expect(box.closest('[role="row"]')?.textContent).toContain('Preview only (Go+)')
    expect(selectionLine().textContent).toMatch(/^7 selected/)
  })
})

describe('CollectionView downloads', () => {
  it('shows the status of each track that has a download', async () => {
    const { queryClient } = renderView()
    const [first, second] = playlist.entries
    if (first === undefined || second === undefined) throw new Error('fixture')
    await liveDownloads(
      queryClient,
      snapshotWith({
        jobs: [
          jobWith({
            id: testUuid(31),
            status: 'done',
            track: toTrackRef(first),
            outputPath: '/Users/dj/Music/DJ Scraper/Kollektiv Nord - Tidal Drift.mp3',
            output: { ext: 'mp3', codec: 'mp3', bitrateKbps: 320, encoded: true },
            finishedAt: '2026-10-02T08:01:00.000Z',
          }),
          jobWith({
            id: testUuid(32),
            status: 'failed',
            track: toTrackRef(second),
            error: { code: 'private', message: 'This video is private.' },
            finishedAt: '2026-10-02T08:01:00.000Z',
          }),
        ],
      }),
    )
    const doneRow = checkbox('Tidal Drift').closest('[role="row"]')
    expect(doneRow?.textContent).toContain('Download: Done')
    const failedRow = checkbox('Low Sun (Extended Mix)').closest('[role="row"]')
    if (!(failedRow instanceof HTMLElement)) throw new Error('No row')
    expect(failedRow.textContent).toContain('Download: Failed')
    expect(within(failedRow).getByTitle('This video is private.')).toBeTruthy()
  })

  it("follows a download's progress in its row's chip without rendering any row again", async () => {
    const { queryClient } = renderView()
    const [first] = playlist.entries
    if (first === undefined) throw new Error('fixture')
    const job = jobWith({
      id: testUuid(33),
      status: 'downloading',
      track: toTrackRef(first),
      startedAt: '2026-10-02T08:00:00.000Z',
      progress: { percent: 10 },
    })
    const stream = await liveDownloads(queryClient, snapshotWith({ jobs: [job] }))
    const row = checkbox('Tidal Drift').closest('[role="row"]')
    expect(row?.textContent).toContain('Download: 10 %')
    const before = rowRenders()

    await stream.send({ type: 'job.progress', jobId: job.id, progress: { percent: 42 } })
    expect(row?.textContent).toContain('Download: 42 %')
    expect(rowRenders()).toBe(before)
  })
})
