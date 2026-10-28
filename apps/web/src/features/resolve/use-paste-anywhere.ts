import { useEffect, useEffectEvent } from 'react'
import { isEditableTarget, pasteCandidate, spotifyTrackList } from './paste-text.ts'

/**
 * Paste anywhere: a paste outside a text field (⌘V with nothing focused, or a button) calls
 * `onPasteLinks` with its Spotify track links when it holds two or more (a playlist copied in the
 * Spotify app), else `onPaste` with its link, or its first line when there is none. Pastes into a
 * text field stay there (the paste box handles its own), and so does one another handler already
 * took.
 */
export function usePasteAnywhere(
  onPaste: (text: string) => void,
  onPasteLinks: (urls: string[]) => void,
) {
  const handlePaste = useEffectEvent(onPaste)
  const handlePasteLinks = useEffectEvent(onPasteLinks)
  useEffect(() => {
    const listener = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      const pasted = event.clipboardData?.getData('text/plain') ?? ''
      const links = spotifyTrackList(pasted)
      if (links !== undefined) {
        event.preventDefault()
        handlePasteLinks(links)
        return
      }
      const text = pasteCandidate(pasted)
      if (text === undefined) return
      event.preventDefault()
      handlePaste(text)
    }
    document.addEventListener('paste', listener)
    return () => document.removeEventListener('paste', listener)
  }, [])
}
