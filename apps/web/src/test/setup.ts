import { cleanup } from '@testing-library/react'
import { beforeEach, expect, vi } from 'vitest'

// Testing Library turns on React's act() environment from a global beforeAll, which it can only
// register when test globals are on; they're off. Without this, React never warns about updates
// outside act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// React reports real bugs only on the console (updates outside act(), missing keys, invalid
// nesting), so any console error or warning fails the test that caused it.
beforeEach(({ onTestFinished }) => {
  const consoleSpies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')]
  // onTestFinished, not afterEach: it runs after every afterEach hook, even when one of a test
  // file's own throws, so a failing test can't leave its tree mounted for the next one.
  onTestFinished(() => {
    // Testing Library unmounts after each test on its own only when test globals are on.
    cleanup()
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls)
    for (const spy of consoleSpies) spy.mockRestore()
    expect(logged, 'console.error or console.warn was called').toEqual([])
  })
})
