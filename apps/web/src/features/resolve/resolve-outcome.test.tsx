// What shows under the paste box: loading, the result (handed to the track card or collection
// doubles, testing/fake-result-views.tsx), the "this track or the whole list?" prompt, and errors.
import type { ErrorCode, Settings } from '@dj-scraper/shared'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsQueryKey } from '@/features/settings/use-settings.ts'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, networkError, noAnswer, text } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import {
  ambiguous,
  collectionResult,
  playlist,
  previewTrack,
  scSet,
  trackResult,
  urls,
  userPageWithLists,
} from '@/test/resolve.ts'
import { ResolvePage } from './resolve-page.tsx'
import { viewMounts } from './testing/result-view-log.ts'
import { DRM_MESSAGE } from './url-verdict.ts'

vi.mock('@/features/track/track-card.tsx', () => import('./testing/fake-result-views.tsx'))
vi.mock(
  '@/features/collection/collection-view.tsx',
  () => import('./testing/fake-result-views.tsx'),
)

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  server.on('GET /api/settings', () => json(settings))
  viewMounts.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  expect(server.unhandled).toEqual([])
})

type User = ReturnType<typeof userEvent.setup>

const urlBox = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'YouTube or SoundCloud link' })
const resolveCalls = () => server.callsTo('POST /api/resolve')
const resolveBodies = () => resolveCalls().map((call) => jsonBody(call))
const status = () => screen.getByRole('status')
const apiError = (code: ErrorCode, message: string, status = 422) =>
  json({ error: { code, message } }, status)

/** Types `url` into the box and presses Enter. */
async function load(user: User, url: string) {
  await user.clear(urlBox())
  await user.type(urlBox(), `${url}{Enter}`)
}

/** Loads `url` without userEvent, for tests on Vitest's fake clock. */
function loadNow(url: string) {
  fireEvent.change(urlBox(), { target: { value: url } })
  const form = urlBox().closest('form')
  if (form === null) throw new Error('the link box is not in a form')
  fireEvent.submit(form)
}

const skeleton = (shape: 'track' | 'list') =>
  document.querySelector(`[data-slot="${shape}-skeleton"]`)

describe('while a link loads', () => {
  it('shows a skeleton shaped like the result it expects, and announces it', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)
    expect(await screen.findByText('Loading the track…', { selector: 'span' })).toBeTruthy()
    expect(skeleton('track')).not.toBeNull()
    expect(skeleton('list')).toBeNull()
    expect(status().textContent).toBe('Loading the track…')
    // A track card is as wide as the card it turns into.
    expect(skeleton('track')?.closest('[aria-busy]')?.className).toContain('max-w-3xl')

    await load(user, urls.playlist)
    expect(await screen.findByText('Loading the list…', { selector: 'span' })).toBeTruthy()
    expect(skeleton('list')).not.toBeNull()
    expect(skeleton('track')).toBeNull()
    // A list spans the column like the collection it turns into, so nothing jumps sideways.
    expect(skeleton('list')?.closest('[aria-busy]')?.className).not.toContain('max-w-3xl')
  })

  it('replaces the last result with the skeleton while the next link loads', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.track)
    await screen.findByRole('article', { name: 'Track card: The Chill Zone' })

    server.on('POST /api/resolve', noAnswer)
    await load(user, urls.playlist)

    expect(await screen.findByText('Loading the list…', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('shows the seconds after 3 s, and for a YouTube list why it takes a while', async () => {
    vi.useFakeTimers()
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    server.on('POST /api/resolve', noAnswer)
    renderWithQueryClient(<ResolvePage />)

    loadNow(urls.playlist)
    await advance(2001)
    expect(screen.queryByText('2 s')).toBeNull()
    expect(screen.queryByText(/Big lists take a while/)).toBeNull()

    await advance(1000)
    expect(screen.getByText('3 s')).toBeTruthy()
    expect(
      screen.getByText('Big lists take a while: 1,800 videos ≈ 20 s, 5,000 ≈ 1 min.'),
    ).toBeTruthy()

    await advance(5000)
    expect(screen.getByText('8 s')).toBeTruthy()
    // The live region said it once; the ticking seconds aren't announced.
    expect(status().textContent).toBe('Loading the list…')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(resolveCalls()[0]?.signal?.aborted).toBe(true)
    await advance(2000)
    expect(screen.queryByText(/ s$/)).toBeNull()
  })

  it('keeps the note general for other platforms, and leaves it out for a track', async () => {
    vi.useFakeTimers()
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    server.on('POST /api/resolve', noAnswer)
    renderWithQueryClient(<ResolvePage />)

    loadNow(urls.scSet)
    await advance(3001)
    expect(screen.getByText('Big lists take a while.')).toBeTruthy()

    // A new resolve starts its own count.
    loadNow(urls.track)
    await advance(1)
    expect(screen.queryByText('3 s')).toBeNull()
    await advance(3000)
    expect(screen.getByText('3 s')).toBeTruthy()
    expect(screen.queryByText(/Big lists take a while/)).toBeNull()
  })
})

