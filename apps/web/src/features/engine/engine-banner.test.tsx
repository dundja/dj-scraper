import { type FfmpegHealth, type Health, healthProblems } from '@dj-scraper/shared'
import type { QueryClient } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { fakeApi, json, networkError, noAnswer } from '@/test/fake-api.ts'
import { healthWith, healthy, missingFfprobe, staleYtdlp } from '@/test/health.ts'
import { renderWithQueryClient } from '@/test/render.tsx'
import { EngineBanner } from './engine-banner.tsx'
import { useHealth } from './use-health.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
  sessionStorage.clear()
})

afterEach(() => {
  sessionStorage.clear()
  expect(server.unhandled).toEqual([])
})

const PROBLEMS_TITLE = "Downloads won't work until the engine is fixed"

const ffmpegWithoutMp3 = {
  status: 'ok',
  path: '/opt/homebrew/bin/ffmpeg',
  source: 'path',
  version: '8.0',
  major: 8,
  meetsMinimum: true,
  mp3: false,
} satisfies FfmpegHealth

/** A fresh Mac: neither yt-dlp nor ffmpeg is installed. */
const nothingInstalled = healthWith({
  ok: false,
  ytdlp: {
    status: 'missing',
    message: 'yt-dlp is not on PATH. Run `brew install yt-dlp` or set YTDLP_PATH.',
  },
  ffmpeg: {
    status: 'missing',
    message: 'ffmpeg is not on PATH. Run `brew install ffmpeg` or set FFMPEG_PATH.',
  },
  ffprobe: missingFfprobe.ffprobe,
})

/** The health check's time, beside the banner: once it shows a check, the banner has rendered it. */
function CheckedAt() {
  const { data } = useHealth()
  return <span data-testid="checked-at">{data?.checkedAt}</span>
}

/** Answers GET /api/health with `health` from now on, refetches it, and waits until it rendered. */
async function nextHealth(queryClient: QueryClient, health: Health) {
  server.on('GET /api/health', () => json(health))
  await act(() => queryClient.refetchQueries({ queryKey: ['health'] }))
  await waitFor(() => expect(screen.getByTestId('checked-at').textContent).toBe(health.checkedAt))
}

function codeTexts(element: HTMLElement): string[] {
  return [...element.querySelectorAll('code')].map((code) => code.textContent)
}

/** The problem list as a screen reader reads it ("Problem: …", "Warning: …"). */
function problemTexts(banner: HTMLElement): string[] {
  const list = within(banner).getByRole('list', { name: 'Problems' })
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent)
}

