import { MAX_URL_LENGTH } from '@dj-scraper/shared'
import { describe, expect, it } from 'vitest'
import {
  carriesFiles,
  carriesLink,
  dropCandidate,
  dropLink,
  findLink,
  isEditableTarget,
  pasteCandidate,
} from './paste-text.ts'
import { urlVerdict } from './url-verdict.ts'

/** A DataTransfer's getData over a map of formats; missing formats read as '', as in browsers. */
const transfer = (formats: Record<string, string>) => ({
  getData: (format: string) => formats[format] ?? '',
})

describe('findLink', () => {
  it('takes a link on its own, trimmed', () => {
    expect(findLink('  https://youtu.be/XNEnEBrHws8 \n')).toBe('https://youtu.be/XNEnEBrHws8')
  })

  it('finds the first link in running text, also on a later line', () => {
    expect(findLink('listen to https://soundcloud.com/a/b and https://youtu.be/x')).toBe(
      'https://soundcloud.com/a/b',
    )
    expect(findLink('Tonight’s set:\nhttps://www.youtube.com/watch?v=XNEnEBrHws8 🔥')).toBe(
      'https://www.youtube.com/watch?v=XNEnEBrHws8',
    )
  })

  it('keeps query strings, fragments and an http scheme', () => {
    const url = 'http://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&index=2#t=30'
    expect(findLink(`see ${url}`)).toBe(url)
  })

  it('leaves out the punctuation of the sentence around the link', () => {
    expect(findLink('Got it from https://youtu.be/abc.')).toBe('https://youtu.be/abc')
    expect(findLink('https://youtu.be/abc, https://youtu.be/def')).toBe('https://youtu.be/abc')
    expect(findLink('Really?! https://youtu.be/abc?!')).toBe('https://youtu.be/abc')
  })

  it('leaves out brackets that close around the link, but keeps balanced ones inside it', () => {
    expect(findLink('(https://youtu.be/abc)')).toBe('https://youtu.be/abc')
    expect(findLink('[the mix](https://youtu.be/abc).')).toBe('https://youtu.be/abc')
    expect(findLink('https://en.wikipedia.org/wiki/House_(music)')).toBe(
      'https://en.wikipedia.org/wiki/House_(music)',
    )
  })

  it('stops at angle brackets and quotes', () => {
    expect(findLink('<https://youtu.be/abc>')).toBe('https://youtu.be/abc')
    expect(findLink('href="https://youtu.be/abc"')).toBe('https://youtu.be/abc')
  })

  it('stops at smart quotes, guillemets, an ellipsis and CJK punctuation', () => {
    // macOS Notes and Messages type “smart” quotes; percent-encoded, they'd break the link.
    expect(findLink('check “https://soundcloud.com/artist/some-track”')).toBe(
      'https://soundcloud.com/artist/some-track',
    )
    expect(findLink('‘https://youtu.be/XNEnEBrHws8’, so good')).toBe('https://youtu.be/XNEnEBrHws8')
    expect(findLink('«https://youtu.be/XNEnEBrHws8»')).toBe('https://youtu.be/XNEnEBrHws8')
    expect(findLink('try “youtu.be/XNEnEBrHws8”')).toBe('youtu.be/XNEnEBrHws8')
    expect(findLink('https://www.youtube.com/playlist?list=PLabc123…')).toBe(
      'https://www.youtube.com/playlist?list=PLabc123',
    )
    // CJK text needs no space before what follows the link.
    expect(findLink('見て https://youtu.be/XNEnEBrHws8。最高')).toBe('https://youtu.be/XNEnEBrHws8')
    expect(findLink('（https://youtu.be/XNEnEBrHws8）')).toBe('https://youtu.be/XNEnEBrHws8')
    expect(findLink('「https://youtu.be/XNEnEBrHws8」を聴いて')).toBe(
      'https://youtu.be/XNEnEBrHws8',
    )
    expect(findLink('这个https://youtu.be/XNEnEBrHws8，很好！')).toBe(
      'https://youtu.be/XNEnEBrHws8',
    )
  })

  it('keeps letters of any script in a link', () => {
    expect(findLink('https://ja.wikipedia.org/wiki/東京 です')).toBe(
      'https://ja.wikipedia.org/wiki/東京',
    )
    expect(findLink('https://www.youtube.com/results?search_query=café')).toBe(
      'https://www.youtube.com/results?search_query=café',
    )
  })

  it('finds a link the badge then recognizes, inside smart quotes', () => {
    const verdict = urlVerdict(findLink('check “https://soundcloud.com/artist/some-track”') ?? '')
    expect(verdict.status === 'ok' && verdict.label).toBe('Track')
  })

  it('finds a link without a scheme when it has a host and a path', () => {
    expect(findLink('try youtu.be/XNEnEBrHws8 please')).toBe('youtu.be/XNEnEBrHws8')
    expect(findLink('soundcloud.com/excision/robokitty.')).toBe('soundcloud.com/excision/robokitty')
  })

  it('prefers an http(s) link over a scheme-less one', () => {
    expect(findLink('youtu.be/aaa or https://youtu.be/bbb')).toBe('https://youtu.be/bbb')
  })

  it("doesn't take words, e-mail addresses or bare host names for links", () => {
    expect(findLink('hello world')).toBeUndefined()
    expect(findLink('e.g. this one')).toBeUndefined()
    expect(findLink('mail dj@soundcloud.com/x')).toBeUndefined()
    expect(findLink('youtube.com')).toBeUndefined()
    expect(findLink('')).toBeUndefined()
  })

  it('clips a huge link to one character past the longest URL, which stays too long', () => {
    const link = findLink(`https://youtu.be/${'a'.repeat(5000)}`)
    expect(link).toHaveLength(MAX_URL_LENGTH + 1)
  })
})

