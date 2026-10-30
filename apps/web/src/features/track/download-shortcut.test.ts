import { afterEach, describe, expect, it } from 'vitest'
import { isDownloadShortcut } from './download-shortcut.ts'

afterEach(() => {
  document.body.replaceChildren()
})

/** A keydown dispatched on `target`, read by isDownloadShortcut while it is delivered. */
function shortcutOn(target: Element, init: KeyboardEventInit): boolean {
  let result: boolean | undefined
  const listener = (event: KeyboardEvent) => {
    result = isDownloadShortcut(event)
  }
  document.addEventListener('keydown', listener)
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  document.removeEventListener('keydown', listener)
  if (result === undefined) throw new Error('The keydown never reached the document')
  return result
}

function element(html: string): Element {
  document.body.innerHTML = html
  const first = document.body.querySelector('[data-target]')
  if (first === null) throw new Error('No [data-target]')
  return first
}

describe('isDownloadShortcut', () => {
  it.each([
    ['⌘D', { key: 'd', metaKey: true }, true],
    ['Ctrl+D', { key: 'd', ctrlKey: true }, true],
    ['⌘D with Caps Lock', { key: 'D', metaKey: true }, true],
    ['D alone', { key: 'd' }, false],
    ['⌘⇧D (bookmark all tabs)', { key: 'D', metaKey: true, shiftKey: true }, false],
    ['⌘⌥D (the Dock)', { key: '∂', metaKey: true, altKey: true }, false],
    ['⌘V', { key: 'v', metaKey: true }, false],
  ])('%s on the page: %s', (_label, init, expected) => {
    expect(shortcutOn(document.body, init)).toBe(expected)
  })

  it('leaves a keydown another handler took', () => {
    const button = element('<button data-target>Play</button>')
    button.addEventListener('keydown', (event) => event.preventDefault())
    expect(shortcutOn(button, { key: 'd', metaKey: true })).toBe(false)
  })

  it.each([
    ['a text input', '<input data-target>'],
    ['a search field', '<input type="search" data-target>'],
    ['a textarea', '<textarea data-target></textarea>'],
    ['rich text', '<div contenteditable="true"><p data-target>notes</p></div>'],
  ])('is ignored inside %s', (_label, html) => {
    const field = element(html)
    expect(shortcutOn(field, { key: 'd', metaKey: true })).toBe(false)
    expect(shortcutOn(field, { key: 'd', ctrlKey: true })).toBe(false)
  })

  it('counts on buttons, checkboxes and read-only fields, where it edits nothing', () => {
    expect(
      shortcutOn(element('<button data-target>Play</button>'), { key: 'd', metaKey: true }),
    ).toBe(true)
    expect(
      shortcutOn(element('<input type="checkbox" data-target>'), { key: 'd', metaKey: true }),
    ).toBe(true)
    expect(shortcutOn(element('<input readonly data-target>'), { key: 'd', metaKey: true })).toBe(
      true,
    )
  })

  it('takes only ⌘D in a field marked data-download-shortcut (the link box)', () => {
    const box = element('<input type="url" data-download-shortcut data-target>')
    expect(shortcutOn(box, { key: 'd', metaKey: true })).toBe(true)
    expect(shortcutOn(box, { key: 'd', ctrlKey: true })).toBe(false)
  })
})
