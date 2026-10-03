// The ways into a resolve: typing, paste anywhere, drop, and stopping one. The result views other
// packages own are swapped for doubles (testing/fake-result-views.tsx): these tests check what the
// page hands them, not how they render.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { scTrack, trackResult, urls } from '@/test/resolve.ts'
import { ResolvePage } from './resolve-page.tsx'
import { viewMounts } from './testing/result-view-log.ts'

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
  expect(server.unhandled).toEqual([])
})

const urlBox = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'YouTube or SoundCloud link' })

function pasteForm(): HTMLElement {
  const form = urlBox().closest('form')
  if (form === null) throw new Error('the link box is not in a form')
  return form
}

/** The texts the link box's aria-describedby points at, as a screen reader reads them. */
function description(): string {
  const ids = urlBox().getAttribute('aria-describedby')?.split(' ') ?? []
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' | ')
}

const resolveCalls = () => server.callsTo('POST /api/resolve')
const resolveBodies = () => resolveCalls().map((call) => jsonBody(call))
const status = () => screen.getByRole('status')

/** A drag's DataTransfer as fireEvent hands it to the page (jsdom has none of its own). */
const dragData = (types: string[], formats: Record<string, string> = {}) => ({
  dataTransfer: { types, getData: (format: string) => formats[format] ?? '', dropEffect: 'none' },
})
const LINK_DRAG = ['text/uri-list', 'text/plain']

const overlay = () => screen.queryByText('Drop the link to load it')

describe('typing a link', () => {
  it('focuses the link box on load, under an empty state that explains the paste', () => {
    renderWithQueryClient(<ResolvePage />)

    expect(document.activeElement).toBe(urlBox())
    expect(screen.getByRole('heading', { name: 'Paste a YouTube or SoundCloud link' })).toBeTruthy()
  })

  it('guesses the platform and kind as you type, before anything resolves', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), urls.playlist)
    const form = within(pasteForm())
    expect(form.getByText('YouTube')).toBeTruthy()
    expect(form.getByText('Playlist')).toBeTruthy()
    expect(description()).toBe('Detected: YouTubePlaylist')

    await user.clear(urlBox())
    await user.type(urlBox(), urls.watchList)
    expect(form.getByText('Track in a playlist')).toBeTruthy()

    await user.clear(urlBox())
    await user.type(urlBox(), 'soundcloud.com/crate-diggers/sets/late-night-selects')
    expect(form.getByText('SoundCloud')).toBeTruthy()
    expect(form.getByText('Set')).toBeTruthy()

    expect(resolveCalls()).toEqual([])
  })

  it('loads the link on Enter and on Go, normalized', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), 'youtu.be/XNEnEBrHws8{Enter}')
    await screen.findByRole('article', { name: 'Track card: The Chill Zone' })
    await user.click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => expect(resolveCalls()).toHaveLength(2))
    // Auto mode leaves `mode` out; the box keeps what was typed.
    expect(resolveBodies()).toEqual([
      { url: 'https://youtu.be/XNEnEBrHws8' },
      { url: 'https://youtu.be/XNEnEBrHws8' },
    ])
    expect(urlBox().value).toBe('youtu.be/XNEnEBrHws8')
  })

  it('says why text is not a link, as an error once you try to load it', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), 'hello')
    expect(description()).toBe("That doesn't look like a link.")
    expect(urlBox().getAttribute('aria-invalid')).toBeNull()

    await user.keyboard('{Enter}')
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(status().textContent).toBe("That doesn't look like a link.")

    // Editing the text takes the error back to a note.
    await user.type(urlBox(), ' there')
    expect(urlBox().getAttribute('aria-invalid')).toBeNull()
    expect(resolveCalls()).toEqual([])
  })

  it('asks for a link when the box is empty', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    expect(urlBox().getAttribute('aria-describedby')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Go' }))

    expect(description()).toBe('Paste a YouTube or SoundCloud link.')
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(resolveCalls()).toEqual([])
  })

  it('refuses a DRM service without resolving it', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), urls.drm)
    expect(within(pasteForm()).getByText('DRM service: not supported')).toBeTruthy()
    expect(description()).toContain('DRM-protected')

    await user.keyboard('{Enter}')
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(status().textContent).toContain('DRM-protected')
    expect(resolveCalls()).toEqual([])
  })
})

