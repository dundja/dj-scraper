import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '@/lib/api.ts'

export const healthQueryKey = ['health'] as const

/** While the check fails (server down, bad reply), try again this often so the status recovers. */
const RETRY_WHILE_FAILING_MS = 3000

export const healthQueryOptions = queryOptions({
  queryKey: healthQueryKey,
  queryFn: ({ signal }) => api.health(signal),
  // The first probe can take seconds; a failure shows at once and the interval below retries it.
  retry: false,
  refetchInterval: (query) => (query.state.status === 'error' ? RETRY_WHILE_FAILING_MS : false),
})

export function useHealth() {
  return useQuery(healthQueryOptions)
}

/** POST /api/health/recheck: probes the engine now and puts the result into the health query. */
export function useRecheckHealth() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [...healthQueryKey, 'recheck'],
    mutationFn: () => api.recheckHealth(),
    onSuccess: (health) => queryClient.setQueryData(healthQueryKey, health),
    onError: (error) => {
      // The server went away: let the status chip say so (and start retrying).
      if (error instanceof ApiError && error.kind === 'unreachable') {
        void queryClient.invalidateQueries({ queryKey: healthQueryKey })
      }
    },
  })
}
