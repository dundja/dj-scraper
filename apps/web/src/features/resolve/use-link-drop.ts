import { type RefObject, useEffect, useEffectEvent, useState } from 'react'
import {
  carriesFiles,
  carriesLink,
  dropCandidate,
  dropLink,
  isEditableTarget,
} from './paste-text.ts'

/**
 * Drop a link anywhere on the window: returns whether a link is being dragged over it (for the
 * overlay), and calls `onDrop` with the dropped link. Text without a link dropped on a text field
 * other than `box` (the collection's filter) is left to that field. A dragged file is refused, so
 * the browser can't open it in place of the app. Drags that start on this page (a link in the
 * header) are left to the browser.
 */
export function useLinkDrop(
  onDrop: (text: string) => void,
  box: RefObject<HTMLElement | null>,
): boolean {
  const [dragging, setDragging] = useState(false)
  const handleDrop = useEffectEvent(onDrop)

  useEffect(() => {
    // dragenter and dragleave fire for every element the pointer crosses: count them, so moving
    // between elements doesn't flicker the overlay, and leaving the window (or Esc) clears it.
    let depth = 0
    let fromThisPage = false
    /** A drag's types, when it comes from outside the page. */
    const externalTypes = (event: DragEvent): readonly string[] =>
      fromThisPage || event.dataTransfer == null ? [] : [...event.dataTransfer.types]
    const isLinkDrag = (event: DragEvent) => carriesLink(externalTypes(event))
    const isFileDrag = (event: DragEvent) => carriesFiles(externalTypes(event))
    const stop = () => {
      depth = 0
      setDragging(false)
    }

    const onDragStart = () => {
      fromThisPage = true
    }
    const onDragEnd = () => {
      fromThisPage = false
      stop()
    }
    const onDragEnter = (event: DragEvent) => {
      if (!isLinkDrag(event)) return
      depth += 1
      setDragging(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (!isLinkDrag(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer == null) return
      if (isFileDrag(event)) {
        // Refused: left to the browser, a dropped file would replace the app in the tab.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'none'
      } else if (isLinkDrag(event)) {
        // Without this the browser refuses the drop (or opens the link in place of the app).
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDropEvent = (event: DragEvent) => {
      const data = event.dataTransfer
      if (data == null) return
      if (isFileDrag(event)) {
        event.preventDefault()
        return
      }
      if (!isLinkDrag(event)) return
      stop()
      const toOtherField = event.target !== box.current && isEditableTarget(event.target)
      const text = toOtherField ? dropLink(data) : dropCandidate(data)
      // Text without a link is that field's, as a paste into it would be: the browser inserts it.
      if (toOtherField && text === undefined) return
      event.preventDefault()
      if (text !== undefined) handleDrop(text)
    }

    const listeners = [
      ['dragstart', onDragStart],
      ['dragend', onDragEnd],
      ['dragenter', onDragEnter],
      ['dragleave', onDragLeave],
      ['dragover', onDragOver],
      ['drop', onDropEvent],
    ] as const
    for (const [type, listener] of listeners) document.addEventListener(type, listener)
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener)
    }
  }, [box])

  return dragging
}