describe('paste anywhere', () => {
  it('loads the link from text pasted with nothing focused', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    act(() => urlBox().blur())

    await user.paste(`this one 🔥 ${urls.track}, so good`)

    expect(await screen.findByRole('article', { name: 'Track card: The Chill Zone' })).toBeTruthy()
    expect(resolveBodies()).toEqual([{ url: urls.track }])
    expect(urlBox().value).toBe(urls.track)
    // The box shows what loads, and has the focus for the next paste.
    expect(document.activeElement).toBe(urlBox())
  })

  it('moves ⌘V outside a text field into the box, its text selected for the paste to replace', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <>
        <input aria-label="Filter" />
        <ResolvePage />
      </>,
    )
    const filter = screen.getByRole('textbox', { name: 'Filter' })
    await user.type(urlBox(), 'old link')
    // Only the keydown: userEvent would also type the "v", which a browser's ⌘V doesn't.
    const pasteKey = (target: Element, modifiers: Partial<KeyboardEventInit>) =>
      fireEvent.keyDown(target, { key: 'v', code: 'KeyV', ...modifiers })

    act(() => urlBox().blur())
    pasteKey(document.body, { metaKey: true })
    expect(document.activeElement).toBe(urlBox())
    expect([urlBox().selectionStart, urlBox().selectionEnd]).toEqual([0, 'old link'.length])

    act(() => urlBox().blur())
    pasteKey(document.body, { ctrlKey: true, shiftKey: true })
    expect(document.activeElement).toBe(urlBox())

    // Another text field keeps its paste, and neither ⌥⌘V nor a plain V is a paste.
    act(() => filter.focus())
    pasteKey(filter, { metaKey: true })
    expect(document.activeElement).toBe(filter)
    act(() => filter.blur())
    pasteKey(document.body, { metaKey: true, altKey: true })
    pasteKey(document.body, {})
    expect(document.activeElement).toBe(document.body)
    expect(resolveCalls()).toEqual([])
  })

  it('loads a link pasted into the box at once, replacing what was there', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), 'half a li')
    await user.paste(urls.track)

    expect(urlBox().value).toBe(urls.track)
    await waitFor(() => expect(resolveBodies()).toEqual([{ url: urls.track }]))
  })

  it('pastes other text into the box as text, without loading it', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.click(urlBox())
    await user.paste('watch?v=')

    expect(urlBox().value).toBe('watch?v=')
    expect(resolveCalls()).toEqual([])
  })

  it('leaves a paste into another text field to that field', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(
      <>
        <input aria-label="Filter" />
        <ResolvePage />
      </>,
    )
    const filter = screen.getByRole('textbox', { name: 'Filter' })

    await user.click(filter)
    await user.paste(urls.track)

    expect((filter as HTMLInputElement).value).toBe(urls.track)
    expect(urlBox().value).toBe('')
    expect(resolveCalls()).toEqual([])
  })

  it('puts a pasted non-link into the box and says why it is refused', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    act(() => urlBox().blur())

    await user.paste('Never Gonna Give You Up\nRick Astley')

    expect(urlBox().value).toBe('Never Gonna Give You Up')
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(status().textContent).toBe("That doesn't look like a link.")
    expect(resolveCalls()).toEqual([])
  })

  it('aborts the resolve still running when a new link is pasted', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    act(() => urlBox().blur())

    await user.paste(urls.track)
    await waitFor(() => expect(resolveCalls()).toHaveLength(1))
    server.on('POST /api/resolve', () => json(trackResult(scTrack)))
    await user.paste(urls.scTrack)

    expect(await screen.findByRole('article', { name: 'Track card: Robo Kitty' })).toBeTruthy()
    const [first, second] = resolveCalls()
    expect(first?.signal?.aborted).toBe(true)
    expect(second?.signal?.aborted).toBe(false)
    expect(viewMounts).toEqual([{ view: 'track', id: scTrack.id, autoStart: true }])
  })

  it('leaves a running resolve alone when the paste is refused', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)
    act(() => urlBox().blur())

    await user.paste(urls.track)
    await waitFor(() => expect(resolveCalls()).toHaveLength(1))
    await user.paste(urls.drm)

    expect(resolveCalls()[0]?.signal?.aborted).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(urlBox().value).toBe(urls.drm)
  })
})

