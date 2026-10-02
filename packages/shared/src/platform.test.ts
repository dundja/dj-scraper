import { describe, expect, expectTypeOf, it } from 'vitest'
import { type Platform, PlatformSchema } from './platform.ts'

describe('PlatformSchema', () => {
  it('rejects an out-of-scope DRM platform', () => {
    expect(PlatformSchema.safeParse('spotify').success).toBe(false)
  })

  it('is exactly the union of the supported platforms', () => {
    expectTypeOf<Platform>().toEqualTypeOf<'youtube' | 'soundcloud' | 'other'>()
  })
})
