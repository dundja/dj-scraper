import type { Job } from '@dj-scraper/shared'
import { useId } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { cn } from '@/lib/utils.ts'
import { JobActionButton } from './job-action-button.tsx'
import { useJobAction } from './job-actions.ts'
import { useNow } from './job-clock.ts'
import { JOB_ROW_HEIGHT } from './job-layout.ts'
import { JobStatusIcon } from './job-status-icon.tsx'
import {
  type JobPhase,
  jobArtist,
  jobErrorHint,
  jobPhase,
  jobTitle,
  statusLabel,
  statusText,
  waitingUntil,
} from './job-text.ts'

/** Phases whose status line doesn't name them (numbers, the output, an error): say it first. */
const UNNAMED_PHASES: ReadonlySet<JobPhase> = new Set(['downloading', 'done', 'failed'])

/**
 * One job in the downloads panel's virtualized list, exactly `JOB_ROW_HEIGHT` tall: artwork, title
 * and artist, one status line (with a thin progress bar while downloading), and the job's action
 * as an icon button. Not a live region: the panel announces the overall progress. A failure's
 * full message and next step don't fit the line: they describe the action button and show in its
 * tooltip, and an action that fails is announced once (`role="alert"`).
 */
export function JobRow({ job }: { job: Job }) {
  const now = useNow(waitingUntil(job))
  const control = useJobAction(job.id, job)
  const lineId = useId()
  const hintId = useId()
  const phase = jobPhase(job, now)
  const title = jobTitle(job)
  const artist = jobArtist(job)
  const line = control.error?.message ?? statusText(job, now)
  const hint =
    control.error?.hint ?? (job.status === 'failed' ? jobErrorHint(job.error.code) : undefined)
  // Plain text for the hover title and screen readers: the commands without their backticks.
  const plainHint = hint?.replaceAll('`', '')
  const hover = plainHint === undefined ? line : `${line}\n${plainHint}`
  const failure = control.error !== undefined || phase === 'failed'
  const percent =
    job.status === 'downloading' && phase === 'downloading' ? job.progress?.percent : undefined
  const tone = failure
    ? 'text-destructive'
    : phase === 'requeued'
      ? 'text-warning'
      : 'text-muted-foreground'

  return (
    <div
      data-slot="job-row"
      data-status={job.status}
      className="flex items-center gap-3 px-3"
      style={{ height: JOB_ROW_HEIGHT }}
    >
      <Artwork src={job.track.thumbnailUrl} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className="truncate text-sm leading-5"
          title={artist === undefined ? title : `${title} · ${artist}`}
        >
          <span className="font-medium">{title}</span>
          {artist !== undefined && <span className="text-muted-foreground"> · {artist}</span>}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
          <JobStatusIcon phase={phase} className="size-3.5" />
          {percent !== undefined && (
            <Progress
              value={percent}
              aria-label={`${title}: downloaded`}
              className="w-14 shrink-0 gap-0"
            />
          )}
          <p id={lineId} className={cn('min-w-0 truncate tabular-nums', tone)} title={hover}>
            {UNNAMED_PHASES.has(phase) && (
              <span className="sr-only">{statusLabel(job, now)}: </span>
            )}
            {line}
          </p>
        </div>
        {plainHint !== undefined && (
          <span id={hintId} className="sr-only">
            {plainHint}
          </span>
        )}
        {control.error !== undefined && (
          <span role="alert" className="sr-only">
            {`${title}: ${control.error.message}`}
            {plainHint !== undefined && ` ${plainHint}`}
          </span>
        )}
      </div>
      <JobActionButton
        job={job}
        control={control}
        iconFor={title}
        describedBy={
          failure ? (plainHint === undefined ? lineId : `${lineId} ${hintId}`) : undefined
        }
        details={
          failure ? (
            <>
              <span>{line}</span>
              {hint !== undefined && (
                <span className="opacity-80">
                  <ProblemText message={hint} />
                </span>
              )}
            </>
          ) : undefined
        }
      />
    </div>
  )
}
