import {
  type Collection,
  type CreateDownloadsResponse,
  DownloadRequestSchema,
  SettingsSchema,
  SettingsUpdateSchema,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { act, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toTrackRef } from '@/features/downloads/track-ref.ts'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, networkError, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import {
  PLAYLIST_SPECIAL_ROWS,
  playlist,
  SC_SET_API_URL_ROW,
  scSet,
  scSetTracks,
} from '@/test/resolve.ts'
import { CollectionView } from './collection-view.tsx'
import {
  enrich,
  readyRow,
  resetFakeEnrichment,
  rowsWith,
  stubTableViewport,
  useFakeEnrichment,
} from './test-utils.ts'
import { useEnrichment } from './use-enrichment.ts'

vi.mock('./use-enrichment.ts', () => ({ useEnrichment: vi.fn() }))

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  vi.mocked(useEnrichment).mockImplementation(useFakeEnrichment)
  resetFakeEnrichment()
  stubTableViewport(40)
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

function serveSettings(changes: Partial<typeof settings> = {}) {
  server.on('GET /api/settings', () => json(SettingsSchema.parse({ ...settings, ...changes })))
}

function renderView(collection: Collection = playlist) {
  const result = renderWithQueryClient(
    <CollectionView collection={collection} onOpenList={() => {}} />,
  )
  return { ...result, user: userEvent.setup() }
}

const created = (count: number, duplicates = 0): CreateDownloadsResponse => ({
  ...(duplicates < count ? { batchId: testUuid(100) } : {}),
  jobIds: Array.from({ length: count }, (_, index) => testUuid(index + 1)),
  duplicates,
})

/** The body of the n-th `POST /api/downloads`, checked against the contract. */
const sent = (n = 0) =>
  DownloadRequestSchema.parse(jsonBody(server.callsTo('POST /api/downloads')[n]))

const isDisabled = (button: HTMLElement) =>
  button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled')

const subfolderSwitch = () => screen.getByRole('switch', { name: /^Into a subfolder: / })

/** Waits for the settings to arrive: the folder shows, and the button can be used. */
const findFolder = () => screen.findByText('~/Music/DJ Scraper')

describe('DownloadBar', () => {
  it('shows the folder (read-only), the format and the subfolder switch', async () => {
    serveSettings()
    renderView()
    const folder = await findFolder()
    expect(folder.closest('[title]')?.getAttribute('title')).toBe(
      '/Users/dj/Music/DJ Scraper (change it in the header)',
    )
    expect(screen.getByText('Format')).toBeTruthy()
    const toggle = subfolderSwitch()
    expect(toggle.closest('label')?.textContent).toBe('Into a subfolder: Warm-up Selection')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(isDisabled(screen.getByRole('button', { name: 'Download 27 tracks' }))).toBe(false)
  })

  it('sends the selected rows in table order, each track once, with the settings', async () => {
    serveSettings()
    server.on('POST /api/downloads', () => json(created(26)))
    const { user } = renderView()
    await findFolder()
    await user.click(screen.getByRole('checkbox', { name: 'Select Glasshouse' }))
    await user.click(screen.getByRole('button', { name: 'Download 26 tracks' }))

    const body = sent()
    const left = new Set<number>([
      PLAYLIST_SPECIAL_ROWS.privateVideo,
      PLAYLIST_SPECIAL_ROWS.deletedVideo,
      PLAYLIST_SPECIAL_ROWS.duplicateOf5,
      3,
    ])
    const expected = playlist.entries.filter((_, index) => !left.has(index)).map(toTrackRef)
    expect(body.items).toEqual(expected)
    expect(body.folder).toBe(settings.folder)
    expect(body.options).toEqual({
      format: 'mp3',
      filenameTemplate: '{artist} - {title}',
      embedArtwork: true,
      sourceUrlComment: true,
    })
    expect(body.label).toBe('Warm-up Selection')
    expect(await screen.findByText('Queued 26 tracks — see Downloads.')).toBeTruthy()
  })

  it('downloads into a subfolder named after the list when the switch is on', async () => {
    serveSettings({ playlistSubfolder: true })
    server.on('POST /api/downloads', () => json(created(27)))
    const { user } = renderView()
    await findFolder()
    expect(screen.getByText('/Warm-up Selection')).toBeTruthy()
    expect(subfolderSwitch().getAttribute('aria-checked')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
    expect(sent().options.subfolder).toBe('Warm-up Selection')
  })

  it('names the subfolder as the server will, safe for every file system', async () => {
    serveSettings({ playlistSubfolder: true })
    server.on('POST /api/downloads', () => json(created(27)))
    const { user } = renderView({ ...playlist, title: 'Sets: 2026/27 <live>' })
    await findFolder()
    expect(subfolderSwitch().closest('label')?.textContent).toBe(
      'Into a subfolder: Sets - 2026-27 live',
    )
    expect(screen.getByText('/Sets - 2026-27 live')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
    // The server sanitizes the title it is sent.
    expect(sent().options.subfolder).toBe('Sets: 2026/27 <live>')
    expect(sent().label).toBe('Sets: 2026/27 <live>')
  })

  it.each(['???', '...', '***'])(
    'downloads into the folder itself when the title %j can name no subfolder',
    async (title) => {
      serveSettings({ playlistSubfolder: true })
      server.on('POST /api/downloads', () => json(created(27)))
      const { user } = renderView({ ...playlist, title })
      await findFolder()
      // The switch stays the setting it is, and says why it doesn't apply.
      const toggle = screen.getByRole('switch', {
        name: "Into a subfolder (this list's title can't name one)",
      })
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      expect(screen.queryByText(`/${title}`)).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
      expect(sent().options.subfolder).toBeUndefined()
      expect(sent().label).toBe(title)
      expect(await screen.findByText('Queued 27 tracks — see Downloads.')).toBeTruthy()
    },
  )

  it('sticks to the bottom only on wide screens, so it never covers the table below them', async () => {
    serveSettings()
    renderView()
    await findFolder()
    const bar = document.querySelector('[data-slot="download-bar"]')
    const classes = bar?.className.split(/\s+/) ?? []
    expect(classes).toEqual(expect.arrayContaining(['lg:sticky', 'lg:bottom-0']))
    expect(classes).not.toContain('sticky')
  })

  it('saves the subfolder switch to the settings', async () => {
    serveSettings()
    server.on('PUT /api/settings', (call) =>
      json({ ...settings, ...SettingsUpdateSchema.parse(jsonBody(call)) }),
    )
    server.on('POST /api/downloads', () => json(created(27)))
    const { user } = renderView()
    await findFolder()

    await user.click(subfolderSwitch())
    expect(subfolderSwitch().getAttribute('aria-checked')).toBe('true')
    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ playlistSubfolder: true })

    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
    expect(sent().options.subfolder).toBe('Warm-up Selection')
  })

  it('sends what enrichment filled in, and partial rows as they are', async () => {
    serveSettings()
    server.on('POST /api/downloads', () => json(created(8)))
    const { user } = renderView(scSet)
    await findFolder()
    const full = scSetTracks[2]
    if (full === undefined) throw new Error('fixture')
    enrich(rowsWith(scSet.entries, { 2: readyRow(full) }))
    await user.click(screen.getByRole('button', { name: 'Download 8 tracks' }))

    const { items } = sent()
    expect(items).toHaveLength(8)
    expect(items[2]).toEqual(toTrackRef(full))
    expect(items[2]?.title).toBe('Tram Lines')
    // A row still partial goes as id + url (an API URL until enriched): the server looks it up.
    expect(items[SC_SET_API_URL_ROW]).toEqual({
      platform: 'soundcloud',
      id: '1501000008',
      url: 'https://api-v2.soundcloud.com/tracks/1501000008',
      availability: 'unknown',
    })
  })

  it('says which tracks were in the queue already', async () => {
    serveSettings()
    server.on('POST /api/downloads', () => json(created(27, 3)))
    const { user } = renderView()
    await findFolder()
    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
    expect(
      await screen.findByText('Queued 24 tracks — see Downloads. 3 were already in the queue.'),
    ).toBeTruthy()
  })

  it('shows a refusal with its next step', async () => {
    serveSettings()
    server.on('POST /api/downloads', () =>
      json(
        {
          error: {
            code: 'folder_unavailable',
            message: 'The folder /Users/dj/Music/DJ Scraper is gone.',
          },
        },
        422,
      ),
    )
    const { user } = renderView()
    await findFolder()
    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The folder /Users/dj/Music/DJ Scraper is gone.')
    expect(alert.textContent).toContain('You can pick another folder in the header.')
  })

  it('says when the server is offline', async () => {
    serveSettings()
    server.on('POST /api/downloads', networkError)
    const { user } = renderView()
    await findFolder()
    await user.click(screen.getByRole('button', { name: 'Download 27 tracks' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Can't reach the DJ Scraper server.")
  })

  it('keeps the button (and focus) while queuing, without sending twice', async () => {
    serveSettings()
    server.on('POST /api/downloads', noAnswer)
    const { user } = renderView()
    await findFolder()
    const button = screen.getByRole('button', { name: 'Download 27 tracks' })
    await user.click(button)

    expect(button.textContent).toBe('Queuing…')
    expect(isDisabled(button)).toBe(true)
    expect(document.activeElement).toBe(button)
    await user.click(button)
    expect(server.callsTo('POST /api/downloads')).toHaveLength(1)
  })

  it('asks for a selection when nothing is selected', async () => {
    serveSettings()
    const { user } = renderView()
    await findFolder()
    await user.click(screen.getByRole('button', { name: 'Select none' }))
    const button = screen.getByRole('button', { name: 'Select tracks' })
    expect(isDisabled(button)).toBe(true)
    await user.click(button)
    expect(server.callsTo('POST /api/downloads')).toHaveLength(0)
  })

  it('waits for the settings before it can download', async () => {
    server.on('GET /api/settings', noAnswer)
    renderView()
    await act(() => Promise.resolve())
    expect(isDisabled(screen.getByRole('button', { name: 'Download 27 tracks' }))).toBe(true)
    expect(subfolderSwitch().hasAttribute('data-disabled')).toBe(true)
  })

  it('says when the settings cant be loaded', async () => {
    server.on('GET /api/settings', networkError)
    renderView()
    expect(
      await screen.findByText("Folder unknown: Can't reach the DJ Scraper server."),
    ).toBeTruthy()
  })
})
