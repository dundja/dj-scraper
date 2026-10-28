import type { RemixUpload } from '@dj-scraper/shared'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  getPreviewState,
  IDLE_PREVIEW,
  type PreviewState,
  previewKey,
  releasePreview,
  seekPreview,
  setPreviewPitchLock,
  setPreviewRate,
  subscribePreview,
  togglePreview,
} from './preview-player.ts'

/** The player's speed and pitch lock: the session's, whichever row is playing. */
export type PreviewSettings = Pick<PreviewState, 'rate' | 'preservesPitch'>

/**
 * A row's view of the one app-wide player: its state while this upload is the one being prepared or
 * played, `IDLE_PREVIEW` (one constant) otherwise, so a row re-renders only for its own playback.
 * The upload stops when the row unmounts. `toggle` starts, cancels, pauses, resumes or retries.
 */
export function usePreviewPlayer(upload: RemixUpload) {
  const key = previewKey(upload)
  const state = useSyncExternalStore(
    subscribePreview,
    () => {
      const current = getPreviewState()
      return current.key === key ? current : IDLE_PREVIEW
    },
    () => IDLE_PREVIEW,
  )
  useEffect(() => () => releasePreview(key), [key])
  const toggle = useCallback(() => togglePreview(upload), [upload])
  return {
    state,
    toggle,
    seek: seekPreview,
    setRate: setPreviewRate,
    setPitchLock: setPreviewPitchLock,
  }
}
