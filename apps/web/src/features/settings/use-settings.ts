import type { Settings, SettingsUpdate } from '@dj-scraper/shared'
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/lib/api.ts'

/** `['settings']`: the server's settings. A download refreshes it (the folder joins the recents). */
export const settingsQueryOptions = queryOptions({
  queryKey: ['settings'] as const,
  queryFn: ({ signal }) => api.getSettings(signal),
})
/** Typed with the settings, so `getQueryData`/`setQueryData` know the shape. */
export const settingsQueryKey = settingsQueryOptions.queryKey
const updateSettingsKey = ['settings', 'update'] as const

export function useSettings() {
  return useQuery(settingsQueryOptions)
}

/**
 * `PUT /api/settings` with the fields to change. The change shows at once (optimistic), the server's
 * answer replaces it, and a failure puts the settings back (then refetches them, unless another
 * update is still saving).
 *
 * Updates are sent one at a time, in the order they were made (one mutation scope): the server
 * checks a new folder before saving it, which can take seconds (a sleeping drive, the macOS privacy
 * prompt), so two overlapping folder picks could otherwise be saved in the wrong order. A later
 * update shows at once and waits its turn; each answer keeps the waiting updates' changes on top.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: updateSettingsKey,
    scope: { id: 'settings' },
    mutationFn: (update: SettingsUpdate) => api.updateSettings(update),
    onMutate: async (update) => {
      // A settings fetch that lands after this would overwrite the optimistic value.
      await queryClient.cancelQueries({ queryKey: settingsQueryKey })
      const previous = queryClient.getQueryData(settingsQueryKey)
      if (previous !== undefined) {
        queryClient.setQueryData(settingsQueryKey, { ...previous, ...update })
      }
      return { previous }
    },
    onSuccess: (saved, update) => {
      const pending = otherPendingUpdates(queryClient, update)
      queryClient.setQueryData(settingsQueryKey, withUpdates(saved, pending))
    },
    onError: (_error, update, context) => {
      const pending = otherPendingUpdates(queryClient, update)
      if (context?.previous !== undefined) {
        queryClient.setQueryData(settingsQueryKey, withUpdates(context.previous, pending))
      }
      // The snapshot may hold another update's optimistic value that has since failed too.
      if (pending.length === 0) void queryClient.invalidateQueries({ queryKey: settingsQueryKey })
    },
  })
}

/**
 * The changes of the settings updates still in flight, oldest first, except `settled`. In one scope
 * they were all made after `settled` (they wait for it), so their changes are newer than its answer.
 */
function otherPendingUpdates(queryClient: QueryClient, settled: SettingsUpdate): SettingsUpdate[] {
  // A mutation counts as pending until its callbacks have run, so `settled` is among them, and so
  // are the updates still waiting their turn.
  return queryClient
    .getMutationCache()
    .findAll({ mutationKey: updateSettingsKey, status: 'pending' })
    .map((mutation) => mutation.state.variables)
    .filter((update): update is SettingsUpdate => update !== settled && isUpdate(update))
}

function withUpdates(settings: Settings, updates: readonly SettingsUpdate[]): Settings {
  const merged = { ...settings }
  for (const update of updates) Object.assign(merged, update)
  return merged
}

const isUpdate = (value: unknown): value is SettingsUpdate =>
  typeof value === 'object' && value !== null
