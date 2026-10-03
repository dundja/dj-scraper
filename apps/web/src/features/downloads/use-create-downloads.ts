import { MAX_BATCH_LABEL_LENGTH, type TrackRef } from '@dj-scraper/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { settingsQueryKey, settingsQueryOptions } from '@/features/settings/use-settings.ts'
import { api } from '@/lib/api.ts'
import { clipText } from '@/lib/format.ts'
import { downloadOptionsFrom } from './track-ref.ts'

/** What to download; the folder and options come from the current settings. */
export type CreateDownloadsInput = {
  /** Built with `toTrackRef`, in the order to download. */
  items: TrackRef[]
  /** A folder inside the target folder, e.g. the playlist title (when the setting is on). */
  subfolder?: string
  /** What the downloads panel calls the batch: a playlist title, or a single track's title. */
  label?: string
}

/**
 * `POST /api/downloads` into the folder, format and options of `['settings']` (loading them first
 * if needed). The answer maps each item to its job id; the jobs themselves arrive through the event
 * stream, so this never touches `['downloads']`. On success it refreshes `['settings']`, because the
 * server adds the folder to `recentFolders`. Errors are ApiErrors: `folder_unavailable` when the
 * folder is gone or not writable.
 */
export function useCreateDownloads() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: ['create-downloads'],
    mutationFn: async ({ items, subfolder, label }: CreateDownloadsInput) => {
      const settings = await queryClient.ensureQueryData(settingsQueryOptions)
      const batchLabel = label?.trim()
      return api.createDownloads({
        items,
        folder: settings.folder,
        options: downloadOptionsFrom(settings, subfolder),
        ...(batchLabel ? { label: clipText(batchLabel, MAX_BATCH_LABEL_LENGTH) } : {}),
      })
    },
    // Not awaited: the mutation settles with the server's answer, not after the refetch.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
  })
}
