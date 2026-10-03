import type { BulkJobsResponse, JobScope } from '@dj-scraper/shared'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api.ts'

/** The panel's bulk actions, for every job (`scope: 'all'`) or one batch's. */
export type BulkAction = 'cancel' | 'retry' | 'clear'

export type BulkRequest = { action: BulkAction; target: JobScope }

/** Menu labels, and what a failure says it couldn't do. */
export const BULK_ACTIONS: Record<BulkAction, { label: string; failed: string }> = {
  cancel: { label: 'Cancel all', failed: "Couldn't cancel the downloads." },
  retry: { label: 'Retry failed', failed: "Couldn't retry the failed downloads." },
  clear: { label: 'Clear finished', failed: "Couldn't clear the finished downloads." },
}

/** The request for `action` over `target`. "Retry failed" retries failed jobs only, not canceled ones. */
export function runBulkAction({ action, target }: BulkRequest): Promise<BulkJobsResponse> {
  switch (action) {
    case 'cancel':
      return api.cancelDownloads({ target })
    case 'retry':
      return api.retryDownloads({ target, statuses: ['failed'] })
    case 'clear':
      return api.clearDownloads({ target })
  }
}

/**
 * One mutation for every bulk action in the panel, so the panel shows the last failure in one
 * place. The answer is only a count: the changes themselves arrive through the event stream, so
 * nothing is written into `['downloads']`.
 */
export function useBulkAction() {
  return useMutation({ mutationKey: ['downloads-bulk'], mutationFn: runBulkAction })
}