describe('a track', () => {
  it('shows the track card, auto-downloading when the setting says so', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)

    const card = await screen.findByRole('article', { name: 'Track card: The Chill Zone' })
    expect(card.dataset.autoStart).toBe('true')
    expect(status().textContent).toBe('Track: The Chill Zone')
  })

  it("doesn't auto-download when the setting is off", async () => {
    server.on('GET /api/settings', () => json({ ...settings, autoDownloadSingles: false }))
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)

    const card = await screen.findByRole('article', { name: 'Track card: The Chill Zone' })
    expect(card.dataset.autoStart).toBe('false')
  })

  it('never auto-downloads an unavailable track', async () => {
    server.on('POST /api/resolve', () => json(trackResult(previewTrack)))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, 'https://soundcloud.com/the-concept-band/world-on-fire-1')

    const card = await screen.findByRole('article', { name: 'Track card: World On Fire' })
    expect(card.dataset.autoStart).toBe('false')
  })

  it('mounts a fresh card for every paste, even of the same link', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)
    await screen.findByRole('article', { name: 'Track card: The Chill Zone' })
    await user.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(viewMounts).toHaveLength(2))

    const mount = { view: 'track', id: 'XNEnEBrHws8', autoStart: true }
    expect(viewMounts).toEqual([mount, mount])
  })

  it('waits for the settings before mounting the card', async () => {
    let answerSettings = (_response: Response) => {}
    server.on(
      'GET /api/settings',
      () => new Promise<Response>((resolve) => (answerSettings = resolve)),
    )
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)
    await waitFor(() => expect(status().textContent).toBe('Track: The Chill Zone'))
    expect(skeleton('track')).not.toBeNull()
    expect(screen.queryByRole('article')).toBeNull()

    answerSettings(json(settings))

    const card = await screen.findByRole('article', { name: 'Track card: The Chill Zone' })
    expect(card.dataset.autoStart).toBe('true')
  })

  it('keeps the auto-download it mounted with when the settings change later', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    const { queryClient } = renderWithQueryClient(<ResolvePage />)
    await load(user, urls.track)
    await screen.findByRole('article', { name: 'Track card: The Chill Zone' })

    await act(async () => {
      queryClient.setQueryData<Settings>(settingsQueryKey, {
        ...settings,
        autoDownloadSingles: false,
      })
      // TanStack Query tells React on a 0 ms timer.
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(screen.getByRole('article').dataset.autoStart).toBe('true')
    expect(viewMounts).toHaveLength(1)
  })
})

describe('a collection', () => {
  it('shows the collection view and announces what loaded', async () => {
    server.on('POST /api/resolve', () => json(collectionResult(playlist)))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.playlist)

    expect(
      await screen.findByRole('region', { name: 'Collection: Warm-up Selection' }),
    ).toBeTruthy()
    expect(status().textContent).toBe('Playlist: Warm-up Selection, 30 tracks')
  })

  it('opens a list the collection links to, showing its URL in the box', async () => {
    server.on('POST /api/resolve', () => json(collectionResult(userPageWithLists)))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.userSets)
    const page = await screen.findByRole('region', { name: 'Collection: The Royal Concept (Sets)' })

    server.on('POST /api/resolve', () => json(collectionResult(scSet)))
    await user.click(within(page).getByRole('button', { name: 'Royal EP' }))

    expect(
      await screen.findByRole('region', { name: 'Collection: Late Night Selects' }),
    ).toBeTruthy()
    const royalEp = 'https://soundcloud.com/the-concept-band/sets/royal-ep'
    expect(resolveBodies()).toEqual([{ url: urls.userSets }, { url: royalEp }])
    expect(urlBox().value).toBe(royalEp)
    expect(viewMounts.map((mount) => mount.id)).toEqual([userPageWithLists.id, scSet.id])
  })
})

