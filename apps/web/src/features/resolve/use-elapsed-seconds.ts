import { useEffect, useState } from 'react'

/** Whole seconds since `since` (ms since the epoch), ticking once a second while mounted. */
export function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.floor((now - since) / 1000))
}
