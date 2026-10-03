import { describe, expect, it, vi } from 'vitest'

describe('the console guard (setup.ts)', () => {
  // A file's afterEach runs before the guard's cleanup(): were the guard a vi.spyOn spy,
  // vi.restoreAllMocks() there would let warnings logged while the tree unmounts go unnoticed.
  it('keeps guarding the console after vi.restoreAllMocks()', () => {
    const guard = { error: console.error, warn: console.warn }

    vi.restoreAllMocks()

    expect(console.error).toBe(guard.error)
    expect(console.warn).toBe(guard.warn)
  })
})