describe('drop a link', () => {
  it('shows the overlay while a link is dragged over the window, until it leaves', () => {
    renderWithQueryClient(<ResolvePage />)
    expect(overlay()).toBeNull()

    fireEvent.dragEnter(document.body, dragData(LINK_DRAG))
    expect(overlay()).not.toBeNull()
    // Moving onto an element inside the window enters it before leaving the one before.
    fireEvent.dragEnter(urlBox(), dragData(LINK_DRAG))
    fireEvent.dragLeave(document.body, dragData(LINK_DRAG))
    expect(overlay()).not.toBeNull()
    // The drop is allowed: dragover's default (refusing it) is prevented.
    expect(fireEvent.dragOver(urlBox(), dragData(LINK_DRAG))).toBe(false)

    fireEvent.dragLeave(urlBox(), dragData(LINK_DRAG))
    expect(overlay()).toBeNull()
  })

  it('loads the first link of a dropped URI list', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    renderWithQueryClient(<ResolvePage />)

    fireEvent.dragEnter(document.body, dragData(LINK_DRAG))
    const dropped = fireEvent.drop(
      document.body,
      dragData(LINK_DRAG, { 'text/uri-list': `# from Safari\r\n${urls.track}` }),
    )

    expect(dropped).toBe(false)
    expect(overlay()).toBeNull()
    expect(document.activeElement).toBe(urlBox())
    expect(await screen.findByRole('article', { name: 'Track card: The Chill Zone' })).toBeTruthy()
    expect(resolveBodies()).toEqual([{ url: urls.track }])
    expect(urlBox().value).toBe(urls.track)
  })

  it('loads a link from dropped text', async () => {
    server.on('POST /api/resolve', () => json(trackResult(scTrack)))
    renderWithQueryClient(<ResolvePage />)

    fireEvent.drop(
      urlBox(),
      dragData(['text/plain'], { 'text/plain': `Robo Kitty – ${urls.scTrack}` }),
    )

    expect(await screen.findByRole('article', { name: 'Track card: Robo Kitty' })).toBeTruthy()
    expect(resolveBodies()).toEqual([{ url: urls.scTrack }])
  })

  it('keeps a dropped file from opening in place of the app, and loads nothing', () => {
    renderWithQueryClient(<ResolvePage />)
    const files = dragData(['Files'])
    files.dataTransfer.dropEffect = 'copy'

    fireEvent.dragEnter(document.body, files)
    expect(overlay()).toBeNull()
    // The browser shows the drop as refused, and a drop that comes anyway is canceled.
    expect(fireEvent.dragOver(urlBox(), files)).toBe(false)
    expect(files.dataTransfer.dropEffect).toBe('none')
    expect(fireEvent.drop(document.body, files)).toBe(false)

    expect(overlay()).toBeNull()
    expect(urlBox().value).toBe('')
    expect(resolveCalls()).toEqual([])
  })

  it('leaves text without a link dropped on another text field to that field', () => {
    renderWithQueryClient(
      <>
        <input aria-label="Filter" />
        <ResolvePage />
      </>,
    )
    const filter = screen.getByRole('textbox', { name: 'Filter' })
    const words = () => dragData(['text/plain'], { 'text/plain': 'Artist Name' })

    fireEvent.dragEnter(filter, words())
    // Not canceled: the browser puts the text into the field.
    expect(fireEvent.drop(filter, words())).toBe(true)

    expect(overlay()).toBeNull()
    expect(urlBox().value).toBe('')
    expect(urlBox().getAttribute('aria-invalid')).toBeNull()
    expect(description()).toBe('')

    // Dropped on the link box, the same text is the box's, and says why it is no link.
    expect(fireEvent.drop(urlBox(), words())).toBe(false)
    expect(urlBox().value).toBe('Artist Name')
    expect(urlBox().getAttribute('aria-invalid')).toBe('true')
    expect(resolveCalls()).toEqual([])
  })

  it('loads a link dropped on another text field', async () => {
    server.on('POST /api/resolve', () => json(trackResult(scTrack)))
    renderWithQueryClient(
      <>
        <input aria-label="Filter" />
        <ResolvePage />
      </>,
    )
    const filter = screen.getByRole('textbox', { name: 'Filter' })

    const dropped = fireEvent.drop(
      filter,
      dragData(['text/plain'], { 'text/plain': `Robo Kitty – ${urls.scTrack}` }),
    )

    expect(dropped).toBe(false)
    expect(await screen.findByRole('article', { name: 'Track card: Robo Kitty' })).toBeTruthy()
    expect(urlBox().value).toBe(urls.scTrack)
    expect((filter as HTMLInputElement).value).toBe('')
  })

  it('leaves drags that start on the page to the browser', () => {
    renderWithQueryClient(<ResolvePage />)

    fireEvent.dragStart(urlBox())
    fireEvent.dragEnter(document.body, dragData(LINK_DRAG))
    expect(overlay()).toBeNull()
    fireEvent.dragEnd(urlBox())

    fireEvent.dragEnter(document.body, dragData(LINK_DRAG))
    expect(overlay()).not.toBeNull()
    expect(resolveCalls()).toEqual([])
  })
})

