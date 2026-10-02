import { healthProblems } from '@dj-scraper/shared'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, networkError, noAnswer } from '@/test/fake-api.ts'
import { healthWith, healthy, missingFfprobe, staleYtdlp } from '@/test/health.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { EngineStatus } from './engine-status.tsx'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  vi.useRealTimers()
  expect(server.unhandled).toEqual([])
})

type User = ReturnType<typeof userEvent.setup>

/** The header chip: the one button whose accessible name starts with "Engine status:". */
function chip(): HTMLElement {
  return screen.getByRole('button', { name: /^Engine status: / })
}

/** What the chip tells assistive tech, e.g. "Engine status: Engine ready, 1 warning". */
function chipName(): string | null {
  return chip().getAttribute('aria-label')
}

/** Waits until the chip's accessible name is "Engine status: <status>". */
function findChip(status: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: `Engine status: ${status}` })
}

/** Opens the popover from the chip; it's a dialog named by its title, e.g. "Engine ready". */
async function openPopover(user: User, title: string): Promise<HTMLElement> {
  await user.click(chip())
  return screen.findByRole('dialog', { name: title })
}

/** The engine tool list as shown: per row, its non-empty texts (name with level, value, path). */
function toolTable(popover: HTMLElement): string[][] {
  const tools = within(popover).getByRole('list', { name: 'Engine tools' })
  return within(tools)
    .getAllByRole('listitem')
    .map((row) =>
      [...row.children].map((cell) => cell.textContent).filter((cellText) => cellText !== ''),
    )
}

/** The problem list items' text, as a screen reader reads them ("Warning: …", "Problem: …"). */
function problemTexts(popover: HTMLElement): string[] {
  const problems = within(popover).getByRole('list', { name: 'Problems' })
  return within(problems)
    .getAllByRole('listitem')
    .map((item) => item.textContent)
}

function codeTexts(element: HTMLElement): string[] {
  return [...element.querySelectorAll('code')].map((code) => code.textContent)
}