describe('a track in a list', () => {
  it('asks whether to load the track or the whole playlist, showing the track', async () => {
    server.on('POST /api/resolve', () => json(ambiguous.playlist))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.watchList)

    const prompt = await screen.findByRole('region', { name: 'This track or the whole playlist?' })
    expect(prompt.textContent).toContain('dlp test video title primary (en-GB)')
    expect(prompt.textContent).toContain('cole-dlp-test-acc · 0:05')
    expect(within(prompt).getByRole('button', { name: 'This track' })).toBeTruthy()
    expect(within(prompt).getByRole('button', { name: 'Whole playlist' })).toBeTruthy()
    expect(status().textContent).toBe('This track or the whole playlist?')
    // Neither choice is the default, so the focus stays where it was.
    expect(document.activeElement).toBe(urlBox())
  })

  it('words the choice for an album', async () => {
    server.on('POST /api/resolve', () => json(ambiguous.album))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.watchList)

    const prompt = await screen.findByRole('region', { name: 'This track or the whole album?' })
    expect(within(prompt).getByRole('button', { name: 'Whole album' })).toBeTruthy()
  })

  it('makes the track the default for a mix, which loads only its first 50', async () => {
    server.on('POST /api/resolve', () => json(ambiguous.mix))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.mix)

    const prompt = await screen.findByRole('region', { name: 'This track or the mix?' })
    const thisTrack = within(prompt).getByRole('button', { name: 'This track' })
    await waitFor(() => expect(document.activeElement).toBe(thisTrack))
    expect(within(prompt).getByRole('button', { name: 'Load the mix (first 50)' })).toBeTruthy()

    // Enter takes the default.
    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('article', {
        name: 'Track card: Never Gonna Give You Up (Official Video) (4K Remaster)',
      }),
    ).toBeTruthy()
  })

  it('shows the track already looked up for This track, without resolving again', async () => {
    server.on('POST /api/resolve', () => json(ambiguous.playlist))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.watchList)

    await user.click(await screen.findByRole('button', { name: 'This track' }))

    const card = await screen.findByRole('article', {
      name: 'Track card: dlp test video title primary (en-GB)',
    })
    expect(card.dataset.autoStart).toBe('true')
    expect(screen.queryByRole('region', { name: /^This track or/ })).toBeNull()
    expect(resolveCalls()).toHaveLength(1)
    expect(document.activeElement).toBe(urlBox())
  })

  it('lists the whole playlist in collection mode, showing its URL in the box', async () => {
    server.on('POST /api/resolve', () => json(ambiguous.playlist))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.watchList)

    server.on('POST /api/resolve', () => json(collectionResult(playlist)))
    await user.click(await screen.findByRole('button', { name: 'Whole playlist' }))

    expect(
      await screen.findByRole('region', { name: 'Collection: Warm-up Selection' }),
    ).toBeTruthy()
    const { collectionUrl } = ambiguous.playlist
    expect(resolveBodies()).toEqual([
      { url: urls.watchList },
      { url: collectionUrl, mode: 'collection' },
    ])
    expect(urlBox().value).toBe(collectionUrl)
    expect(document.activeElement).toBe(urlBox())
  })
})