describe('stopping a resolve', () => {
  it('cancels with Cancel and goes back to the start, keeping the link in the box', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), `${urls.playlist}{Enter}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(resolveCalls()[0]?.signal?.aborted).toBe(true)
    expect(screen.getByRole('heading', { name: 'Paste a YouTube or SoundCloud link' })).toBeTruthy()
    expect(status().textContent).toBe('Canceled.')
    expect(urlBox().value).toBe(urls.playlist)
    // The Cancel button is gone: the focus goes back to the box, not to the top of the page.
    expect(document.activeElement).toBe(urlBox())
  })

  it('cancels with Esc in the link box', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), `${urls.track}{Enter}`)
    await screen.findByRole('button', { name: 'Cancel' })
    await user.keyboard('{Escape}')

    expect(resolveCalls()[0]?.signal?.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('aborts the running resolve when the page goes away', async () => {
    server.on('POST /api/resolve', noAnswer)
    const user = userEvent.setup()
    const { unmount } = renderWithQueryClient(<ResolvePage />)

    await user.type(urlBox(), `${urls.track}{Enter}`)
    await screen.findByRole('button', { name: 'Cancel' })
    unmount()

    expect(resolveCalls()[0]?.signal?.aborted).toBe(true)
  })
})

describe('under StrictMode', () => {
  it('resolves a paste once and mounts its card once', async () => {
    server.on('POST /api/resolve', () => json(trackResult()))
    const user = userEvent.setup()
    renderWithQueryClient(
      <StrictMode>
        <ResolvePage />
      </StrictMode>,
    )
    act(() => urlBox().blur())

    await user.paste(urls.track)

    expect(await screen.findByRole('article', { name: 'Track card: The Chill Zone' })).toBeTruthy()
    expect(resolveCalls()).toHaveLength(1)
    // The doubles don't count StrictMode's simulated remount, so a second entry is a real one
    // (which would queue the auto-download again).
    expect(viewMounts).toEqual([{ view: 'track', id: 'XNEnEBrHws8', autoStart: true }])
  })
})
