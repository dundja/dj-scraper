import type { RemixUpload } from '@dj-scraper/shared'
import { useCallback, useSyncExternalStore } from 'react'
import {
  getPreviewState,
  IDLE_PREVIEW,
  type NowPlayingDetails,
  type PreviewState,
  previewKey,
  subscribePreview,
  togglePreview,
} from './preview-player.ts'

/** The player's speed and pitch lock: the session's, whichever row is playing. */
export type PreviewSettings = Pick<PreviewState, 'rate' | 'preservesPitch'>

/**
 * A row's view of the one app-wide player: its state while this upload is the one being prepared or
 * played, `IDLE_PREVIEW` (one constant) otherwise, so a row re-renders only for its own playback.
 * `toggle` starts (with what the now-playing bar shows of it), cancels, pauses, resumes or retries.
 * The row leaving doesn't stop it (the bar plays on); its section leaving does (`releasePreview`).
 */
export function usePreviewPlayer(upload: RemixUpload, details: NowPlayingDetails) {
  const key = previewKey(upload)
  const state = useSyncExternalStore(
    subscribePreview,
    () => {
      const current = getPreviewState()
      return current.key === key ? current : IDLE_PREVIEW
    },
    () => IDLE_PREVIEW,
  )
  const { credit, version, jobs } = details
  const toggle = useCallback(
    () => togglePreview(upload, { credit, version, jobs }),
    [upload, credit, version, jobs],
  )
  return { state, toggle }
}

/** The whole player's state, for the now-playing bar: it re-renders as the time moves. */
export function usePreviewState(): PreviewState {
  return useSyncExternalStore(subscribePreview, getPreviewState, () => IDLE_PREVIEW)
}