describe('EngineStatus', () => {
  it('says it is checking the engine until the first health check answers', async () => {
    server.on('GET /api/health', noAnswer)
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    expect(chipName()).toBe('Engine status: Checking engine')
    const popover = await openPopover(user, 'Checking engine')
    expect(popover.textContent).toContain('The first check can take a few seconds.')
  })

  it('shows Engine ready when every tool is found and recent enough', async () => {
    server.on('GET /api/health', () => json(healthy))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Engine ready')
    const popover = await openPopover(user, 'Engine ready')
    expect(popover.textContent).toContain(
      'yt-dlp, ffmpeg and ffprobe are installed and recent enough.',
    )
    expect(within(popover).queryByRole('list', { name: 'Problems' })).toBeNull()
  })

  it('lists each tool and JS runtime with its version and path, and when it was checked', async () => {
    server.on('GET /api/health', () => json(healthy))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)
    await findChip('Engine ready')

    const popover = await openPopover(user, 'Engine ready')

    expect(toolTable(popover)).toEqual([
      ['yt-dlp: OK', '2026.08.19', '/opt/homebrew/bin/yt-dlp'],
      ['ffmpeg: OK', '8.0', '/opt/homebrew/bin/ffmpeg'],
      ['ffprobe: OK', '8.0', '/opt/homebrew/bin/ffprobe'],
      ['deno JS runtime: OK', '2.9.7', '/opt/homebrew/bin/deno'],
      ['node JS runtime: OK', '24.12.0', '/opt/homebrew/Cellar/node/24.12.0/bin/node'],
    ])
    expect(popover.querySelector('time')?.dateTime).toBe(healthy.checkedAt)
  })

  it('counts the warning of a stale yt-dlp on the chip and explains it in the popover', async () => {
    server.on('GET /api/health', () => json(staleYtdlp))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    const button = await findChip('Engine ready, 1 warning')
    expect(button.textContent).toBe('Engine ready· 1 warning')

    const popover = await openPopover(user, 'Engine ready, 1 warning')
    expect(popover.textContent).toContain('The engine runs, but see the notes below.')
    // The command in backticks renders as <code>, which textContent reads without the backticks.
    expect(problemTexts(popover)).toEqual(
      healthProblems(staleYtdlp).map(
        (problem) => `Warning: ${problem.message.replaceAll('`', '')}`,
      ),
    )
    expect(codeTexts(popover)).toEqual(['brew upgrade yt-dlp'])
    expect(toolTable(popover)[0]).toEqual([
      'yt-dlp: warning',
      '2026.06.09',
      '/opt/homebrew/bin/yt-dlp',
    ])
  })

  it('asks for attention when ffprobe is missing and shows the fix with its command as code', async () => {
    server.on('GET /api/health', () => json(missingFfprobe))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Engine needs attention')
    const popover = await openPopover(user, 'Engine needs attention')

    expect(popover.textContent).toContain(
      "Downloads won't work until the problems below are fixed.",
    )
    expect(problemTexts(popover)).toEqual([
      'Problem: ffprobe is not on PATH. Run brew install ffmpeg or set FFMPEG_PATH.',
    ])
    const problems = within(popover).getByRole('list', { name: 'Problems' })
    expect(codeTexts(problems)).toEqual(['brew install ffmpeg'])
    expect(toolTable(popover)[2]).toEqual(['ffprobe: problem', 'Not found'])
  })

  it('says Server offline when the request never reaches the server', async () => {
    server.on('GET /api/health', networkError)
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Server offline')
    const popover = await openPopover(user, 'Server offline')
    expect(popover.textContent).toContain("The DJ Scraper server isn't running")
    expect(codeTexts(popover)).toEqual(['pnpm dev'])
  })

  it('tells people running the built app to start it with pnpm start', async () => {
    // The server serves the production build, where import.meta.env.DEV is false.
    vi.stubEnv('DEV', false)
    server.on('GET /api/health', networkError)
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Server offline')
    const popover = await openPopover(user, 'Server offline')
    expect(popover.textContent).toContain('Start it with pnpm start in the project folder.')
    expect(codeTexts(popover)).toEqual(['pnpm start'])
  })

  it('reconnects by itself once the server is back, then stops asking', async () => {
    vi.useFakeTimers()
    // TanStack Query hands cache updates to React in a setTimeout(0), and the fake clock runs a
    // zero delay scheduled from inside a timer 1 ms later. So each step ends 1 ms past the retry.
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
    server.on('GET /api/health', networkError)
    renderWithQueryClient(<EngineStatus />)

    await advance(1)
    expect(chipName()).toBe('Engine status: Server offline')
    await advance(3000)
    expect(chipName()).toBe('Engine status: Server offline')
    expect(server.callsTo('GET /api/health')).toHaveLength(2)

    server.on('GET /api/health', () => json(healthy))
    await advance(3000)
    expect(chipName()).toBe('Engine status: Engine ready')
    expect(server.callsTo('GET /api/health')).toHaveLength(3)

    await advance(60_000)
    expect(server.callsTo('GET /api/health')).toHaveLength(3)
  })

  it('checks again at once with Try now instead of waiting for the next retry', async () => {
    server.on('GET /api/health', networkError)
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)
    await findChip('Server offline')
    const popover = await openPopover(user, 'Server offline')

    server.on('GET /api/health', () => json(healthy))
    await user.click(within(popover).getByRole('button', { name: 'Try now' }))

    await findChip('Engine ready')
    expect(server.callsTo('GET /api/health')).toHaveLength(2)
  })

  it('says when Try now ran, so a retry against a down server is not a dead button', async () => {
    server.on('GET /api/health', networkError)
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)
    await findChip('Server offline')
    const popover = await openPopover(user, 'Server offline')
    const note = within(popover).getByRole('status')
    expect(note.textContent).toBe('This status reconnects by itself.')

    await user.click(within(popover).getByRole('button', { name: 'Try now' }))

    await waitFor(() => expect(note.textContent).toMatch(/^Tried again at .+, no luck\.$/))
    expect(server.callsTo('GET /api/health')).toHaveLength(2)
    expect(chipName()).toBe('Engine status: Server offline')
  })

  it('says Unexpected response when a success does not match the contract', async () => {
    server.on('GET /api/health', () => json({ ok: true }))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Unexpected response')
    const popover = await openPopover(user, 'Unexpected response')
    expect(popover.textContent).toContain("The server's reply doesn't match this app.")
    expect(codeTexts(popover)).toEqual(['pnpm dev'])
    expect(popover.textContent).toContain('HTTP 200: Unexpected response from GET /api/health.')
  })

  it('asks people running the built app to restart pnpm start after an update', async () => {
    vi.stubEnv('DEV', false)
    server.on('GET /api/health', () => json({ ok: true }))
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Unexpected response')
    const popover = await openPopover(user, 'Unexpected response')
    expect(popover.textContent).toContain('If you just updated, restart pnpm start.')
    expect(codeTexts(popover)).toEqual(['pnpm start'])
  })

  it('shows the status, code and message when the server refuses the check', async () => {
    server.on('GET /api/health', () =>
      json({ error: { code: 'forbidden', message: 'Host not allowed' } }, 403),
    )
    const user = userEvent.setup()
    renderWithQueryClient(<EngineStatus />)

    await findChip('Unexpected response')
    const popover = await openPopover(user, 'Unexpected response')
    expect(popover.textContent).toContain('The server refused the engine check.')
    expect(popover.textContent).toContain('HTTP 403 forbidden: Host not allowed')
  })

  describe('Check again', () => {
    it('posts a JSON re-check and shows the engine it reports', async () => {
      server.on('GET /api/health', () => json(missingFfprobe))
      const reply = Promise.withResolvers<Response>()
      server.on('POST /api/health/recheck', () => reply.promise)
      const user = userEvent.setup()
      renderWithQueryClient(<EngineStatus />)
      await findChip('Engine needs attention')
      const popover = await openPopover(user, 'Engine needs attention')

      await user.click(within(popover).getByRole('button', { name: 'Check again' }))

      const pending = within(popover).getByRole('button', { name: 'Checking…' })
      expect(pending.getAttribute('aria-disabled')).toBe('true')
      expect(document.activeElement).toBe(pending)
      const [call] = server.callsTo('POST /api/health/recheck')
      expect(call?.headers.get('Content-Type')).toBe('application/json')
      expect(call?.body).toBeUndefined()

      const installed = healthWith({ checkedAt: '2026-10-02T08:05:00.000Z' })
      reply.resolve(json(installed))

      await findChip('Engine ready')
      const ready = screen.getByRole('dialog', { name: 'Engine ready' })
      expect(within(ready).queryByRole('button', { name: 'Check again' })).not.toBeNull()
      expect(ready.querySelector('time')?.dateTime).toBe(installed.checkedAt)
      // The re-check's answer replaces the cached check; it doesn't trigger another GET.
      expect(server.callsTo('GET /api/health')).toHaveLength(1)
    })

    it('keeps the last status and says why when the server refuses the re-check', async () => {
      server.on('GET /api/health', () => json(healthy))
      server.on('POST /api/health/recheck', () =>
        json({ error: { code: 'forbidden', message: 'Origin not allowed' } }, 403),
      )
      const user = userEvent.setup()
      renderWithQueryClient(<EngineStatus />)
      await findChip('Engine ready')
      const popover = await openPopover(user, 'Engine ready')

      await user.click(within(popover).getByRole('button', { name: 'Check again' }))

      const alert = await within(popover).findByRole('alert')
      expect(alert.textContent).toBe('Check failed: Origin not allowed')
      expect(chipName()).toBe('Engine status: Engine ready')

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const reopened = await openPopover(user, 'Engine ready')
      expect(within(reopened).queryByRole('alert')).toBeNull()
    })

    it('shows Server offline when the re-check finds the server gone, and drops that failure once it is back', async () => {
      server.on('GET /api/health', () => json(healthy))
      const user = userEvent.setup()
      renderWithQueryClient(<EngineStatus />)
      await findChip('Engine ready')
      const popover = await openPopover(user, 'Engine ready')

      server.on('GET /api/health', networkError)
      server.on('POST /api/health/recheck', networkError)
      await user.click(within(popover).getByRole('button', { name: 'Check again' }))

      await findChip('Server offline')
      const offline = screen.getByRole('dialog', { name: 'Server offline' })

      server.on('GET /api/health', () =>
        json(healthWith({ checkedAt: '2026-10-02T08:05:00.000Z' })),
      )
      await user.click(within(offline).getByRole('button', { name: 'Try now' }))

      await findChip('Engine ready')
      const back = screen.getByRole('dialog', { name: 'Engine ready' })
      expect(within(back).queryByRole('alert')).toBeNull()
    })
  })

  describe('accessibility', () => {
    it('announces each status in a polite live region outside the chip', async () => {
      const reply = Promise.withResolvers<Response>()
      server.on('GET /api/health', () => reply.promise)
      renderWithQueryClient(<EngineStatus />)

      const status = screen.getByRole('status')
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(status.textContent).toBe('Engine status: Checking engine')
      expect(chip().contains(status)).toBe(false)

      reply.resolve(json(staleYtdlp))

      await findChip('Engine ready, 1 warning')
      expect(status.textContent).toBe('Engine status: Engine ready, 1 warning')
    })

    it.each([
      { key: 'Enter', keys: '{Enter}' },
      { key: 'Space', keys: ' ' },
    ])(
      'opens with $key, moves focus into the popover, and returns it to the chip on Escape',
      async ({ keys }) => {
        server.on('GET /api/health', () => json(healthy))
        const user = userEvent.setup()
        renderWithQueryClient(<EngineStatus />)
        const button = await findChip('Engine ready')

        await user.tab()
        expect(document.activeElement).toBe(button)
        await user.keyboard(keys)

        const popover = await screen.findByRole('dialog', { name: 'Engine ready' })
        const checkAgain = within(popover).getByRole('button', { name: 'Check again' })
        await waitFor(() => expect(document.activeElement).toBe(checkAgain))

        await user.keyboard('{Escape}')

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
        expect(document.activeElement).toBe(button)
      },
    )
  })
})
