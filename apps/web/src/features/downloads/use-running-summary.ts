import { useMemo, useState } from 'react'
import type { BatchGroup } from './panel-rows.ts'
import { combineSummaries, type JobsSummary } from './summary.ts'

const NO_BATCHES: ReadonlySet<string> = new Set()

/**
 * The batches the overall progress measures, after `groups` changed: every batch at work since
 * the panel was last idle. A batch joins when it has work and stays when it finishes, so the bar
 * only moves forward while work gets done (a new batch moves it back, being more to do). Once
 * nothing is at work the set empties, so the history before a new batch stays out of its bar.
 * Returns `session` itself when nothing changed.
 */
export function batchesAtWork(
  session: ReadonlySet<string>,
  groups: readonly BatchGroup[],
): ReadonlySet<string> {
  const working = groups.filter((group) => group.summary.active > 0)
  if (working.length === 0) return session.size === 0 ? session : NO_BATCHES
  if (working.every((group) => session.has(group.batch.id))) return session
  const next = new Set(session)
  for (const group of working) next.add(group.batch.id)
  return next
}

/** The summary of the jobs the overall progress bar measures: see `batchesAtWork`. */
export function useRunningSummary(groups: readonly BatchGroup[]): JobsSummary {
  const [session, setSession] = useState(NO_BATCHES)
  // Derived from the previous render's set (React's "storing information from previous renders").
  const next = batchesAtWork(session, groups)
  if (next !== session) setSession(next)
  return useMemo(
    () =>
      combineSummaries(
        groups.filter((group) => next.has(group.batch.id)).map((group) => group.summary),
      ),
    [groups, next],
  )
}
