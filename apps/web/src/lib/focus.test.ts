import { afterEach, describe, expect, it } from 'vitest'
import { focusNextAfter } from './focus.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Sets the page's markup and returns the element with `id`. */
function page(html: string, id: string): HTMLElement {
  document.body.innerHTML = html
  const element = document.getElementById(id)
  if (element === null) throw new Error(`No #${id}`)
  return element
}

describe('focusNextAfter', () => {
  it('focuses the first focusable element after the given one, skipping its own', () => {
    const banner = page(
      `<button id="before">Before</button>
       <div id="banner"><button>Dismiss</button></div>
       <p>Text</p>
       <input id="next" />`,
      'banner',
    )

    expect(focusNextAfter(banner)).toBe(true)
    expect(document.activeElement?.id).toBe('next')
  })

  it('skips disabled, hidden and untabbable elements', () => {
    const banner = page(
      `<div id="banner"></div>
       <button disabled>Disabled</button>
       <input type="hidden" />
       <div tabindex="-1">Programmatic only</div>
       <a>Not a link</a>
       <a id="next" href="/">Link</a>`,
      'banner',
    )

    expect(focusNextAfter(banner)).toBe(true)
    expect(document.activeElement?.id).toBe('next')
  })

  it('says so when nothing follows', () => {
    const banner = page('<button>Before</button><div id="banner"></div>', 'banner')

    expect(focusNextAfter(banner)).toBe(false)
    expect(focusNextAfter(null)).toBe(false)
  })
})
