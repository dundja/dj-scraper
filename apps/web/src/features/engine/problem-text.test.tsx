import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProblemText } from './problem-text.tsx'
import { splitCode } from './split-code.ts'

describe('ProblemText', () => {
  it('renders backticked commands as code', () => {
    const { container } = render(
      <p>
        <ProblemText message="yt-dlp 2025.01.01 is too old: run `brew upgrade yt-dlp`." />
      </p>,
    )
    expect([...container.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'brew upgrade yt-dlp',
    ])
    expect(container.textContent).toBe('yt-dlp 2025.01.01 is too old: run brew upgrade yt-dlp.')
  })
})

describe('splitCode', () => {
  it('keys parts by their offset in the message', () => {
    expect(splitCode('install deno (`brew install deno`) or')).toEqual([
      { start: 0, text: 'install deno (', code: false },
      { start: 15, text: 'brew install deno', code: true },
      { start: 33, text: ') or', code: false },
    ])
  })

  it('keeps an unpaired backtick as text', () => {
    expect(splitCode('a `b` c `d')).toEqual([
      { start: 0, text: 'a ', code: false },
      { start: 3, text: 'b', code: true },
      { start: 5, text: ' c `d', code: false },
    ])
  })
})
