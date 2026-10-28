import type { Virtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * Roving focus over the track table's checkboxes: the table is one Tab stop, and Arrow Up/Down,
 * Page Up/Down, Home and End move between rows, scrolling the virtualized list so the row renders
 * before it takes focus. `active` is a position among the shown rows; the tab stop follows its row
 * (by collection index) when rows before it come or go. When the row itself leaves ("Hide
 * downloaded" takes out a row that just finished) the row now at its position takes the tab stop,
 * and the focus too if the row had it, so focus never drops to the page.
 */
export function useRowFocus(
  rows: readonly { index: number }[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const count = rows.length
  const [active, setActive] = useState(0)
  // The row to focus once it renders: a far jump (End) renders it only after the scroll.
  const pendingFocus = useRef<number | null>(null)
  // The collection index of the row holding the tab stop, and whether its checkbox has the focus.
  const activeRow = useRef<number | undefined>(undefined)
  const focused = useRef(false)
  const shownRows = useRef(rows)

  // Stable, like the state setter it wraps, so the memoized rows don't re-render. It reads the
  // rows the last commit showed, which are the ones a focus or a key press acts on.
  const moveTo = useCallback((position: number) => {
    activeRow.current = shownRows.current[position]?.index
    setActive(position)
  }, [])

  // Before paint, so the tab stop never shows on the wrong row.
  useLayoutEffect(() => {
    if (shownRows.current === rows) return
    shownRows.current = rows
    const index = activeRow.current
    if (index === undefined) return
    const position = rows.findIndex((row) => row.index === index)
    if (position !== -1) {
      setActive(position)
      return
    }
    const next = Math.max(0, Math.min(active, rows.length - 1))
    activeRow.current = rows[next]?.index
    setActive(next)
    // Its checkbox went with it: hand the focus on, unless it had already moved elsewhere.
    const current = document.activeElement
    if (focused.current && rows.length > 0 && (current === null || current === document.body)) {
      pendingFocus.current = next
    }
  }, [rows, active])

  // Whether a row's checkbox has the focus. A checkbox removed with its row may fire no focusout,
  // so `focused` stays set, and the effect above checks where the focus is now.
  useEffect(() => {
    const list = scrollRef.current
    if (list === null) return
    const onFocusIn = () => {
      focused.current = true
    }
    const onFocusOut = (event: FocusEvent) => {
      const to = event.relatedTarget
      if (to instanceof Node && !list.contains(to)) focused.current = false
    }
    list.addEventListener('focusin', onFocusIn)
    list.addEventListener('focusout', onFocusOut)
    return () => {
      list.removeEventListener('focusin', onFocusIn)
      list.removeEventListener('focusout', onFocusOut)
    }
  }, [scrollRef])

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
    moveTo(to)
    virtualizer.scrollToIndex(to)
  }

  return { active: Math.max(0, Math.min(active, count - 1)), setActive: moveTo, onKeyDown }
}
