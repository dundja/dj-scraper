import {
  type CreateDownloadsResponse,
  DownloadRequestSchema,
  MAX_BATCH_LABEL_LENGTH,
  SettingsSchema,
} from '@dj-scraper/shared'
import { testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settingsQueryKey, useSettings } from '@/features/settings/use-settings.ts'
import { ApiError } from '@/lib/api.ts'
import { downloadsQueryKey } from '@/lib/events.ts'
import { settings } from '@/test/downloads.ts'
import { fakeApi, json, jsonBody } from '@/test/fake-api.ts'
import { createTestQueryClient } from '@/test/render.tsx'
import { playlist, track } from '@/test/resolve.ts'
import { toTrackRef } from './track-ref.ts'
import { useCreateDownloads } from './use-create-downloads.ts'

let server: ReturnType<typeof fakeApi>

beforeEach(() => {
  server = fakeApi()
})

afterEach(() => {
  expect(server.unhandled).toEqual([])
})

/** useCreateDownloads, plus another hook to watch (e.g. useSettings), under a fresh QueryClient. */
function renderCreate<T>(watch?: () => T) {
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = () => ({ create: useCreateDownloads(), watched: watch?.() })
  return { ...renderHook(hook, { wrapper }), queryClient }
}

const created = (count: number): CreateDownloadsResponse => ({
  batchId: testUuid(100),
  jobIds: Array.from({ length: count }, (_, index) => testUuid(index + 1)),
  duplicates: 0,
})

const sent = () => DownloadRequestSchema.parse(jsonBody(server.callsTo('POST /api/downloads')[0]))

describe('useCreateDownloads', () => {
  it("queues a single track into the settings' folder with their options", async () => {
    server.on('GET /api/settings', () => json(settings))
    server.on('POST /api/downloads', () => json(created(1)))
    const { result } = renderCreate()

    let answer: CreateDownloadsResponse | undefined
    await act(async () => {
      answer = await result.current.create.mutateAsync({
        items: [toTrackRef(track)],
        label: track.title,
      })
    })

    expect(answer).toEqual(created(1))
    expect(sent()).toEqual({
      items: [toTrackRef(track)],
      folder: '/Users/dj/Music/DJ Scraper',
      options: {
        format: 'mp3',
        filenameTemplate: '{artist} - {title}',
        embedArtwork: true,
        sourceUrlComment: true,
      },
      label: 'The Chill Zone',
    })
  })

  it('uses the settings already loaded, including a change still saving', async () => {
    server.on('POST /api/downloads', () => json(created(2)))
    const { result, queryClient } = renderCreate()
    queryClient.setQueryData(
      settingsQueryKey,
      SettingsSchema.parse({ ...settings, folder: '/Volumes/USB', format: 'aiff' }),
    )
    const items = playlist.entries.slice(0, 2).map(toTrackRef)

    await act(() =>
      result.current.create.mutateAsync({
        items,
        subfolder: playlist.title,
        label: playlist.title,
      }),
    )

    expect(server.callsTo('GET /api/settings')).toEqual([])
    expect(sent()).toMatchObject({
      items,
      folder: '/Volumes/USB',
      options: { format: 'aiff', subfolder: 'Warm-up Selection' },
      label: 'Warm-up Selection',
    })
  })

  it('refreshes the settings afterwards, as the folder joined the recent ones', async () => {
    const recent = SettingsSchema.parse({ ...settings, recentFolders: ['/Volumes/USB'] })
    server.on('GET /api/settings', () =>
      json(server.callsTo('GET /api/settings').length > 1 ? settings : recent),
    )
    server.on('POST /api/downloads', () => json(created(1)))
    // Something on screen shows the settings, as the folder picker does.
    const { result, queryClient } = renderCreate(() => useSettings())
    await waitFor(() => expect(result.current.watched?.data).toEqual(recent))

    await act(() => result.current.create.mutateAsync({ items: [toTrackRef(track)] }))

    await waitFor(() => expect(result.current.watched?.data).toEqual(settings))
    expect(queryClient.getQueryState(settingsQueryKey)?.isInvalidated).toBe(false)
  })

  it('only marks the settings stale when nothing shows them', async () => {
    server.on('GET /api/settings', () => json(settings))
    server.on('POST /api/downloads', () => json(created(1)))
    const { result, queryClient } = renderCreate()

    await act(() => result.current.create.mutateAsync({ items: [toTrackRef(track)] }))

    expect(queryClient.getQueryState(settingsQueryKey)?.isInvalidated).toBe(true)
    expect(server.callsTo('GET /api/settings')).toHaveLength(1)
  })

  it("never writes into ['downloads']: the event stream brings the jobs", async () => {
    server.on('GET /api/settings', () => json(settings))
    server.on('POST /api/downloads', () => json(created(1)))
    const { result, queryClient } = renderCreate()

    await act(() => result.current.create.mutateAsync({ items: [toTrackRef(track)] }))

    expect(queryClient.getQueryData(downloadsQueryKey)).toBeUndefined()
  })

  it('leaves out a blank label and clips a long one', async () => {
    server.on('GET /api/settings', () => json(settings))
    server.on('POST /api/downloads', () => json(created(1)))
    const { result } = renderCreate()

    await act(() => result.current.create.mutateAsync({ items: [toTrackRef(track)], label: '  ' }))
    expect(sent()).not.toHaveProperty('label')

    await act(() =>
      result.current.create.mutateAsync({
        items: [toTrackRef(track)],
        label: 'Long title '.repeat(40),
      }),
    )
    const label = DownloadRequestSchema.parse(
      jsonBody(server.callsTo('POST /api/downloads')[1]),
    ).label
    expect(label).toHaveLength(MAX_BATCH_LABEL_LENGTH)
  })

  it("fails with the server's error and keeps the settings as they were", async () => {
    server.on('GET /api/settings', () => json(settings))
    server.on('POST /api/downloads', () =>
      json(
        {
          error: {
            code: 'folder_unavailable',
            message: "That folder doesn't exist. Check the path, or that its drive is connected.",
          },
        },
        422,
      ),
    )
    const { result } = renderCreate()

    act(() => result.current.create.mutate({ items: [toTrackRef(track)] }))

    await waitFor(() => expect(result.current.create.isError).toBe(true))
    expect(result.current.create.error).toBeInstanceOf(ApiError)
    expect(result.current.create.error).toMatchObject({ kind: 'api', code: 'folder_unavailable' })
    expect(server.callsTo('GET /api/settings')).toHaveLength(1)
  })

  it("fails without a request when the settings can't be loaded", async () => {
    server.on('GET /api/settings', () =>
      json({ error: { code: 'unknown', message: 'Internal server error' } }, 500),
    )
    const { result } = renderCreate()

    act(() => result.current.create.mutate({ items: [toTrackRef(track)] }))

    await waitFor(() => expect(result.current.create.isError).toBe(true))
    expect(server.callsTo('POST /api/downloads')).toEqual([])
  })
})
