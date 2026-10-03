import {
  ArrowDownToLine,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  FileCheck,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import type { JobPhase } from './job-text.ts'

/** `gone`: a job the track card started that is no longer listed (cleared, or a server restart). */
export type JobIconPhase = JobPhase | 'gone'

type PhaseIcon = { icon: LucideIcon; tone: string; spin?: true }

// Every use pairs the icon with status text: the shape and color only help scanning.
const PHASE_ICONS: Record<JobIconPhase, PhaseIcon> = {
  queued: { icon: Clock, tone: 'text-muted-foreground' },
  requeued: { icon: Hourglass, tone: 'text-warning' },
  waiting: { icon: Hourglass, tone: 'text-muted-foreground' },
  starting: { icon: LoaderCircle, tone: 'text-muted-foreground', spin: true },
  downloading: { icon: ArrowDownToLine, tone: 'text-foreground' },
  processing: { icon: LoaderCircle, tone: 'text-foreground', spin: true },
  canceling: { icon: LoaderCircle, tone: 'text-muted-foreground', spin: true },
  done: { icon: CircleCheck, tone: 'text-success' },
  skipped: { icon: FileCheck, tone: 'text-muted-foreground' },
  failed: { icon: CircleAlert, tone: 'text-destructive' },
  canceled: { icon: Ban, tone: 'text-muted-foreground' },
  gone: { icon: CircleDashed, tone: 'text-muted-foreground' },
}

/** A job's phase as a small decorative icon; spinners stop for people who ask for less motion. */
export function JobStatusIcon({ phase, className }: { phase: JobIconPhase; className?: string }) {
  const { icon: Icon, tone, spin } = PHASE_ICONS[phase]
  return (
    <Icon
      aria-hidden
      data-phase={phase}
      className={cn('shrink-0', tone, spin && 'motion-safe:animate-spin', className)}
    />
  )
}
