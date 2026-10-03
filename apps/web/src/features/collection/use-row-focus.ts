import type { Virtualizer } from '@tanstack/react-virtual'
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'

/**
 * Roving focus over the track table's checkboxes: the table is one Tab stop, and Arrow Up/Down,
 * Page Up/Down, Home and End move between rows, scrolling the virtualized list so the row renders
 * before it takes focus. `active` is a position among the shown rows.
 */
export function useRowFocus(
  count: number,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const [active, setActive] = useState(0)
  // The row to focus once it renders: a far jump (End) renders it only after the scroll.
  const pendingFocus = useRef<number | null>(null)

  // After every render, since the row may appear in any later one.
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    const checkbox = scrollRef.current?.querySelector<HTMLElement>(
      `[data-position="${target}"] [role="checkbox"]`,
    )
    if (checkbox == null) return
    pendingFocus.current = null
    // The virtualizer scrolled the list to it already. Below lg the page scrolls too, and the
    // list's edge may be out of the window: bring the row in with as small a move as possible.
    checkbox.focus({ preventScroll: true })
    checkbox.scrollIntoView({ block: 'nearest' })
  })

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (count === 0 || event.altKey || event.ctrlKey || event.metaKey) return
    const from = Math.min(active, count - 1)
    const range = virtualizer.range
    const page = range === null ? 10 : Math.max(1, range.endIndex - range.startIndex)
    let to: number
    switch (event.key) {
      case 'ArrowDown':
        to = from + 1
        break
      case 'ArrowUp':
        to = from - 1
        break
      case 'PageDown':
        to = from + page
        break
      case 'PageUp':
        to = from - page
        break
      case 'Home':
        to = 0
        break
      case 'End':
        to = count - 1
        break
      default:
        return
    }
    event.preventDefault()
    to = Math.max(0, Math.min(to, count - 1))
    if (to === from) return
    pendingFocus.current = to
    setActive(to)
    virtualizer.scrollToIndex(to)
  }

  return { active: Math.max(0, Math.min(active, count - 1)), setActive, onKeyDown }
}
