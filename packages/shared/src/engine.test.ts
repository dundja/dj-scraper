import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import { DENO_MIN_VERSION, NODE_MIN_VERSION, YTDLP_MIN_RELEASE } from './engine.ts'

describe('engine minimums', () => {
  it('keeps YTDLP_MIN_RELEASE a zero-padded ISO day, so it compares with releaseDate as a string', () => {
    expect(z.iso.date().parse(YTDLP_MIN_RELEASE)).toBe(YTDLP_MIN_RELEASE)
  })

  it('gives the JS runtime minimums as fixed [major, minor, patch] tuples', () => {
    expectTypeOf(DENO_MIN_VERSION).toEqualTypeOf<readonly [2, 3, 0]>()
    expectTypeOf(NODE_MIN_VERSION).toEqualTypeOf<readonly [22, 0, 0]>()
  })
})
