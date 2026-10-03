import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledValue } from './use-throttled-value.ts'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function renderThrottled(initial: string, intervalMs = 3000) {
  return renderHook(({ value }) => useThrottledValue(value, intervalMs), {
    initialProps: { value: initial },
  })
}

describe('useThrottledValue', () => {
  it('starts with the value, and shows the first change at once', () => {
    const { result, rerender } = renderThrottled('1 left')
    expect(result.current).toBe('1 left')

    rerender({ value: '1 done' })
    expect(result.current).toBe('1 done')
  })

  it('merges the changes within the interval into one at its end, the latest winning', async () => {
    const { result, rerender } = renderThrottled('3 left')
    rerender({ value: '1 done · 2 left' })
    expect(result.current).toBe('1 done · 2 left')

    await act(() => vi.advanceTimersByTimeAsync(1000))
    rerender({ value: '2 done · 1 left' })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    rerender({ value: '3 done' })
    expect(result.current).toBe('1 done · 2 left')

    // The interval started with the first change: it ends 3 s after it, not after the last one.
    await act(() => vi.advanceTimersByTimeAsync(999))
    expect(result.current).toBe('1 done · 2 left')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(result.current).toBe('3 done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows a change at once again after a quiet interval', async () => {
    const { result, rerender } = renderThrottled('a')
    rerender({ value: 'b' })
    await act(() => vi.advanceTimersByTimeAsync(3000))

    rerender({ value: 'c' })
    expect(result.current).toBe('c')
  })

  it('leaves no timer behind when unmounted mid-interval', async () => {
    const { rerender, unmount } = renderThrottled('a')
    rerender({ value: 'b' })
    rerender({ value: 'c' })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
