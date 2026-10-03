import { type Settings, SettingsSchema, type SettingsUpdate } from '@dj-scraper/shared'
import { onlineManager, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody } from '@/test/fake-api.ts'
import { createTestQueryClient } from '@/test/render.tsx'
import { settingsQueryKey, useSettings, useUpdateSettings } from './use-settings.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

/** Both hooks under a fresh QueryClient, as render.tsx sets one up. */
function renderSettings() {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => ({ query: useSettings(), update: useUpdateSettings() }), {
    wrapper,
  })
  const cached = () => queryClient.getQueryData(settingsQueryKey)
  return { ...hook, queryClient, cached }
}

/** PUT answers the test releases one by one, in request order. */
function heldPuts() {
  const answers: PromiseWithResolvers<Response>[] = []
  server.on('PUT /api/settings', () => {
    const answer = Promise.withResolvers<Response>()
    answers.push(answer)
    return answer.promise
  })
  return {
    answer: (index: number, response: Response) => answers[index]?.resolve(response),
    count: () => answers.length,
  }
}

const saved = (changes: Partial<Settings>): Settings =>
  SettingsSchema.parse({ ...settings, ...changes })
const failure = () =>
  json(
    { error: { code: 'folder_unavailable', message: 'That folder is on a read-only drive.' } },
    422,
  )

describe('useSettings', () => {
  it('loads the settings from GET /api/settings', async () => {
    server.on('GET /api/settings', () => json(settings))
    const { result } = renderSettings()

    await waitFor(() => expect(result.current.query.data).toEqual(settings))
    expect(server.callsTo('GET /api/settings')).toHaveLength(1)
  })
})

describe('useUpdateSettings', () => {
  async function loaded() {
    server.on('GET /api/settings', () => json(settings))
    const rendered = renderSettings()
    await waitFor(() => expect(rendered.result.current.query.data).toEqual(settings))
    return rendered
  }

  it('sends only the fields to change', async () => {
    const { result } = await loaded()
    server.on('PUT /api/settings', () => json(saved({ format: 'aiff' })))

    await act(() => result.current.update.mutateAsync({ format: 'aiff' }))

    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ format: 'aiff' })
  })

  it("shows the change at once, then the server's answer", async () => {
    const { result, cached } = await loaded()
    const puts = heldPuts()

    act(() => result.current.update.mutate({ folder: '/Volumes/USB' }))

    await waitFor(() => expect(cached()?.folder).toBe('/Volumes/USB'))
    expect(result.current.query.data?.folder).toBe('/Volumes/USB')
    // The server also moves the folder to the front of the recents.
    const answer = saved({
      folder: '/Volumes/USB',
      recentFolders: ['/Volumes/USB', settings.folder],
    })
    act(() => puts.answer(0, json(answer)))

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))
    expect(cached()).toEqual(answer)
  })

  it('puts the settings back when the server refuses the change, and checks them again', async () => {
    const { result, cached } = await loaded()
    const puts = heldPuts()

    act(() => result.current.update.mutate({ folder: '/Volumes/USB' }))
    await waitFor(() => expect(cached()?.folder).toBe('/Volumes/USB'))
    act(() => puts.answer(0, failure()))

    await waitFor(() => expect(result.current.update.isError).toBe(true))
    expect(cached()?.folder).toBe(settings.folder)
    await waitFor(() => expect(server.callsTo('GET /api/settings')).toHaveLength(2))
  })

  it("keeps another update's pending change when an answer arrives", async () => {
    const { result, cached } = await loaded()
    const puts = heldPuts()

    act(() => result.current.update.mutate({ format: 'aiff' }))
    await waitFor(() => expect(puts.count()).toBe(1))
    act(() => result.current.update.mutate({ playlistSubfolder: true }))
    await waitFor(() => expect(cached()).toMatchObject({ format: 'aiff', playlistSubfolder: true }))

    // The first answer doesn't know the second change yet, which is sent only now.
    act(() => puts.answer(0, json(saved({ format: 'aiff' }))))
    await waitFor(() => expect(puts.count()).toBe(2))
    expect(cached()).toEqual(saved({ format: 'aiff', playlistSubfolder: true }))

    act(() => puts.answer(1, json(saved({ format: 'aiff', playlistSubfolder: true }))))
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))
    expect(cached()).toEqual(saved({ format: 'aiff', playlistSubfolder: true }))
  })

  it("rolls back only the failed update, keeping another's pending change", async () => {
    const { result, cached } = await loaded()
    const puts = heldPuts()
    const first: SettingsUpdate = { format: 'aiff' }

    act(() => result.current.update.mutate(first))
    await waitFor(() => expect(puts.count()).toBe(1))
    act(() => result.current.update.mutate({ playlistSubfolder: true }))
    await waitFor(() => expect(cached()).toMatchObject({ playlistSubfolder: true }))

    act(() => puts.answer(0, failure()))
    await waitFor(() => expect(cached()).toEqual(saved({ playlistSubfolder: true })))
    // The other update is still to save: its answer is the truth, no refetch needed.
    await waitFor(() => expect(puts.count()).toBe(2))
    expect(server.callsTo('GET /api/settings')).toHaveLength(1)

    act(() => puts.answer(1, json(saved({ playlistSubfolder: true }))))
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))
    expect(cached()).toEqual(saved({ playlistSubfolder: true }))
  })

  it('saves overlapping folder choices in the order they were made, so the latest wins', async () => {
    const { result, cached } = await loaded()
    const puts = heldPuts()
    const slow = '/Volumes/Sleeping Drive'
    const latest = '/Users/dj/Music/Sets'

    // The server is still checking the first folder (a drive waking up) when the second is chosen.
    act(() => result.current.update.mutate({ folder: slow }))
    await waitFor(() => expect(puts.count()).toBe(1))
    act(() => result.current.update.mutate({ folder: latest }))
    await waitFor(() => expect(cached()?.folder).toBe(latest))

    // The second waits for the first answer: sent together, the server could save them in the
    // wrong order (it saves a folder only once its check is done).
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(puts.count()).toBe(1)

    act(() => puts.answer(0, json(saved({ folder: slow, recentFolders: [slow] }))))
    await waitFor(() => expect(puts.count()).toBe(2))
    // The older answer doesn't take back the newer choice.
    expect(cached()?.folder).toBe(latest)
    act(() => puts.answer(1, json(saved({ folder: latest, recentFolders: [latest, slow] }))))

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))
    expect(cached()?.folder).toBe(latest)
    expect(server.callsTo('PUT /api/settings').map(jsonBody)).toEqual([
      { folder: slow },
      { folder: latest },
    ])
  })

  it('still sends a change while the browser says it is offline (the server is local)', async ({
    onTestFinished,
  }) => {
    const { result, cached } = await loaded()
    server.on('PUT /api/settings', () => json(saved({ format: 'wav' })))
    onTestFinished(() => onlineManager.setOnline(true))
    act(() => onlineManager.setOnline(false))

    await act(() => result.current.update.mutateAsync({ format: 'wav' }))

    expect(jsonBody(server.callsTo('PUT /api/settings')[0])).toEqual({ format: 'wav' })
    expect(cached()?.format).toBe('wav')
  })

  it('saves a change made before the settings loaded, then shows the answer', async () => {
    server.on('GET /api/settings', () => new Promise<Response>(() => {}))
    const { result, cached } = renderSettings()
    server.on('PUT /api/settings', () => json(saved({ format: 'flac' })))

    await act(() => result.current.update.mutateAsync({ format: 'flac' }))

    expect(cached()).toEqual(saved({ format: 'flac' }))
  })
})
