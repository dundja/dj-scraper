import { Download } from 'lucide-react'
import { useState } from 'react'
import { FolderPath } from '@/components/folder-path.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { ProblemText } from '@/features/engine/problem-text.tsx'
import { cn } from '@/lib/utils.ts'
import { JobActionButton } from './job-action-button.tsx'
import { jobAction, useJobAction } from './job-actions.ts'
import { useNow } from './job-clock.ts'
import { JobStatusIcon } from './job-status-icon.tsx'
import {
  jobErrorHint,
  jobPhase,
  progressText,
  statusDetail,
  statusLabel,
  waitingUntil,
} from './job-text.ts'
import { platformQueueNote } from './panel-text.ts'
import { useJob, useQueue } from './use-downloads.ts'

type JobInlineProps = {
  jobId: string
  /**
   * Offered when retrying can't help: the job failed for good, or it left the downloads list
   * (cleared, or the server restarted). Also beside Retry when the job's folder is gone: Retry
   * keeps that folder, a new download takes the one in the header. Without it, no "Download
   * again" button.
   */
  onDownloadAgain?: () => void
}

/**
 * A job's live status and its action, for the track card: "Queued…" until the event stream brings
 * the job, then its status (announced politely) and why it waits while queued (a paused or paced
 * platform), progress bar and numbers while downloading, what the file is once done, and the error
 * with a next step once failed.
 */
export function JobInline({ jobId, onDownloadAgain }: JobInlineProps) {
  const job = useJob(jobId)
  // Once the job has arrived, its absence means it was removed, not that it's still coming.
  const [seen, setSeen] = useState(false)
  if (job !== undefined && !seen) setSeen(true)
  const now = useNow(job === undefined ? undefined : waitingUntil(job))
  const control = useJobAction(jobId, job)
  const queue = useQueue()

  const gone = job === undefined && seen
  const phase = job === undefined ? (gone ? 'gone' : 'queued') : jobPhase(job, now)
  const label =
    job !== undefined ? statusLabel(job, now) : gone ? 'No longer in the downloads list' : 'Queued…'
  const detail = job === undefined ? undefined : statusDetail(job)
  const progress =
    job?.status === 'downloading' && phase === 'downloading' ? job.progress : undefined
  // Why a queued job waits: its platform is paused or paced (the downloads panel says the same).
  const queueNote =
    (phase === 'queued' || phase === 'requeued') && job !== undefined
      ? platformQueueNote(queue, job.track.platform)
      : undefined
  const downloadAgain =
    onDownloadAgain !== undefined &&
    (job === undefined
      ? gone
      : job.status === 'failed' &&
        (jobAction(job) === undefined || job.error.code === 'folder_unavailable'))
  const hint = job?.status === 'failed' ? jobErrorHint(job.error.code, downloadAgain) : undefined

  return (
    <div data-slot="job-inline" data-status={job?.status} className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <JobStatusIcon phase={phase} className="mt-0.5 size-4" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The status and the words that change with it, read out together; the progress
              numbers stay outside, or they would be read out twice a second. */}
          <div role="status" className="flex flex-col gap-0.5">
            <p
              className={cn(
                'text-sm font-medium',
                phase === 'failed' && 'text-destructive',
                phase === 'requeued' && 'text-warning',
              )}
            >
              {label}
            </p>
            {detail !== undefined && (
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>
            )}
          </div>
          {progress !== undefined && (
            <p className="text-sm text-muted-foreground tabular-nums">{progressText(progress)}</p>
          )}
          {/* Outside the live region: a paced platform's next start moves every few seconds. */}
          {queueNote !== undefined && (
            <p
              data-slot="queue-note"
              className={cn(
                'text-xs',
                queueNote.kind === 'paused' ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              {queueNote.text}
            </p>
          )}
          {job?.status === 'done' && (
            <p className="flex min-w-0 text-xs text-muted-foreground">
              <span className="shrink-0 whitespace-pre">In </span>
              <FolderPath path={job.folder} />
            </p>
          )}
          {hint !== undefined && (
            <p className="text-xs text-muted-foreground">
              <ProblemText message={hint} />
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {job !== undefined && <JobActionButton job={job} control={control} />}
          {downloadAgain && (
            <Button variant="outline" size="sm" onClick={onDownloadAgain}>
              <Download aria-hidden />
              Download again
            </Button>
          )}
        </div>
      </div>
      {progress !== undefined && (
        <Progress
          value={progress.percent ?? null}
          aria-label="Download progress"
          className="gap-0"
        />
      )}
      {control.error !== undefined && (
        <div role="alert" className="text-sm">
          <p className="text-destructive">{control.error.message}</p>
          {control.error.hint !== undefined && (
            <p className="text-xs text-muted-foreground">
              <ProblemText message={control.error.hint} />
            </p>
          )}
        </div>
      )}
    </div>
  )
}
