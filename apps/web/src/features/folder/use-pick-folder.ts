import type { FolderPickResponse } from '@dj-scraper/shared'
import { type MutateOptions, useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/lib/api.ts'

type PickOptions = MutateOptions<FolderPickResponse, Error, string | undefined>

/**
 * `POST /api/folders/pick`: the server opens the macOS folder dialog, starting in `startIn`, and
 * answers once the user has chosen (up to 5 minutes later). Aborting the request closes the dialog:
 * `cancel()` does, and so does unmounting. An abort rejects the mutation with an AbortError, which
 * callers show nothing for.
 */
export function usePickFolder() {
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const mutation = useMutation({
    mutationKey: ['folders', 'pick'],
    mutationFn: (startIn: string | undefined) => {
      controller.current?.abort()
      const current = new AbortController()
      controller.current = current
      return api.pickFolder(startIn === undefined ? {} : { startIn }, current.signal)
    },
  })

  return {
    /** Opens the dialog; the options' callbacks run only while the caller is mounted. */
    start: (startIn: string | undefined, options: PickOptions) => mutation.mutate(startIn, options),
    /** Whether the dialog is open (as far as this tab knows). */
    pending: mutation.isPending,
    /** Closes the dialog without a choice. */
    cancel: () => controller.current?.abort(),
  }
}
