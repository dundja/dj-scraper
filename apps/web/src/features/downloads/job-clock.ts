import { useEffect, useState } from 'react'

/** setTimeout's longest delay; a later instant is reached in steps. */
const MAX_DELAY_MS = 2 ** 31 - 1

/**
 * The time (ms) for a render that shows something until `until`, an ISO instant such as a job's
 * `waitingUntil`, plus one re-render once that instant has passed: "Waiting until 09:05" turns into
 * "Starting…" on time, without a ticking clock. Without `until` nothing is scheduled.
 */
export function useNow(until: string | undefined): number {
  const [now, setNow] = useState(Date.now)
  const target = until === undefined ? Number.NaN : Date.parse(until)

  useEffect(() => {
    // Nothing to wait for: no instant, or this render already counts it as passed.
    if (!(target > now)) return
    const delay = Math.min(Math.max(0, target - Date.now()), MAX_DELAY_MS)
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [target, now])

  return now
}
