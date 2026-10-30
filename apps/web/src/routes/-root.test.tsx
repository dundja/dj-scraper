// The shell's landmarks and the not-found page. The `-` prefix keeps the router plugin from taking
// this file for a route. Routes are built in memory: the shell around a placeholder home page.
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPreviewPlayer, togglePreview } from '@/features/remixes/preview-player.ts'
import { createRemixJobs } from '@/features/remixes/remix-jobs.ts'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json } from '@/test/fake-api.ts'
import { healthy } from '@/test/health.ts'
import { artyYoutube } from '@/test/remixes.ts'
import { createTestQueryClient } from '@/test/render.tsx'
import { Route as rootRoute } from './__root.tsx'

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <h1>Home page</h1>,
})
const routeTree = rootRoute.addChildren([homeRoute])

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  // The router resets the scroll position on navigation; jsdom has no scrolling.
  vi.stubGlobal('scrollTo', () => {})
  server = fakeApi()
  server.on('GET /api/health', () => json(healthy))
  // The header's folder picker reads the settings.
  server.on('GET /api/settings', () => json(settings))
})

afterEach(() => {
  act(() => resetPreviewPlayer())
  expect(server.unhandled).toEqual([])
})

function renderShell(path: string) {
  const queryClient = createTestQueryClient()
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('the shell', () => {
  it('has a header with the app name and engine status, the page, and the downloads beside it', async () => {
    renderShell('/')

    const main = await screen.findByRole('main')
    expect(within(main).getByRole('heading', { name: 'Home page' })).toBeTruthy()
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'DJ Scraper' }).getAttribute('href')).toBe('/')
    expect(
      await within(header).findByRole('button', { name: 'Engine status: Engine ready' }),
    ).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Downloads' })).toBeTruthy()
  })

  it('has the now-playing bar under the page and the downloads only while a remix plays', async () => {
    server.on('POST /api/previews', () =>
      json({
        id: 'a'.repeat(32),
        src: `/api/previews/${'a'.repeat(32)}`,
        mime: 'audio/mp4',
        sizeBytes: 1,
      }),
    )
    renderShell('/')
    const main = await screen.findByRole('main')
    expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull()

    await act(async () => {
      togglePreview(artyYoutube, { credit: 'Remix by Arty', jobs: createRemixJobs() })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const bar = screen.getByRole('region', { name: 'Now playing' })
    const downloads = screen.getByRole('complementary', { name: 'Downloads' })
    expect(main.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(downloads.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(main.contains(bar) || downloads.contains(bar)).toBe(false)
  })

  it('shows Page not found for an unknown address, with a way back', async () => {
    const user = userEvent.setup()
    const router = renderShell('/no-such-page')

    const main = await screen.findByRole('main')
    expect(await within(main).findByRole('heading', { name: 'Page not found' })).toBeTruthy()
    // The rest of the shell stays.
    expect(screen.getByRole('complementary', { name: 'Downloads' })).toBeTruthy()

    await user.click(within(main).getByRole('link', { name: 'Back to start' }))

    expect(await screen.findByRole('heading', { name: 'Home page' })).toBeTruthy()
    expect(router.state.location.pathname).toBe('/')
  })
})
