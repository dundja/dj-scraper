import type { ErrorCode, Job } from '@dj-scraper/shared'
import { jobsByStatus, testUuid } from '@dj-scraper/shared/test-helpers'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api.ts'
import { downloadsQueryKey } from '@/lib/events.ts'
import { doneJob, downloadingJob, failedJob, jobWith, queuedJob } from '@/test/downloads.ts'
import { fakeApi, json, networkError } from '@/test/fake-api.ts'
import { createTestQueryClient } from '@/test/render.tsx'
import { actionError, actionName, canRun, jobAction, useJobAction } from './job-actions.ts'

const processingJob = jobWith(jobsByStatus.processing)
const skippedJob = jobWith(jobsByStatus.skipped)
const canceledJob = jobWith(jobsByStatus.canceled)
const failedWith = (code: ErrorCode) =>
  jobWith({ ...jobsByStatus.failed, error: { code, message: 'It failed.' } })
const canceling = jobWith({ ...jobsByStatus.downloading, cancelRequested: true })

describe('jobAction', () => {
  it.each<[string, Job, ReturnType<typeof jobAction>]>([
    ['queued', queuedJob, 'cancel'],
    ['downloading', downloadingJob, 'cancel'],
    ['processing', processingJob, 'cancel'],
    ['canceling', canceling, 'cancel'],
    ['done', doneJob, 'reveal'],
    ['skipped', skippedJob, 'reveal'],
    ['canceled', canceledJob, 'retry'],
    ['failed: network', failedJob, 'retry'],
    ['failed: rate limited', failedWith('rate_limited'), 'retry'],
    ['failed: folder gone', failedWith('folder_unavailable'), 'retry'],
    ['failed: disk full', failedWith('disk_full'), 'retry'],
    ['failed: private', failedWith('private'), undefined],
    ['failed: geo-blocked', failedWith('geo_blocked'), undefined],
    ['failed: preview only', failedWith('preview_only'), undefined],
    ['failed: age-restricted', failedWith('age_restricted'), undefined],
    ['failed: removed', failedWith('unavailable'), undefined],
  ])('%s offers %s', (_, job, action) => {
    expect(jobAction(job)).toBe(action)
  })
})

describe('canRun', () => {
  it('refuses a second cancel while one is underway', () => {
    expect(canRun(downloadingJob, 'cancel')).toBe(true)
    expect(canRun(canceling, 'cancel')).toBe(false)
    expect(canRun(canceledJob, 'retry')).toBe(true)
    expect(canRun(doneJob, 'reveal')).toBe(true)
  })
})

describe('actionName', () => {
  it('names the action, and with a title the row button it belongs to', () => {
    expect(actionName(queuedJob, 'cancel')).toBe('Cancel')
    expect(actionName(canceling, 'cancel')).toBe('Canceling…')
    expect(actionName(canceledJob, 'retry')).toBe('Retry')
    expect(actionName(doneJob, 'reveal')).toBe('Reveal in Finder')
    expect(actionName(queuedJob, 'cancel', 'Robo Kitty')).toBe('Cancel Robo Kitty')
    expect(actionName(canceling, 'cancel', 'Robo Kitty')).toBe('Canceling Robo Kitty…')
    expect(actionName(canceledJob, 'retry', 'Robo Kitty')).toBe('Retry Robo Kitty')
    expect(actionName(doneJob, 'reveal', 'Robo Kitty')).toBe('Reveal Robo Kitty in Finder')
  })
})

