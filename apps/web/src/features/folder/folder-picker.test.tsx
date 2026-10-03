import { type Settings, SettingsSchema } from '@dj-scraper/shared'
import { onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { settingsQueryKey } from '@/features/settings/use-settings.ts'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody, networkError, noAnswer } from '@/test/fake-api.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { FolderPicker } from './folder-picker.tsx'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

type User = ReturnType<typeof userEvent.setup>

// settings: folder '/Users/dj/Music/DJ Scraper', recentFolders [that, '/Volumes/USB'].
const saved = (changes: Partial<Settings>): Settings =>
  SettingsSchema.parse({ ...settings, ...changes })

const folderError = (message: string) =>
  json({ error: { code: 'folder_unavailable', message } }, 422)

/** The header button, named by the full (shortened) path of the current folder. */
function folderButton(path = '~/Music/DJ Scraper'): HTMLElement {
  return screen.getByRole('button', { name: `Download folder: ${path}` })
}

async function renderLoaded(current: Partial<Settings> = {}) {
  server.on('GET /api/settings', () => json(saved(current)))
  const rendered = renderWithQueryClient(
    <TooltipProvider delay={0}>
      <FolderPicker />
    </TooltipProvider>,
  )
  await screen.findByRole('button', { name: /^Download folder: / })
  return rendered
}

async function openMenu(user: User): Promise<HTMLElement> {
  await user.click(folderButton())
  return screen.findByRole('menu')
}

