import {
  REMIX_PLATFORMS,
  type RemixRequest,
  type RemixSuggestions,
  type Track,
} from '@dj-scraper/shared'
import { queryOptions, type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { api } from '@/lib/api.ts'
import { mergeRemixes, type RemixQueryState } from './remix-merge.ts'
import { remixRequestFor } from './remix-request.ts'

/** The server caches a search for 30 minutes; the app keeps its answer as long. */
const REMIX_CACHE_MS = 30 * 60_000

/**
 * How long an answer stays fresh: 30 minutes, like the server's cache, unless one of its searches
 * failed. The server doesn't cache a failed search, so such an answer is stale at once: pasting the
 * same track again searches again instead of showing the old failure.
 */
export function remixStaleTime(data: RemixSuggestions | undefined): number {
  if (data === undefined) return 0
  const failed = REMIX_PLATFORMS.some((platform) => data.searches[platform].status === 'error')
  return failed ? 0 : REMIX_CACHE_MS
}

/**
 * The remix search for one request (ADR-027): a read-only query, keyed by the request, so pasting
 * the same track again within 30 minutes shows its remixes at once (`remixStaleTime`). The query's
 * signal aborts the search when nothing shows it any more (the next paste). No retries: a failed
 * search shows its error with Try again, and each platform's own failure is in the answer.
 */
export function remixesQueryOptions(request: RemixRequest) {
  return queryOptions({
    queryKey: ['remixes', request] as const,
    queryFn: ({ signal }) => api.remixes(request, signal),
    staleTime: (query) => remixStaleTime(query.state.data),
    gcTime: REMIX_CACHE_MS,
    retry: false,
  })
}

/**
 * The remix suggestions for a resolved track (any track, unavailable ones too), from two searches
 * at once: YouTube alone, which answers in seconds, and both platforms, which waits for
 * SoundCloud. The server shares each platform's search between them, and `mergeRemixes` shows the
 * quick answer until the full one is in. The quick search is skipped when the full answer is
 * cached already. `retry` searches again: the full search, and the quick one when it failed.
 */
export function useRemixes(track: Track) {
  const full = useMemo(() => remixRequestFor(track), [track])
  const quick = useMemo((): RemixRequest => ({ ...full, platforms: ['youtube'] }), [full])
  const fullQuery = useQuery(remixesQueryOptions(full))
  const quickQuery = useQuery({
    ...remixesQueryOptions(quick),
    enabled: fullQuery.data === undefined,
  })

  const quickState = useQueryState(quickQuery)
  const fullState = useQueryState(fullQuery)
  const view = useMemo(() => mergeRemixes(quickState, fullState), [quickState, fullState])

  // Try again: the full search always (it holds every platform, and the server answers the
  // platforms that went fine from its cache), the quick one only when it failed.
  const { refetch: refetchQuick, isError: quickFailed } = quickQuery
  const { refetch: refetchFull } = fullQuery
  const retry = useCallback(() => {
    if (quickFailed) void refetchQuick()
    void refetchFull()
  }, [quickFailed, refetchQuick, refetchFull])

  return { view, retry, retrying: quickQuery.isFetching || fullQuery.isFetching }
}

/** A query's state for the merge, the same object while its status, data and error are. */
function useQueryState(query: UseQueryResult<RemixSuggestions>): RemixQueryState {
  const { status, data, error } = query
  return useMemo((): RemixQueryState => {
    if (status === 'success') return { status, data }
    if (status === 'error') return { status, error }
    return { status: 'pending' }
  }, [status, data, error])
}
