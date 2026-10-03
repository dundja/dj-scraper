import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, failedLoad, test } from './fixtures.ts'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('a recent folder deleted since is refused when it is chosen: the folder stays, and a popover says why', async ({
  page,
  server,
  settings,
  downloadFolder,
  expectConsoleError,
}) => {
  // Two recent folders: the test's own folder, then a second one, now the current one. The first
  // is then deleted on disk, as a user might between two sessions.
  const gone = downloadFolder
  const current = `${gone}-current`
  await mkdir(current)
  await settings.set({ folder: current })
  await rm(gone, { recursive: true })
  // The server's answer to the change, 422 folder_unavailable.
  expectConsoleError(failedLoad(422, '/api/settings'))

  await page.goto('/')
  const folderButton = page.getByRole('button', {
    name: new RegExp(`^Download folder: .*/${escapeRegExp(path.basename(current))}$`),
  })
  await folderButton.click()
  await page
    .getByRole('menuitemradio', { name: new RegExp(`/${escapeRegExp(path.basename(gone))}$`) })
    .click()

  const popover = page.getByRole('dialog', { name: 'Folder not changed' })
  await expect(popover).toContainText("That folder doesn't exist.")
  // The choice is undone in the header and was never saved.
  await expect(folderButton).toBeVisible()
  expect((await server.settings()).folder).toBe(current)
  // Escape closes the reason and gives the focus back to the folder button.
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  await expect(folderButton).toBeFocused()
})