describe('actionError', () => {
  const notFound = new ApiError({
    kind: 'api',
    status: 404,
    code: 'not_found',
    message: 'This download has no file.',
  })

  it('says the file was moved or deleted when Reveal finds none', () => {
    expect(actionError('reveal', notFound)).toEqual({
      message: 'The file was moved or deleted.',
      code: 'not_found',
    })
  })

  it("puts what failed before the server's words, with the code's hint", () => {
    const conflict = new ApiError({
      kind: 'api',
      status: 409,
      code: 'invalid_request',
      message: "This link can't be downloaded, so retrying won't help.",
    })
    expect(actionError('retry', conflict)).toEqual({
      message: "Couldn't retry: This link can't be downloaded, so retrying won't help.",
      code: 'invalid_request',
    })
    expect(actionError('cancel', notFound)?.message).toBe(
      "Couldn't cancel: This download has no file.",
    )
    const finder = new ApiError({ kind: 'api', status: 500, code: 'unknown', message: 'Nope.' })
    expect(actionError('reveal', finder)).toMatchObject({
      message: "Couldn't show the file: Nope.",
      hint: 'If it keeps happening, update yt-dlp: `brew upgrade yt-dlp`.',
    })
  })

  it('says how to start the server when it is unreachable', () => {
    const offline = new ApiError({ kind: 'unreachable', message: "Can't reach the server." })
    expect(actionError('cancel', offline)).toMatchObject({
      message: "Couldn't cancel: Can't reach the DJ Scraper server.",
      hint: expect.stringContaining('Start it with'),
    })
  })

  it('says nothing for an abort', () => {
    expect(actionError('cancel', new DOMException('Aborted', 'AbortError'))).toBeUndefined()
  })
})

describe('useJobAction', () => {
  let server: ReturnType<typeof fakeApi>

  beforeEach(() => {
    server = fakeApi()
  })

  afterEach(() => {
    expect(server.unhandled).toEqual([])
  })

  function renderAction(job: Job) {
    const queryClient = createTestQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const hook = renderHook(({ current }: { current: Job }) => useJobAction(current.id, current), {
      wrapper,
      initialProps: { current: job },
    })
    return { ...hook, queryClient }
  }

  it('posts the action for its job and never writes the answer into the downloads cache', async () => {
    const answer = jobWith({ ...jobsByStatus.downloading, cancelRequested: true })
    server.on(`POST /api/downloads/${downloadingJob.id}/cancel`, () => json(answer))
    const { result, queryClient } = renderAction(downloadingJob)

    act(() => result.current.run('cancel'))
    expect(result.current.pending).toBe('cancel')
    await waitFor(() => expect(result.current.pending).toBeUndefined())

    const [call] = server.callsTo(`POST /api/downloads/${downloadingJob.id}/cancel`)
    expect(call?.headers.get('Content-Type')).toBe('application/json')
    expect(result.current.error).toBeUndefined()
    expect(queryClient.getQueryData(downloadsQueryKey)).toBeUndefined()
  })

  it("keeps a failed action's error only while the job stays as it was", async () => {
    server.on(`POST /api/downloads/${downloadingJob.id}/cancel`, networkError)
    const { result, rerender } = renderAction(downloadingJob)

    act(() => result.current.run('cancel'))
    await waitFor(() => expect(result.current.error).toBeDefined())
    expect(result.current.error?.message).toBe(
      "Couldn't cancel: Can't reach the DJ Scraper server.",
    )

    // New progress: same status and attempt, the error stays.
    rerender({ current: jobWith({ ...jobsByStatus.downloading, progress: { percent: 80 } }) })
    expect(result.current.error).toBeDefined()

    // The job finished meanwhile: "Couldn't cancel" no longer applies.
    rerender({ current: jobWith({ ...jobsByStatus.done, id: downloadingJob.id }) })
    expect(result.current.error).toBeUndefined()
  })

  it('keeps an error to its own job when a list reuses the row for another one', async () => {
    server.on(`POST /api/downloads/${doneJob.id}/reveal`, () =>
      json({ error: { code: 'not_found', message: 'This download has no file.' } }, 404),
    )
    const { result, rerender } = renderAction(doneJob)

    act(() => result.current.run('reveal'))
    await waitFor(() =>
      expect(result.current.error?.message).toBe('The file was moved or deleted.'),
    )

    rerender({ current: jobWith({ ...jobsByStatus.done, id: testUuid(44) }) })
    expect(result.current.error).toBeUndefined()
  })
})
