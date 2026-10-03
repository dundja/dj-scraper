import { act, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { bigPlaylist, scSet } from '@/test/resolve.ts'
import { CollectionView } from './collection-view.tsx'
import { ROW_HEIGHT } from './table-layout.ts'
import {
  resetFakeEnrichment,
  scrollEnd,
  scrollToRow,
  setRowsInView,
  stubTableViewport,
  trackList,
  useFakeEnrichment,
} from './test-utils.ts'
import { useEnrichment } from './use-enrichment.ts'

vi.mock('./use-enrichment.ts', () => ({ useEnrichment: vi.fn() }))

let server: ReturnType<typeof fakeApi>

let viewport: ReturnType<typeof stubTableViewport>

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
  vi.mocked(useEnrichment).mockImplementation(useFakeEnrichment)
  resetFakeEnrichment()
  // A list box ten rows tall.
  viewport = stubTableViewport(10)
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

const big = bigPlaylist(5000)

function renderView(collection = big) {
  const result = renderWithQueryClient(
    <CollectionView collection={collection} onOpenList={() => {}} />,
  )
  return { ...result, user: userEvent.setup() }
}

/** The titles of the rows in the DOM, in order. */
function renderedTitles(): string[] {
  return within(trackList())
    .getAllByRole('row')
    .map((row) => row.querySelector('[title]')?.getAttribute('title') ?? '')
}

/** The rows in view the table last reported for enrichment. */
const lastInView = () => setRowsInView.mock.lastCall?.[0]
const span = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) }, (_, i) => (from < to ? from + i : from - i))

describe('TrackTable at 5,000 rows', () => {
  it('renders only the rows in view plus a few', () => {
    renderView()
    const titles = renderedTitles()
    expect(titles[0]).toBe('Track 1')
    expect(titles.length).toBeGreaterThanOrEqual(10)
    expect(titles.length).toBeLessThan(30)
    expect(screen.queryByText('Track 5000')).toBeNull()

    const table = screen.getByRole('table', { name: 'Tracks' })
    expect(table.getAttribute('aria-rowcount')).toBe('5001')
    // The list is as tall as all rows, so the scrollbar is true to the length.
    const sizer = trackList().firstElementChild
    expect(sizer instanceof HTMLElement && sizer.style.height).toBe(`${5000 * ROW_HEIGHT}px`)
    // Every row is still selected and counted.
    expect(screen.getByRole('button', { name: 'Download 5,000 tracks' })).toBeTruthy()
  })

  it('renders the rows scrolled into view, and reports them for enrichment', async () => {
    renderView()
    // The 10 rows in view, then 5 below.
    expect(lastInView()).toEqual(span(0, 15))

    await scrollToRow(2500)
    const titles = renderedTitles()
    expect(titles).toContain('Track 2501')
    expect(titles).toContain('Track 2510')
    expect(titles).not.toContain('Track 1')
    expect(titles.length).toBeLessThan(30)
    expect(lastInView()).toEqual([...span(2500, 2515), ...span(2499, 2494)])

    await scrollToRow(4990)
    expect(renderedTitles().at(-1)).toBe('Track 5000')
    expect(lastInView()).toEqual([...span(4990, 5000), ...span(4989, 4984)])
  })

  it('reports only the rows a filter shows, as collection indexes', async () => {
    const { user } = renderView()
    const filter = screen.getByRole('textbox', { name: 'Filter tracks' })
    await user.type(filter, '4999')
    expect(renderedTitles()).toEqual(['Track 4999'])
    expect(lastInView()).toEqual([4998])

    // Tracks 999, 1999, …, 4999: the 4,000 hidden rows between them are never in view.
    await user.clear(filter)
    await user.type(filter, '999')
    expect(lastInView()).toEqual([998, 1998, 2998, 3998, 4998])

    await user.clear(filter)
    await user.type(filter, 'x')
    expect(lastInView()).toEqual([])
  })

  it('reports the rows of a short list', () => {
    renderView(scSet)
    expect(lastInView()).toEqual(span(0, 8))
  })

  it('jumps to the last row with End and focuses it, and back with Home', async () => {
    const { user } = renderView()
    act(() => screen.getByRole('checkbox', { name: 'Select Track 1' }).focus())

    await user.keyboard('{End}')
    await scrollEnd()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select Track 5000' }))
    // Rendered after the list scrolled, then brought into the page's view too.
    expect(viewport.scrollIntoView.mock.contexts.at(-1)).toBe(document.activeElement)
    expect(viewport.scrollIntoView.mock.lastCall).toEqual([{ block: 'nearest' }])
    expect(screen.queryByText('Track 1')).toBeNull()
    expect(lastInView()).toEqual([...span(4990, 5000), ...span(4989, 4984)])

    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select Track 4999' }))

    await user.keyboard('{Home}')
    await scrollEnd()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select Track 1' }))
  })

  it('pages with Page Down and Page Up', async () => {
    const { user } = renderView()
    act(() => screen.getByRole('checkbox', { name: 'Select Track 1' }).focus())

    await user.keyboard('{PageDown}')
    await scrollEnd()
    const focused = document.activeElement?.getAttribute('aria-label')
    expect(focused).toMatch(/^Select Track (9|10|11)$/)

    await user.keyboard('{PageUp}')
    await scrollEnd()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Select Track 1' }))
  })

  it('selects and deselects all 5,000 rows', async () => {
    const { user } = renderView()
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('status').textContent).toBe('None selected')
    await user.click(screen.getByRole('button', { name: 'Invert selection' }))
    expect(screen.getByRole('status').textContent).toBe('5,000 selected')
    expect(screen.getByText(/^5,000 selected · /)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download 5,000 tracks' })).toBeTruthy()
  })
})
