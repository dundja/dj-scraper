import { type Health, type HealthProblem, healthProblems } from '@dj-scraper/shared'
import { ApiError } from '@/lib/api.ts'

/** What the header chip shows, derived from the ['health'] query. */
export type EngineState =
  | { kind: 'checking' }
  | { kind: 'offline' }
  | { kind: 'unexpected'; error: Error }
  | {
      /** ready: ok, no problems · warnings: ok, only warnings · attention: not ok */
      kind: 'ready' | 'warnings' | 'attention'
      health: Health
      problems: HealthProblem[]
    }

export type Tone = 'neutral' | 'success' | 'warning' | 'danger'

type HealthQuery = { data: Health | undefined; error: Error | null }

/** The latest outcome wins: a failed refetch shows as offline even while older data is cached. */
export function engineState({ data, error }: HealthQuery): EngineState {
  if (error !== null) {
    return error instanceof ApiError && error.kind === 'unreachable'
      ? { kind: 'offline' }
      : { kind: 'unexpected', error }
  }
  if (data === undefined) return { kind: 'checking' }
  const problems = healthProblems(data)
  const kind = !data.ok ? 'attention' : problems.length > 0 ? 'warnings' : 'ready'
  return { kind, health: data, problems }
}

export type EngineSummary = {
  tone: Tone
  /** Visible on the chip and the popover title. */
  label: string
  /** Secondary chip text, e.g. "2 warnings". */
  detail?: string
}

export function summarize(state: EngineState): EngineSummary {
  switch (state.kind) {
    case 'checking':
      return { tone: 'neutral', label: 'Checking engine' }
    case 'offline':
      return { tone: 'danger', label: 'Server offline' }
    case 'unexpected':
      return { tone: 'danger', label: 'Unexpected response' }
    case 'ready':
      return { tone: 'success', label: 'Engine ready' }
    case 'warnings': {
      const count = state.problems.length
      return {
        tone: 'warning',
        label: 'Engine ready',
        detail: `${count} ${count === 1 ? 'warning' : 'warnings'}`,
      }
    }
    case 'attention':
      return { tone: 'danger', label: 'Engine needs attention' }
  }
}

/** The chip's accessible name and the live announcement, e.g. "Engine status: Engine ready, 1 warning". */
export function statusText({ label, detail }: EngineSummary): string {
  return `Engine status: ${label}${detail === undefined ? '' : `, ${detail}`}`
}
