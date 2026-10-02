import type { Health, HealthProblem } from '@dj-scraper/shared'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { PopoverDescription, PopoverHeader, PopoverTitle } from '@/components/ui/popover.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import type { EngineState } from './engine-state.ts'
import { ProblemText } from './problem-text.tsx'
import { LevelIcon } from './status-icon.tsx'
import { ToolList } from './tool-list.tsx'

/** The re-check as the popover needs it: start it, and its pending state or still-relevant error. */
export type Recheck = { run: () => void; pending: boolean; error: Error | null }

type DetailsState = Extract<EngineState, { health: Health }>

const DESCRIPTIONS: Record<DetailsState['kind'], string> = {
  ready: 'yt-dlp, ffmpeg and ffprobe are installed and recent enough.',
  warnings: 'The engine runs, but see the notes below.',
  attention: "Downloads won't work until the problems below are fixed.",
}

/** The popover body once a health check has arrived: tools, problems, and a re-check. */
export function EngineDetails({
  state,
  title,
  recheck,
}: {
  state: DetailsState
  title: string
  recheck: Recheck
}) {
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>{title}</PopoverTitle>
        <PopoverDescription>{DESCRIPTIONS[state.kind]}</PopoverDescription>
      </PopoverHeader>
      <ToolList health={state.health} problems={state.problems} />
      {state.problems.length > 0 && <ProblemList problems={state.problems} />}
      <Separator />
      <CheckFooter checkedAt={state.health.checkedAt} recheck={recheck} />
    </>
  )
}

function ProblemList({ problems }: { problems: HealthProblem[] }) {
  return (
    <ul aria-label="Problems" className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2">
      {problems.map((problem) => (
        <li key={`${problem.tool}:${problem.message}`} className="flex gap-2 text-xs/relaxed">
          <LevelIcon level={problem.severity} className="mt-0.5 shrink-0" />
          <span>
            <span className="sr-only">
              {problem.severity === 'error' ? 'Problem: ' : 'Warning: '}
            </span>
            <ProblemText message={problem.message} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function CheckFooter({ checkedAt, recheck }: { checkedAt: string; recheck: Recheck }) {
  const labelId = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Checked at <time dateTime={checkedAt}>{formatCheckedAt(checkedAt)}</time>
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={recheck.pending}
          // Stays focusable while pending, so focus doesn't fall out of the popover.
          focusableWhenDisabled
          aria-labelledby={labelId}
          onClick={recheck.run}
        >
          {recheck.pending ? (
            <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <RefreshCw aria-hidden />
          )}
          <span id={labelId}>{recheck.pending ? 'Checking…' : 'Check again'}</span>
        </Button>
      </div>
      {recheck.error !== null && (
        <p role="alert" className="text-xs text-destructive">
          Check failed: {recheck.error.message}
        </p>
      )}
    </div>
  )
}

/** Local time, with the date only when it isn't today. */
function formatCheckedAt(iso: string): string {
  const date = new Date(iso)
  const today = date.toDateString() === new Date().toDateString()
  return today
    ? date.toLocaleTimeString()
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