describe('pasteCandidate', () => {
  it('takes the link when there is one', () => {
    expect(pasteCandidate('new tune: https://youtu.be/abc')).toBe('https://youtu.be/abc')
  })

  it('falls back to the first non-blank line, trimmed, so the box can say why it is no link', () => {
    expect(pasteCandidate('\n\n  spotify:track:4uLU6hMCjMI75M1A2tKUQC  \nmore')).toBe(
      'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    )
    expect(pasteCandidate('Never Gonna Give You Up')).toBe('Never Gonna Give You Up')
  })

  it('has nothing for blank text', () => {
    expect(pasteCandidate('')).toBeUndefined()
    expect(pasteCandidate(' \n\t\r\n ')).toBeUndefined()
  })

  it('clips a huge first line', () => {
    expect(pasteCandidate('x'.repeat(10_000))).toHaveLength(MAX_URL_LENGTH + 1)
  })
})

describe('dropCandidate', () => {
  it('takes the first entry of a URI list, skipping comments and blank lines', () => {
    const data = transfer({
      'text/uri-list': '# dragged from Safari\r\n\r\nhttps://youtu.be/abc\r\nhttps://youtu.be/def',
      'text/plain': 'ignored',
    })
    expect(dropCandidate(data)).toBe('https://youtu.be/abc')
  })

  it('reads plain text like a paste when there is no URI list', () => {
    expect(dropCandidate(transfer({ 'text/plain': 'this one: https://youtu.be/abc!' }))).toBe(
      'https://youtu.be/abc',
    )
    expect(dropCandidate(transfer({ 'text/uri-list': '# only a comment' }))).toBeUndefined()
    expect(dropCandidate(transfer({ 'text/plain': 'just words' }))).toBe('just words')
  })

  it('has nothing when the drop carries no text', () => {
    expect(dropCandidate(transfer({}))).toBeUndefined()
  })
})

describe('dropLink', () => {
  it('takes the URI list, else a link in the text', () => {
    expect(dropLink(transfer({ 'text/uri-list': 'https://youtu.be/abc' }))).toBe(
      'https://youtu.be/abc',
    )
    expect(dropLink(transfer({ 'text/plain': 'Robo Kitty – https://youtu.be/abc' }))).toBe(
      'https://youtu.be/abc',
    )
  })

  it('has nothing for text without a link, unlike dropCandidate', () => {
    expect(dropLink(transfer({ 'text/plain': 'Artist Name' }))).toBeUndefined()
    expect(dropLink(transfer({ 'text/uri-list': '# only a comment' }))).toBeUndefined()
    expect(dropLink(transfer({}))).toBeUndefined()
  })
})

describe('carriesFiles', () => {
  it('spots a drag of files, whatever else it carries', () => {
    expect(carriesFiles(['Files'])).toBe(true)
    expect(carriesFiles(['Files', 'text/uri-list'])).toBe(true)
    expect(carriesFiles(['text/uri-list', 'text/plain'])).toBe(false)
    expect(carriesFiles([])).toBe(false)
  })
})

describe('carriesLink', () => {
  it('accepts a dragged link or text', () => {
    expect(carriesLink(['text/uri-list', 'text/plain', 'text/html'])).toBe(true)
    expect(carriesLink(['text/plain'])).toBe(true)
  })

  it('takes neither files nor other drags for a link', () => {
    expect(carriesLink(['Files'])).toBe(false)
    expect(carriesLink(['Files', 'text/uri-list'])).toBe(false)
    expect(carriesLink(['text/html'])).toBe(false)
    expect(carriesLink([])).toBe(false)
  })
})

describe('isEditableTarget', () => {
  const element = (html: string): Element => {
    const host = document.createElement('div')
    host.innerHTML = html
    const first = host.firstElementChild
    if (first === null) throw new Error('no element')
    return first.querySelector('[data-target]') ?? first
  }

  it('counts text inputs, textareas and rich text', () => {
    expect(isEditableTarget(element('<input>'))).toBe(true)
    expect(isEditableTarget(element('<input type="search">'))).toBe(true)
    expect(isEditableTarget(element('<input type="url">'))).toBe(true)
    expect(isEditableTarget(element('<textarea></textarea>'))).toBe(true)
    expect(
      isEditableTarget(element('<div contenteditable="true"><b data-target>x</b></div>')),
    ).toBe(true)
  })

  it("doesn't count controls without text, read-only or disabled fields, or the page", () => {
    expect(isEditableTarget(element('<input type="checkbox">'))).toBe(false)
    expect(isEditableTarget(element('<input readonly>'))).toBe(false)
    expect(isEditableTarget(element('<textarea disabled></textarea>'))).toBe(false)
    expect(isEditableTarget(element('<button>Go</button>'))).toBe(false)
    expect(isEditableTarget(element('<div contenteditable="false">x</div>'))).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
    expect(isEditableTarget(document)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
