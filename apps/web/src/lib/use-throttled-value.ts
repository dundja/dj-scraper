import { useEffect, useRef, useState } from 'react'

/**
 * `value`, changing at most once per `intervalMs`: the first change after a quiet spell shows at
 * once, and the changes within the interval after it merge into one at its end (the latest value
 * wins). For a live region that would otherwise speak on every event, e.g. each finished download
 * of a burst. The first render shows `value` as it is.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value)
  // When `shown` last changed (ms since the epoch); never, until it does.
  const lastChange = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    if (Object.is(value, shown)) return
    const show = () => {
      lastChange.current = Date.now()
      setShown(value)
    }
    const wait = lastChange.current + intervalMs - Date.now()
    if (wait <= 0) {
      show()
      return
    }
    // A newer value replaces this timer; the interval still ends when it would have.
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [value, shown, intervalMs])

  return shown
}
