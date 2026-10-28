import { cleanup } from '@testing-library/react'
import { beforeEach, expect } from 'vitest'

// Testing Library turns on React's act() environment from a global beforeAll, which it can only
// register when test globals are on; they're off. Without this, React never warns about updates
// outside act().
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom leaves HTMLMediaElement.play/pause/load unimplemented (they log a "not implemented" error
// that would fail the test). A stand-in with the events a real element sends: `play()` dispatches
// "playing", `pause()` dispatches "pause" when it was playing. Tests dispatch the rest themselves.
if (typeof HTMLMediaElement !== 'undefined') {
  const playingElements = new WeakSet<HTMLMediaElement>()
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return !playingElements.has(this)
    },
  })
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    playingElements.add(this)
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    if (!playingElements.delete(this)) return
    this.dispatchEvent(new Event('pause'))
  }
  HTMLMediaElement.prototype.load = function load() {}
}

// React reports real bugs only on the console (updates outside act(), missing keys, invalid
// nesting), so any console error or warning fails the test that caused it.
beforeEach(({ onTestFinished }) => {
  const logged: unknown[][] = []
  const { error, warn } = console
  // Plain wrappers, not vi.spyOn: a test file's vi.restoreAllMocks() (in an afterEach, which runs
  // before cleanup() below) would restore a spy and let warnings from unmount effects through.
  console.error = (...args: unknown[]) => {
    logged.push(args)
    error.apply(console, args)
  }
  console.warn = (...args: unknown[]) => {
    logged.push(args)
    warn.apply(console, args)
  }
  // onTestFinished, not afterEach: it runs after every afterEach hook, even when one of a test
  // file's own throws, so a failing test can't leave its tree mounted for the next one.
  onTestFinished(() => {
    // Testing Library unmounts after each test on its own only when test globals are on.
    cleanup()
    console.error = error
    console.warn = warn
    expect(logged, 'console.error or console.warn was called').toEqual([])
  })
})
