import { describe, expect, expectTypeOf, it } from 'vitest'
import { type Platform, PlatformSchema, pacingPlatform } from './platform.ts'

describe('PlatformSchema', () => {
  it('rejects a DRM platform whose links are refused', () => {
    expect(PlatformSchema.safeParse('tidal').success).toBe(false)
  })

  it('is exactly the union of the supported platforms', () => {
    expectTypeOf<Platform>().toEqualTypeOf<'youtube' | 'soundcloud' | 'spotify' | 'other'>()
  })
})

describe('pacingPlatform', () => {
  it.each([
    ['spotify', 'youtube'],
    ['youtube', 'youtube'],
    ['soundcloud', 'soundcloud'],
    ['other', 'other'],
  ] as const)('paces %s downloads as %s', (platform, paced) => {
    expect(pacingPlatform(platform)).toBe(paced)
  })
})
