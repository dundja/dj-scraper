import type { Job } from '@dj-scraper/shared'
import { FolderSearch, LoaderCircle, type LucideIcon, RotateCw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import {
  actionName,
  canRun,
  type JobAction,
  type JobActionControl,
  jobAction,
} from './job-actions.ts'

const ACTION_ICONS: Record<JobAction, LucideIcon> = {
  cancel: X,
  retry: RotateCw,
  reveal: FolderSearch,
}

type JobActionButtonProps = {
  job: Job
  control: JobActionControl
  /**
   * A list row's icon button with a tooltip, its name including the title ("Cancel <title>").
   * Without it, a small button with its name as text, for the track card.
   */
  iconFor?: string
  /** The ids of what describes the action (a failure's message and next step), for assistive tech. */
  describedBy?: string
  /** With `iconFor`: more for the tooltip under the action's name, e.g. that failure in words. */
  details?: ReactNode
}

/**
 * The job's one action (see `jobAction`): Cancel, Retry or Reveal in Finder. It stays focusable
 * while busy (a request in flight, or a cancel underway), so keyboard focus survives the switch
 * from Cancel to Retry. Renders nothing when the job offers no action.
 */
export function JobActionButton({
  job,
  control,
  iconFor,
  describedBy,
  details,
}: JobActionButtonProps) {
  const action = jobAction(job)
  if (action === undefined) return null
  const busy = control.pending !== undefined || !canRun(job, action)
  const Icon = busy ? LoaderCircle : ACTION_ICONS[action]
  const icon = <Icon aria-hidden className={cn(busy && 'motion-safe:animate-spin')} />
  const shared = {
    disabled: busy,
    focusableWhenDisabled: true,
    onClick: () => control.run(action),
    className: 'aria-disabled:opacity-70',
    'aria-describedby': describedBy,
  }

  if (iconFor === undefined) {
    return (
      <Button variant="outline" size="sm" {...shared}>
        {icon}
        {actionName(job, action)}
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={actionName(job, action, iconFor)}
            {...shared}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      {/* Visual only (Base UI wires no aria-describedby): `describedBy` says the same. */}
      <TooltipContent className={cn(details !== undefined && 'flex-col items-start gap-0.5')}>
        <span>{actionName(job, action)}</span>
        {details}
      </TooltipContent>
    </Tooltip>
  )
}
