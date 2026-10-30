import { isEditableTarget } from '@/features/resolve/paste-text.ts'

/**
 * Whether `event` is the track card's Download shortcut: ⌘D, or Ctrl+D off macOS, outside text
 * fields. Not with Shift or Option (⌘⇧D bookmarks every tab), nor once handled elsewhere. A field
 * marked `data-download-shortcut` (the link box) takes ⌘D too: the focus sits there after every
 * paste, and ⌘D edits nothing in it (Ctrl+D does on macOS: it deletes forward).
 */
export function isDownloadShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey) return false
  if (event.key.toLowerCase() !== 'd' || !(event.metaKey || event.ctrlKey)) return false
  if (!isEditableTarget(event.target)) return true
  return (
    event.metaKey &&
    event.target instanceof Element &&
    event.target.closest('[data-download-shortcut]') !== null
  )
}