describe('a link that fails', () => {
  it("shows the server's message with a next step, and tries again", async () => {
    const message = "YouTube wants to check that you're not a bot. Try again later."
    server.on('POST /api/resolve', () => apiError('bot_check', message))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      `${message}Updating yt-dlp usually fixes this: brew upgrade yt-dlp.`,
    )
    expect(alert.querySelector('code')?.textContent).toBe('brew upgrade yt-dlp')
    expect(screen.queryByRole('button', { name: /^Open the/ })).toBeNull()

    server.on('POST /api/resolve', () => json(trackResult()))
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('article', { name: 'Track card: The Chill Zone' })).toBeTruthy()
    expect(resolveBodies()).toEqual([{ url: urls.track }, { url: urls.track }])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(urlBox())
  })

  it('puts the link back in the box for Try again, and announces the new load', async () => {
    server.on('POST /api/resolve', () => apiError('private', 'Private video.'))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.track)
    await screen.findByRole('alert')
    // Something else typed (not loaded yet) doesn't stay in the box while the old link loads.
    await user.clear(urlBox())
    await user.type(urlBox(), 'hello')

    server.on('POST /api/resolve', noAnswer)
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(urlBox().value).toBe(urls.track)
    expect(urlBox().getAttribute('aria-invalid')).toBeNull()
    expect(status().textContent).toBe('Loading the track…')
    expect(document.activeElement).toBe(urlBox())
    expect(resolveBodies()).toEqual([{ url: urls.track }, { url: urls.track }])
  })

  it.each([
    ['text that is no link', 'hello', "That doesn't look like a link."],
    ['a DRM service', urls.drm, DRM_MESSAGE],
  ])('clears the error when %s is loaded after it', async (_, refused, message) => {
    server.on('POST /api/resolve', () => apiError('private', 'Private video.'))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.track)
    await screen.findByRole('alert')

    await load(user, refused)

    // No Try again left to load the old link under the refused text.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Paste a YouTube or SoundCloud link' })).toBeTruthy()
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(status().textContent).toBe(message)
    expect(resolveCalls()).toHaveLength(1)
  })

  it('says the server is offline when nothing answers', async () => {
    server.on('POST /api/resolve', networkError)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Server offline')).toBeTruthy()
    expect(alert.textContent).toContain("Can't reach the DJ Scraper server.")
    expect(alert.querySelector('code')?.textContent).toBe('pnpm dev')
  })

  it("takes Vite's 502 while the server is down for offline too", async () => {
    server.on('POST /api/resolve', () => text('', 502))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.playlist)

    expect(within(await screen.findByRole('alert')).getByText('Server offline')).toBeTruthy()
  })

  it("still offers the playlist when a watch+list link's track can't be loaded", async () => {
    server.on('POST /api/resolve', () => apiError('private', 'Private video.'))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    await load(user, urls.watchList)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Private video.The playlist itself may still load.')

    server.on('POST /api/resolve', () => json(collectionResult(playlist)))
    await user.clear(urlBox())
    await user.click(screen.getByRole('button', { name: 'Open the playlist' }))

    expect(
      await screen.findByRole('region', { name: 'Collection: Warm-up Selection' }),
    ).toBeTruthy()
    expect(resolveBodies()).toEqual([
      { url: urls.watchList },
      { url: urls.watchList, mode: 'collection' },
    ])
    expect(urlBox().value).toBe(urls.watchList)
    expect(document.activeElement).toBe(urlBox())
  })

  it('words the way out for a mix', async () => {
    server.on('POST /api/resolve', () =>
      apiError('age_restricted', 'Age-restricted: needs browser cookies.'),
    )
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.mix)

    expect(await screen.findByRole('button', { name: 'Open the mix (first 50)' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(
      'DJ Scraper has no sign-ins yet; they come in a later version.',
    )
  })

  it('offers no list for a link that names no list', async () => {
    server.on('POST /api/resolve', () => apiError('private', 'Private video.'))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await load(user, urls.track)

    expect((await screen.findByRole('alert')).textContent).toBe('Private video.')
    expect(screen.queryByRole('button', { name: /^Open the/ })).toBeNull()
  })
})

describe('before anything loads', () => {
  it('says what a paste does, by the auto-download setting', async () => {
    server.on('GET /api/settings', () => json({ ...settings, autoDownloadSingles: false }))
    renderWithQueryClient(<ResolvePage />)

    expect(
      await screen.findByText(
        'A single track shows a Download button; for a playlist, set or album you pick the tracks first.',
      ),
    ).toBeTruthy()
  })
})
