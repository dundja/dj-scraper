import { isRetryableError, isTerminalStatus, type Job } from '@dj-scraper/shared'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api } from '@/lib/api.ts'
import { describeError, type ErrorDescription } from '@/lib/error-text.ts'

export type JobAction = 'cancel' | 'retry' | 'reveal'

/**
 * The action a job offers now. There is never more than one, so rows and the track card keep one
 * button whose action follows the job (focus stays on it as Cancel turns into Retry):
 * - cancel: queued, downloading or processing (shown busy while `cancelRequested`);
 * - retry: canceled, or failed with an error a new try may fix (`isRetryableError`);
 * - reveal: done or skipped (the file is in the folder).
 * A failure retrying can't fix (private, geo-blocked, preview…) offers nothing.
 */
export function jobAction(job: Job): JobAction | undefined {
  if (!isTerminalStatus(job.status)) return 'cancel'
  switch (job.status) {
    case 'done':
    case 'skipped':
      return 'reveal'
    case 'canceled':
      return 'retry'
    case 'failed':
      return isRetryableError(job.error.code) ? 'retry' : undefined
    default:
      return undefined
  }
}

/** Whether `action` can run now: a cancel already underway can't be asked again. */
export function canRun(job: Job, action: JobAction): boolean {
  return action !== 'cancel' || job.cancelRequested !== true
}

/**
 * The action's name: "Cancel", "Canceling…" while a cancel is underway, "Retry", "Reveal in
 * Finder". With `title`, the name a list row's icon button needs: "Retry <title>".
 */
export function actionName(job: Job, action: JobAction, title?: string): string {
  const named = title === undefined ? '' : ` ${title}`
  switch (action) {
    case 'cancel':
      return canRun(job, 'cancel') ? `Cancel${named}` : `Canceling${named}…`
    case 'retry':
      return `Retry${named}`
    case 'reveal':
      return `Reveal${named} in Finder`
  }
}

const CALLS: Record<JobAction, (id: string) => Promise<unknown>> = {
  cancel: (id) => api.cancelDownload(id),
  retry: (id) => api.retryDownload(id),
  reveal: (id) => api.revealDownload(id),
}

const FAILED: Record<JobAction, string> = {
  cancel: "Couldn't cancel",
  retry: "Couldn't retry",
  reveal: "Couldn't show the file",
}

/**
 * Words for a failed action: "The file was moved or deleted." when Reveal finds no file (404),
 * else the error's own words after what failed ("Couldn't retry: …").
 */
export function actionError(action: JobAction, error: unknown): ErrorDescription | undefined {
  if (action === 'reveal' && error instanceof ApiError && error.status === 404) {
    return { message: 'The file was moved or deleted.', code: 'not_found' }
  }
  const description = describeError(error)
  return description && { ...description, message: `${FAILED[action]}: ${description.message}` }
}

/** What a job's button needs: run an action, which one is in flight, and why the last one failed. */
export type JobActionControl = {
  run: (action: JobAction) => void
  pending: JobAction | undefined
  error: ErrorDescription | undefined
}

/**
 * Cancel, retry and reveal for one job (`job` is undefined until the event stream brings it). The
 * answers only confirm: the job's new state arrives through the event stream, never written into
 * `['downloads']` from here. A failed action's error shows until the job changes status or
 * attempt, so "Couldn't cancel" doesn't linger on a job that has since finished.
 */
export function useJobAction(jobId: string, job: Job | undefined): JobActionControl {
  const { mutate, variables, error, isPending } = useMutation({
    mutationFn: (action: JobAction) => CALLS[action](jobId),
  })
  const state = job === undefined ? `${jobId}:gone` : `${job.id}:${job.status}:${job.attempt}`
  // The job's state when the last action ran.
  const [ranOn, setRanOn] = useState<string>()

  return {
    run: (action) => {
      setRanOn(state)
      mutate(action)
    },
    pending: isPending ? variables : undefined,
    error:
      error !== null && variables !== undefined && ranOn === state
        ? actionError(variables, error)
        : undefined,
  }
}
