import { type RefObject, useEffect } from 'react'
import { isEditableTarget } from './paste-text.ts'

/**
 * ⌘V (Ctrl+V) outside a text field moves the focus into `box` and selects its text, before the
 * browser pastes: the paste then lands in the box, replacing what was there (the box loads a link
 * at once). Not every browser fires `paste` at a page with no text field focused, so this backs up
 * `usePasteAnywhere`, which still catches a paste from the Edit menu.
 */
export function usePasteShortcut(box: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== 'v' || isEditableTarget(event.target)) return
      box.current?.focus()
      box.current?.select()
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [box])
}
