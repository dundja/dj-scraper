/** Elements that can take keyboard focus (enabled, and not taken out of the Tab order). */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Focuses the first focusable element after `element` (outside it) in document order, as Tab
 * would. For a control that removes itself together with its container (dismissing a banner):
 * without this the focus falls back to the page's start. Returns whether something took focus.
 */
export function focusNextAfter(element: Element | null): boolean {
  if (element === null) return false
  const document = element.ownerDocument
  for (const candidate of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (element.contains(candidate)) continue
    if (!(element.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
    candidate.focus()
    // A hidden element doesn't take focus: try the next one.
    if (document.activeElement === candidate) return true
  }
  return false
}
