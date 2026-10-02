import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as z from 'zod'
import { HttpUrlSchema } from './url.ts'

describe('HttpUrlSchema', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&index=2',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    'https://soundcloud.com/some-artist/deep-house-edit',
    'https://soundcloud.com/some-artist/sets/summer-2026',
    'https://soundcloud.com/some-artist/unreleased-dub/s-AbCdEfGhIjK',
    'https://on.soundcloud.com/AbCdEfGhIjKlMnOp',
    'https://i1.sndcdn.com/artworks-000123456789-abcdef-t500x500.jpg',
  ])('accepts %s unchanged', (url) => {
    expect(HttpUrlSchema.parse(url)).toBe(url)
  })

  // This is why the schema is z.url({ protocol }) and not z.httpUrl(), which demands a domain.
  it.each(['http://localhost:4747/api/health', 'http://127.0.0.1:4747/api/health'])(
    'accepts plain http to a host without a domain: %s',
    (url) => {
      expect(HttpUrlSchema.parse(url)).toBe(url)
    },
  )

  it('trims whitespace around a pasted URL', () => {
    expect(HttpUrlSchema.parse('  https://youtu.be/dQw4w9WgXcQ\n')).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    )
  })

  it.each([
    ['a javascript: URL', 'javascript:alert(document.cookie)'],
    ['a mixed-case javascript: URL', 'JavaScript:alert(1)'],
    ['a javascript: URL behind whitespace', '  javascript:alert(1)'],
    ['a file: URL', 'file:///Users/dj/Music/track.mp3'],
    ['an ftp: URL', 'ftp://ftp.example.com/track.mp3'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a websocket URL', 'wss://example.com/socket'],
    ['a mailto: URL', 'mailto:dj@example.com'],
    ['a root-relative path', '/watch?v=dQw4w9WgXcQ'],
    ['a relative path', 'watch?v=dQw4w9WgXcQ'],
    ['a protocol-relative URL', '//www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a host without a scheme', 'www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a scheme without a host', 'https://'],
    ['a scheme without slashes', 'http:example.com'],
    ['a scheme with one slash', 'https:/www.youtube.com/watch'],
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(HttpUrlSchema.safeParse(value).success).toBe(false)
  })

  it('infers a plain string', () => {
    expectTypeOf<z.output<typeof HttpUrlSchema>>().toEqualTypeOf<string>()
    expectTypeOf<z.input<typeof HttpUrlSchema>>().toEqualTypeOf<string>()
  })
})
