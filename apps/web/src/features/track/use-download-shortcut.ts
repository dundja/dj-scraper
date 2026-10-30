import { useEffect } from 'react'
import { isDownloadShortcut } from './download-shortcut.ts'

/**
 * ⌘D (Ctrl+D) while the track card is shown: `onPress`, or nothing while it is undefined (the
 * download is being added or has its job). Either way the browser's bookmark dialog stays shut, and
 * a held key presses once.
 */
export function useDownloadShortcut(onPress: (() => void) | undefined) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!isDownloadShortcut(event)) return
      event.preventDefault()
      if (!event.repeat) onPress?.()
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [onPress])
}