/** Opens the menu and clicks "Choose folder…". */
async function chooseFolder(user: User) {
  const menu = await openMenu(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Choose folder…' }))
}

/** A pick that answers when the test says so. */
function heldPick() {
  const answer = Promise.withResolvers<Response>()
  server.on('POST /api/folders/pick', () => answer.promise)
  return answer
}

function statusText(): string | null {
  return screen.getByRole('status').textContent
}

describe('FolderPicker', () => {
  it("shows the folder's name, with its full path in the accessible name and a tooltip", async () => {
    const user = userEvent.setup()
    await renderLoaded()

    const button = folderButton()
    expect(button.textContent).toBe('DJ Scraper')

    await user.hover(button)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
        '~/Music/DJ Scraper',
      ),
    )
  })

  it('lists the recent folders with the current one checked', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    const menu = await openMenu(user)

    const folders = within(menu).getAllByRole('menuitemradio')
    expect(folders.map((item) => item.getAttribute('aria-label'))).toEqual([
      '~/Music/DJ Scraper',
      '/Volumes/USB',
    ])
    expect(folders.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(folders.map((item) => item.textContent)).toEqual([
      'DJ Scraper~/Music/DJ Scraper',
      'USB/Volumes/USB',
    ])
    expect(within(menu).getByRole('group', { name: 'Recent folders' })).toBeDefined()
  })

  it('puts the current folder on top when it is not a recent one yet', async () => {
    const user = userEvent.setup()
    await renderLoaded({ folder: '/Users/dj/Music/DJ Scraper', recentFolders: [] })

    const menu = await openMenu(user)

    const folders = within(menu).getAllByRole('menuitemradio')
    expect(folders.map((item) => item.getAttribute('aria-label'))).toEqual(['~/Music/DJ Scraper'])
    expect(folders[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('switches to a recent folder at once and saves it', async () => {
    const user = userEvent.setup()
    const reply = Promise.withResolvers<Response>()
    server.on('PUT /api/settings', () => reply.promise)
    const { queryClient } = await renderLoaded()

    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitemradio', { name: '/Volumes/USB' }))

    expect(folderButton('/Volumes/USB').textContent).toBe('USB')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ folder: '/Volumes/USB' })

    reply.resolve(json(saved({ folder: '/Volumes/USB' })))
    await waitFor(() =>
      expect(queryClient.getQueryData(settingsQueryKey)?.folder).toBe('/Volumes/USB'),
    )
  })

  it('sends nothing when the current folder is chosen again', async () => {
    const user = userEvent.setup()
    await renderLoaded()

    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitemradio', { name: '~/Music/DJ Scraper' }))

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(server.callsTo('PUT /api/settings')).toHaveLength(0)
  })

  it('goes back to the saved folder and says why when the server refuses a recent one', async () => {
    const user = userEvent.setup()
    server.on('PUT /api/settings', () =>
      json({ error: { code: 'invalid_request', message: 'That folder path is too long.' } }, 400),
    )
    await renderLoaded()

    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitemradio', { name: '/Volumes/USB' }))

    const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
    expect(popover.textContent).toContain('That folder path is too long.')
    expect(folderButton().textContent).toBe('DJ Scraper')
  })

  it('works with the keyboard alone', async () => {
    const user = userEvent.setup()
    server.on('PUT /api/settings', () => json(saved({ folder: '/Volumes/USB' })))
    await renderLoaded()

    await user.tab()
    expect(document.activeElement).toBe(folderButton())
    await user.keyboard('{Enter}')
    await screen.findByRole('menu')
    // The menu opens on the first folder, the current one.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('~/Music/DJ Scraper'),
    )
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('/Volumes/USB')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ folder: '/Volumes/USB' })
    await waitFor(() => expect(document.activeElement).toBe(folderButton('/Volumes/USB')))
  })

  describe('Choose folder…', () => {
    it('opens the dialog in the current folder and says so until it is answered', async () => {
      const user = userEvent.setup()
      const answer = heldPick()
      server.on('PUT /api/settings', () => json(saved({ folder: '/Volumes/Sets' })))
      await renderLoaded()
      expect(statusText()).toBe('')

      await chooseFolder(user)

      const [call] = server.callsTo('POST /api/folders/pick')
      expect(jsonBody(call)).toEqual({ startIn: '/Users/dj/Music/DJ Scraper' })
      expect(call?.headers.get('Content-Type')).toBe('application/json')
      await waitFor(() => expect(statusText()).toBe('Choose a folder in the dialog…'))

      answer.resolve(json({ path: '/Volumes/Sets' }))

      await waitFor(() => expect(folderButton('/Volumes/Sets').textContent).toBe('Sets'))
      expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ folder: '/Volumes/Sets' })
      expect(statusText()).toBe('')
    })

    it("doesn't offer a second dialog while one is open", async () => {
      const user = userEvent.setup()
      heldPick()
      await renderLoaded()
      await chooseFolder(user)
      await waitFor(() => expect(statusText()).toBe('Choose a folder in the dialog…'))

      const menu = await openMenu(user)

      const item = within(menu).getByRole('menuitem', { name: 'Choose folder…' })
      expect(item.getAttribute('aria-disabled')).toBe('true')
      await user.click(item)
      expect(server.callsTo('POST /api/folders/pick')).toHaveLength(1)
    })

    it('changes nothing when the dialog is canceled', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => json({ canceled: true }))
      await renderLoaded()

      await chooseFolder(user)

      await waitFor(() => expect(server.callsTo('POST /api/folders/pick')).toHaveLength(1))
      await waitFor(() => expect(statusText()).toBe(''))
      expect(folderButton().textContent).toBe('DJ Scraper')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(server.callsTo('PUT /api/settings')).toHaveLength(0)
    })

    it('changes nothing when the same folder is picked', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => json({ path: '/Users/dj/Music/DJ Scraper' }))
      await renderLoaded()

      await chooseFolder(user)

      await waitFor(() => expect(statusText()).toBe(''))
      expect(server.callsTo('PUT /api/settings')).toHaveLength(0)
    })

    it('closes the dialog with Cancel, quietly', async () => {
      const user = userEvent.setup()
      heldPick()
      await renderLoaded()
      await chooseFolder(user)

      await user.click(await screen.findByRole('button', { name: 'Cancel' }))

      expect(server.callsTo('POST /api/folders/pick')[0]?.signal?.aborted).toBe(true)
      await waitFor(() => expect(statusText()).toBe(''))
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('hands the focus back to the folder button when Cancel goes away', async () => {
      const user = userEvent.setup()
      heldPick()
      await renderLoaded()
      await chooseFolder(user)
      await waitFor(() => expect(document.activeElement).toBe(folderButton()))

      await user.tab()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
      await user.keyboard('{Enter}')

      expect(server.callsTo('POST /api/folders/pick')[0]?.signal?.aborted).toBe(true)
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
      expect(document.activeElement).toBe(folderButton())
    })

    it('hands the focus back when the dialog is answered while Cancel has it', async () => {
      const user = userEvent.setup()
      const answer = heldPick()
      await renderLoaded()
      await chooseFolder(user)
      const cancel = await screen.findByRole('button', { name: 'Cancel' })
      act(() => cancel.focus())

      answer.resolve(json({ canceled: true }))

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())
      expect(document.activeElement).toBe(folderButton())
    })

    it('opens the dialog and cancels it while the browser says it is offline', async ({
      onTestFinished,
    }) => {
      const user = userEvent.setup()
      heldPick()
      await renderLoaded()
      onTestFinished(() => onlineManager.setOnline(true))
      act(() => onlineManager.setOnline(false))

      await chooseFolder(user)

      // The server is on this machine: Wi-Fi off doesn't hold the request back.
      await waitFor(() => expect(server.callsTo('POST /api/folders/pick')).toHaveLength(1))
      await user.click(await screen.findByRole('button', { name: 'Cancel' }))
      expect(server.callsTo('POST /api/folders/pick')[0]?.signal?.aborted).toBe(true)
      await waitFor(() => expect(statusText()).toBe(''))
    })

    it('closes the dialog when a recent folder is chosen meanwhile', async () => {
      const user = userEvent.setup()
      heldPick()
      server.on('PUT /api/settings', () => json(saved({ folder: '/Volumes/USB' })))
      await renderLoaded()
      await chooseFolder(user)

      const menu = await openMenu(user)
      await user.click(within(menu).getByRole('menuitemradio', { name: '/Volumes/USB' }))

      expect(server.callsTo('POST /api/folders/pick')[0]?.signal?.aborted).toBe(true)
      await waitFor(() => expect(statusText()).toBe(''))
      expect(folderButton('/Volumes/USB')).toBeDefined()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('closes the dialog when the picker goes away', async () => {
      const user = userEvent.setup()
      heldPick()
      const { unmount } = await renderLoaded()
      await chooseFolder(user)
      const [call] = server.callsTo('POST /api/folders/pick')
      expect(call?.signal?.aborted).toBe(false)

      unmount()

      expect(call?.signal?.aborted).toBe(true)
    })

    it('says a dialog is already open (409), next to the button, and returns focus on OK', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () =>
        json(
          { error: { code: 'invalid_request', message: 'A folder picker is already open' } },
          409,
        ),
      )
      await renderLoaded()

      await chooseFolder(user)

      const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
      expect(popover.textContent).toContain('A folder dialog is already open.')
      expect(popover.textContent).toContain('It may be behind this window')
      const ok = within(popover).getByRole('button', { name: 'OK' })
      await waitFor(() => expect(document.activeElement).toBe(ok))

      await user.click(ok)

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Folder not changed' })).toBeNull()
      expect(document.activeElement).toBe(folderButton())
    })

    it("shows the server's reason when the picked folder can't be used (422)", async () => {
      const user = userEvent.setup()
      const privacy =
        'macOS blocked access to this folder. Allow your terminal app under System Settings › Privacy & Security › Files and Folders (or Full Disk Access), then try again.'
      server.on('POST /api/folders/pick', () => folderError(privacy))
      await renderLoaded()

      await chooseFolder(user)

      const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
      expect(popover.textContent).toBe(`Folder not changed${privacy}OK`)
      expect(server.callsTo('PUT /api/settings')).toHaveLength(0)
      expect(folderButton().textContent).toBe('DJ Scraper')
    })

    it('dismisses the reason with Escape', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => folderError("That path isn't a folder."))
      await renderLoaded()
      await chooseFolder(user)
      const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
      await waitFor(() =>
        expect(document.activeElement).toBe(within(popover).getByRole('button', { name: 'OK' })),
      )

      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Folder not changed' })).toBeNull()
      expect(document.activeElement).toBe(folderButton())
    })

    it('lets the menu open over a shown reason, which then goes away', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => folderError("That path isn't a folder."))
      await renderLoaded()
      await chooseFolder(user)
      await screen.findByRole('dialog', { name: 'Folder not changed' })

      const menu = await openMenu(user)

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Folder not changed' })).toBeNull()
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    })

    it('shows the next reason again after one was dismissed', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => folderError("That path isn't a folder."))
      await renderLoaded()
      await chooseFolder(user)
      const first = await screen.findByRole('dialog', { name: 'Folder not changed' })
      await user.click(within(first).getByRole('button', { name: 'OK' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      await chooseFolder(user)

      const second = await screen.findByRole('dialog', { name: 'Folder not changed' })
      expect(second.textContent).toContain("That path isn't a folder.")
      expect(server.callsTo('POST /api/folders/pick')).toHaveLength(2)
    })

    it('says the server is offline, with the command that starts it', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', networkError)
      await renderLoaded()

      await chooseFolder(user)

      const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
      expect(popover.textContent).toContain("Can't reach the DJ Scraper server.")
      expect([...popover.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
        'pnpm dev',
      ])
    })

    it('says why when saving the picked folder fails, and keeps the old one', async () => {
      const user = userEvent.setup()
      server.on('POST /api/folders/pick', () => json({ path: '/Volumes/Sets' }))
      server.on('PUT /api/settings', networkError)
      server.on('GET /api/settings', () => json(settings))
      await renderLoaded()

      await chooseFolder(user)

      const popover = await screen.findByRole('dialog', { name: 'Folder not changed' })
      expect(popover.textContent).toContain("Can't reach the DJ Scraper server.")
      await waitFor(() => expect(folderButton().textContent).toBe('DJ Scraper'))
    })
  })

  describe('before the settings arrive', () => {
    it('shows a placeholder while they load', () => {
      server.on('GET /api/settings', noAnswer)
      renderWithQueryClient(<FolderPicker />)

      expect(screen.getByText('Loading the download folder…')).toBeDefined()
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('offers to load them again when that failed', async () => {
      const user = userEvent.setup()
      server.on('GET /api/settings', networkError)
      renderWithQueryClient(<FolderPicker />)

      const retry = await screen.findByRole('button', { name: 'Folder unknown: load it again' })
      server.on('GET /api/settings', () => json(settings))
      await user.click(retry)

      await screen.findByRole('button', { name: 'Download folder: ~/Music/DJ Scraper' })
      expect(server.callsTo('GET /api/settings')).toHaveLength(2)
    })
  })
})
