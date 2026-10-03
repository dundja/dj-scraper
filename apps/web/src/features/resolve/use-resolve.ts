import type { ResolveMode, ResolveResult } from '@dj-scraper/shared'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api.ts'

/** One load of a link: the normalized URL, the mode, and its number (results are keyed by it). */
export type Submission = { url: string; mode: ResolveMode; seq: number }

type Variables = Submission & { signal: AbortSignal }

export type Resolver = ReturnType<typeof useResolve>

/**
 * `POST /api/resolve` for the paste box. One resolve at a time: a new one aborts the one running
 * (closing the request stops yt-dlp on the server), and so do Cancel and unmounting. No retries:
 * a failure shows at once with a Try again button. A mutation, not a query: each paste is a new
 * request, even of the same URL, and its answer isn't shared.
 */
export function useResolve() {
  const controller = useRef<AbortController | undefined>(undefined)
  const lastSeq = useRef(0)
  const [canceled, setCanceled] = useState(false)
  const mutation = useMutation({
    mutationKey: ['resolve'],
    mutationFn: ({ url, mode, signal }: Variables): Promise<ResolveResult> =>
      api.resolve(mode === 'auto' ? { url } : { url, mode }, signal),
  })
  const { mutate, reset } = mutation

  const resolve = useCallback(
    (url: string, mode: ResolveMode = 'auto') => {
      controller.current?.abort()
      const next = new AbortController()
      controller.current = next
      lastSeq.current += 1
      setCanceled(false)
      // The signal travels with the variables, so a quick second paste can't hand its own to the
      // first request.
      mutate({ url, mode, seq: lastSeq.current, signal: next.signal })
    },
    [mutate],
  )

  const { status, variables } = mutation
  const pending = status === 'pending'

  /** Stops the running resolve and goes back to the start; a finished one's result stays. */
  const cancel = useCallback(() => {
    if (!pending) return
    controller.current?.abort()
    controller.current = undefined
    reset()
    setCanceled(true)
  }, [pending, reset])

  /**
   * Clears a failed resolve, back to the start: its Try again would load the old link under text
   * that replaced it. A running resolve and a result stay.
   */
  const dismissError = useCallback(() => {
    if (status === 'error') reset()
  }, [status, reset])

  useEffect(() => () => controller.current?.abort(), [])

  return {
    status,
    submission:
      variables === undefined
        ? undefined
        : { url: variables.url, mode: variables.mode, seq: variables.seq },
    /** When the current resolve started (ms since the epoch). */
    submittedAt: mutation.submittedAt,
    result: mutation.data,
    error: mutation.error,
    /** The last resolve was canceled and nothing has been loaded since. */
    canceled,
    resolve,
    cancel,
    dismissError,
  }
}
