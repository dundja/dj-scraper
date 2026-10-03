import { useEffect, useEffectEvent } from 'react'
import { isEditableTarget, pasteCandidate } from './paste-text.ts'

/**
 * Paste anywhere: a paste outside a text field (⌘V with nothing focused, or a button) calls
 * `onPaste` with its link, or its first line when there is none. Pastes into a text field stay
 * there (the paste box handles its own), and so does one another handler already took.
 */
export function usePasteAnywhere(onPaste: (text: string) => void) {
  const handlePaste = useEffectEvent(onPaste)
  useEffect(() => {
    const listener = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      const text = pasteCandidate(event.clipboardData?.getData('text/plain') ?? '')
      if (text === undefined) return
      event.preventDefault()
      handlePaste(text)
    }
    document.addEventListener('paste', listener)
    return () => document.removeEventListener('paste', listener)
  }, [])
}
