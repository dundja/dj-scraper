import { CircleCheck, CircleX } from 'lucide-react'
import { useJob } from '@/features/downloads/use-downloads.ts'
import { cn } from '@/lib/utils.ts'
import { type JobChip, jobChip } from './job-chip.ts'

const TONES: Record<JobChip['tone'], string> = {
  muted: 'text-muted-foreground',
  active: 'text-foreground',
  success: 'text-success',
  error: 'text-destructive',
}

/** A row's download status in a word ("Done", "42 %"), with the details in its tooltip. */
export function JobStatus({ chip }: { chip: JobChip }) {
  return (
    <span
      className={cn('flex items-center gap-1 truncate text-xs tabular-nums', TONES[chip.tone])}
      title={chip.detail}
    >
      {chip.tone === 'success' && <CircleCheck aria-hidden className="size-3.5 shrink-0" />}
      {chip.tone === 'error' && <CircleX aria-hidden className="size-3.5 shrink-0" />}
      <span className="sr-only">Download: </span>
      <span className="truncate">{chip.label}</span>
    </span>
  )
}

/**
 * A row's download status, read by job id: a job's progress re-renders this chip alone, not its
 * row or the table. Nothing until the job is in `['downloads']`.
 */
export function TrackJobStatus({ jobId }: { jobId: string }) {
  const job = useJob(jobId)
  return job === undefined ? null : <JobStatus chip={jobChip(job)} />
}
