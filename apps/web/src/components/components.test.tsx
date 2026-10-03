import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Artwork } from './artwork.tsx'
import { FolderPath } from './folder-path.tsx'
import { PlatformBadge } from './platform-badge.tsx'

const COVER = 'https://i.ytimg.com/vi/XNEnEBrHws8/hqdefault.jpg'

describe('PlatformBadge', () => {
  it.each([
    ['youtube', 'YouTube'],
    ['soundcloud', 'SoundCloud'],
    ['other', 'Web'],
  ] as const)('names %s as %s', (platform, label) => {
    const { container } = render(<PlatformBadge platform={platform} />)
    expect(container.textContent).toBe(label)
  })

  it('adds a decorative brand dot for YouTube and SoundCloud only', () => {
    const { container, rerender } = render(<PlatformBadge platform="youtube" />)
    expect(container.querySelector('[aria-hidden]')?.className).toContain('bg-red-500')
    rerender(<PlatformBadge platform="soundcloud" />)
    expect(container.querySelector('[aria-hidden]')?.className).toContain('bg-orange-500')
    rerender(<PlatformBadge platform="other" />)
    expect(container.querySelector('[aria-hidden]')).toBeNull()
  })

  it('takes extra classes', () => {
    const { container } = render(<PlatformBadge platform="youtube" className="ml-2" />)
    expect(container.firstElementChild?.className).toContain('ml-2')
  })
})

describe('Artwork', () => {
  it('loads the image lazily, square, without sending a referrer', () => {
    render(<Artwork src={COVER} alt="Cover of The Chill Zone" size={96} />)
    const image = screen.getByRole('img', { name: 'Cover of The Chill Zone' })

    expect(image).toHaveProperty('src', COVER)
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.getAttribute('width')).toBe('96')
    expect(image.getAttribute('height')).toBe('96')
    expect(image.className).toContain('object-cover')
  })

  it('is decorative by default, when the title is shown next to it', () => {
    const { container } = render(<Artwork src={COVER} size={32} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('shows a placeholder when there is no artwork', () => {
    const { container } = render(<Artwork src={undefined} size={32} />)
    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('[data-slot="artwork"]')
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true')
    expect(placeholder?.querySelector('svg')).not.toBeNull()
  })

  it('names the placeholder when the artwork has a name', () => {
    render(<Artwork src={undefined} alt="Cover of Warm-up Selection" size={128} />)
    expect(screen.getByRole('img', { name: 'Cover of Warm-up Selection' }).tagName).toBe('DIV')
  })

  it('falls back to the placeholder when the image fails, and tries a new src again', () => {
    const { container, rerender } = render(<Artwork src={COVER} size={32} />)
    const image = container.querySelector('img')
    if (image === null) throw new Error('expected an image')

    fireEvent.error(image)
    expect(container.querySelector('img')).toBeNull()

    const other = 'https://i1.sndcdn.com/artworks-000104942331-0yw4n9-original.jpg'
    rerender(<Artwork src={other} size={32} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(other)
  })
})

describe('FolderPath', () => {
  it('shows the home folder as ~, with the full path in its tooltip', () => {
    const { container } = render(<FolderPath path="/Users/dj/Music/DJ Scraper" />)
    const box = container.firstElementChild
    expect(box?.textContent).toBe('~/Music/DJ Scraper')
    expect(box?.getAttribute('title')).toBe('/Users/dj/Music/DJ Scraper')
  })

  it('cuts a long path at its start: a right-to-left box around the path isolated left-to-right', () => {
    const { container } = render(<FolderPath path="/Volumes/USB/Sets/Summer 2026" />)
    const box = container.firstElementChild
    expect(box?.getAttribute('dir')).toBe('rtl')
    expect(box?.className).toContain('truncate')
    // Short paths still sit on the left.
    expect(box?.className).toContain('text-left')
    const path = box?.querySelector('bdi')
    expect(path?.getAttribute('dir')).toBe('ltr')
    // The leading "/" is the path's first character, inside the isolate.
    expect(path?.textContent).toBe('/Volumes/USB/Sets/Summer 2026')
  })

  it('cuts what follows the path along with it, and takes its own tooltip and classes', () => {
    const { container } = render(
      <FolderPath path="/Users/dj/Music" title="Change it in the header" className="text-xs">
        <span>/Summer 2026</span>
      </FolderPath>,
    )
    const box = container.firstElementChild
    expect(box?.querySelector('bdi')?.textContent).toBe('~/Music/Summer 2026')
    expect(box?.getAttribute('title')).toBe('Change it in the header')
    expect(box?.className).toContain('text-xs')
  })
})