describe('EngineBanner', () => {
  it('renders nothing while the first check runs', () => {
    server.on('GET /api/health', noAnswer)
    const { container } = renderWithQueryClient(<EngineBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the engine is fine', async () => {
    server.on('GET /api/health', () => json(healthy))
    const { container, queryClient } = renderWithQueryClient(<EngineBanner />)
    await waitFor(() => expect(queryClient.getQueryData(['health'])).toEqual(healthy))
    expect(container.innerHTML).toBe('')
  })

  describe('server offline', () => {
    it('says so, with the command that starts the server', async () => {
      server.on('GET /api/health', networkError)
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: 'Server offline' })
      expect(banner.textContent).toContain(
        "The DJ Scraper server isn't running, so links can't be resolved or downloaded.",
      )
      expect(codeTexts(banner)).toEqual(['pnpm dev'])
      expect(banner.textContent).toContain('This reconnects by itself.')
    })

    it('names pnpm start in the built app', async () => {
      vi.stubEnv('DEV', false)
      server.on('GET /api/health', networkError)
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: 'Server offline' })
      expect(codeTexts(banner)).toEqual(['pnpm start'])
    })

    it('goes away once Try now finds the server back', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', networkError)
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: 'Server offline' })

      const answer = Promise.withResolvers<Response>()
      server.on('GET /api/health', () => answer.promise)
      await user.click(within(banner).getByRole('button', { name: 'Try now' }))

      const pending = within(banner).getByRole('button', { name: 'Trying…' })
      expect(pending.getAttribute('aria-disabled')).toBe('true')
      answer.resolve(json(healthy))

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      expect(server.callsTo('GET /api/health')).toHaveLength(2)
    })

    it('stays, ready to try again, while the server is still down', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', networkError)
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: 'Server offline' })

      await user.click(within(banner).getByRole('button', { name: 'Try now' }))

      await within(banner).findByRole('button', { name: 'Try now' })
      expect(server.callsTo('GET /api/health')).toHaveLength(2)
      expect(screen.getByRole('alert', { name: 'Server offline' })).toBe(banner)
    })
  })

  describe('unexpected answers', () => {
    it("shows the server's refusal with its hint", async () => {
      server.on('GET /api/health', () =>
        json({ error: { code: 'forbidden', message: 'Host not allowed' } }, 403),
      )
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', {
        name: 'The server refused the engine check',
      })
      expect(banner.textContent).toContain('Host not allowed')
      expect(banner.textContent).toContain('Open DJ Scraper at the address pnpm dev prints.')
    })

    it('asks for a restart when the reply breaks the contract', async () => {
      server.on('GET /api/health', () => json({ ok: true }))
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: 'Unexpected answer from the server' })
      expect(banner.textContent).toContain('If you just updated, restart pnpm dev.')
      expect(codeTexts(banner)).toEqual(['pnpm dev'])
    })
  })

  describe('engine problems', () => {
    it('lists them with their fix commands as code', async () => {
      server.on('GET /api/health', () => json(missingFfprobe))
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })
      expect(problemTexts(banner)).toEqual([
        'Problem: ffprobe is not on PATH. Run brew install ffmpeg or set FFMPEG_PATH.',
      ])
      expect(codeTexts(banner)).toEqual(['brew install ffmpeg'])
      expect(banner.querySelector('time')?.dateTime).toBe(missingFfprobe.checkedAt)
      // Problems can't be dismissed: downloads fail until they are fixed.
      expect(within(banner).queryByRole('button', { name: 'Dismiss for this session' })).toBeNull()
    })

    it('offers one command that installs everything on a fresh Mac', async () => {
      server.on('GET /api/health', () => json(nothingInstalled))
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })
      expect(problemTexts(banner)).toHaveLength(3)
      expect(banner.textContent).toContain('Install them all at once: brew install yt-dlp ffmpeg.')
      expect(codeTexts(banner)).toContain('brew install yt-dlp ffmpeg')
    })

    it('lists warnings along with the problems', async () => {
      const both = healthWith({ ...missingFfprobe, ytdlp: staleYtdlp.ytdlp })
      server.on('GET /api/health', () => json(both))
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })
      expect(problemTexts(banner).map((text) => text.split(':')[0])).toEqual(['Warning', 'Problem'])
    })

    it('goes away when Check again finds the engine fixed', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(missingFfprobe))
      const reply = Promise.withResolvers<Response>()
      server.on('POST /api/health/recheck', () => reply.promise)
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })

      await user.click(within(banner).getByRole('button', { name: 'Check again' }))

      const pending = within(banner).getByRole('button', { name: 'Checking…' })
      expect(pending.getAttribute('aria-disabled')).toBe('true')
      expect(document.activeElement).toBe(pending)
      expect(server.callsTo('POST /api/health/recheck')[0]?.headers.get('Content-Type')).toBe(
        'application/json',
      )

      reply.resolve(json(healthWith({ checkedAt: '2026-10-02T08:05:00.000Z' })))

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      expect(server.callsTo('GET /api/health')).toHaveLength(1)
    })

    it('shows when it checked again, when the problem is still there', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(missingFfprobe))
      const later = healthWith({ ...missingFfprobe, checkedAt: '2026-10-02T08:05:00.000Z' })
      server.on('POST /api/health/recheck', () => json(later))
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })

      await user.click(within(banner).getByRole('button', { name: 'Check again' }))

      await waitFor(() => expect(banner.querySelector('time')?.dateTime).toBe(later.checkedAt))
      expect(within(banner).getByRole('button', { name: 'Check again' })).toBeDefined()
    })

    it('says why when the server refuses the re-check', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(missingFfprobe))
      server.on('POST /api/health/recheck', () =>
        json({ error: { code: 'forbidden', message: 'Origin not allowed' } }, 403),
      )
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })

      await user.click(within(banner).getByRole('button', { name: 'Check again' }))

      const failure = await within(banner).findByRole('alert')
      expect(failure.textContent).toBe('Check failed: Origin not allowed')
    })

    it('turns into Server offline when the re-check finds the server gone', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(missingFfprobe))
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('alert', { name: PROBLEMS_TITLE })

      server.on('POST /api/health/recheck', networkError)
      server.on('GET /api/health', networkError)
      await user.click(within(banner).getByRole('button', { name: 'Check again' }))

      await screen.findByRole('alert', { name: 'Server offline' })
    })
  })

  describe('warnings', () => {
    it('show calmly, as a status rather than an alert', async () => {
      server.on('GET /api/health', () => json(staleYtdlp))
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('status', { name: 'Engine warning' })
      expect(problemTexts(banner)).toEqual(
        healthProblems(staleYtdlp).map(
          (problem) => `Warning: ${problem.message.replaceAll('`', '')}`,
        ),
      )
      expect(codeTexts(banner)).toEqual(['brew upgrade yt-dlp'])
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('count in the title when there are several', async () => {
      server.on('GET /api/health', () =>
        json(healthWith({ ytdlp: staleYtdlp.ytdlp, ffmpeg: ffmpegWithoutMp3 })),
      )
      renderWithQueryClient(<EngineBanner />)

      const banner = await screen.findByRole('status', { name: 'Engine warnings' })
      expect(problemTexts(banner)).toHaveLength(2)
    })

    it('can be dismissed for the session', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(staleYtdlp))
      const first = renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('status', { name: 'Engine warning' })

      await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }))

      expect(screen.queryByRole('status', { name: 'Engine warning' })).toBeNull()
      first.unmount()

      // A reload in the same tab keeps them dismissed.
      const second = renderWithQueryClient(<EngineBanner />)
      await waitFor(() => expect(second.queryClient.getQueryData(['health'])).toEqual(staleYtdlp))
      expect(second.container.innerHTML).toBe('')
    })

    it('hand the focus on to what follows when dismissed, not back to the page start', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(staleYtdlp))
      renderWithQueryClient(
        <>
          <EngineBanner />
          <input aria-label="YouTube or SoundCloud link" />
        </>,
      )
      const banner = await screen.findByRole('status', { name: 'Engine warning' })

      await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }))

      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'YouTube or SoundCloud link' }),
      )
    })

    it('come back when a different warning shows up', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(staleYtdlp))
      const { queryClient } = renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('status', { name: 'Engine warning' })
      await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }))

      server.on('GET /api/health', () => json(healthWith({ ffmpeg: ffmpegWithoutMp3 })))
      await queryClient.refetchQueries({ queryKey: ['health'] })

      const next = await screen.findByRole('status', { name: 'Engine warning' })
      expect(next.textContent).toContain('ffmpeg has no MP3 encoder')
    })

    it('stay dismissed when one of them is fixed, e.g. ffmpeg reinstalled with MP3', async () => {
      const user = userEvent.setup()
      const both = healthWith({ ytdlp: staleYtdlp.ytdlp, ffmpeg: ffmpegWithoutMp3 })
      server.on('GET /api/health', () => json(both))
      const { queryClient } = renderWithQueryClient(
        <>
          <EngineBanner />
          <CheckedAt />
        </>,
      )
      const banner = await screen.findByRole('status', { name: 'Engine warnings' })
      await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }))

      await nextHealth(
        queryClient,
        healthWith({ ytdlp: staleYtdlp.ytdlp, checkedAt: '2026-10-02T08:05:00.000Z' }),
      )

      expect(screen.queryByRole('status')).toBeNull()
    })

    it('keep an earlier dismissal when a newer warning is dismissed', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(staleYtdlp))
      const { queryClient } = renderWithQueryClient(
        <>
          <EngineBanner />
          <CheckedAt />
        </>,
      )
      const first = await screen.findByRole('status', { name: 'Engine warning' })
      await user.click(within(first).getByRole('button', { name: 'Dismiss for this session' }))

      await nextHealth(
        queryClient,
        healthWith({ ffmpeg: ffmpegWithoutMp3, checkedAt: '2026-10-02T08:05:00.000Z' }),
      )
      const next = screen.getByRole('status', { name: 'Engine warning' })
      await user.click(within(next).getByRole('button', { name: 'Dismiss for this session' }))

      // Both at once now: each was dismissed already.
      await nextHealth(
        queryClient,
        healthWith({
          ytdlp: staleYtdlp.ytdlp,
          ffmpeg: ffmpegWithoutMp3,
          checkedAt: '2026-10-02T08:10:00.000Z',
        }),
      )
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('stay dismissed until a reload when the browser blocks storage', async () => {
      const user = userEvent.setup()
      const blocked = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
      // Restores only these two: vi.restoreAllMocks() would also unhook setup.ts's console guard.
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
      onTestFinished(() => {
        getItem.mockRestore()
        setItem.mockRestore()
      })
      server.on('GET /api/health', () => json(staleYtdlp))
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('status', { name: 'Engine warning' })

      await user.click(within(banner).getByRole('button', { name: 'Dismiss for this session' }))

      expect(screen.queryByRole('status', { name: 'Engine warning' })).toBeNull()
    })

    it('check again too, e.g. after brew upgrade yt-dlp', async () => {
      const user = userEvent.setup()
      server.on('GET /api/health', () => json(staleYtdlp))
      server.on('POST /api/health/recheck', () => json(healthy))
      renderWithQueryClient(<EngineBanner />)
      const banner = await screen.findByRole('status', { name: 'Engine warning' })

      await user.click(within(banner).getByRole('button', { name: 'Check again' }))

      await waitFor(() =>
        expect(screen.queryByRole('status', { name: 'Engine warning' })).toBeNull(),
      )
    })
  })
})
