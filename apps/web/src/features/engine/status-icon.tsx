import {
  Check,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  type LucideIcon,
  ServerCrash,
  ServerOff,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import type { EngineState, Tone } from './engine-state.ts'

/** Status colors read well on dark; every use pairs them with an icon shape and text. */
const toneText: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
}

const STATE_ICONS: Record<EngineState['kind'], LucideIcon> = {
  checking: LoaderCircle,
  offline: ServerOff,
  unexpected: ServerCrash,
  ready: CircleCheck,
  warnings: TriangleAlert,
  attention: CircleAlert,
}

type StateIconProps = { kind: EngineState['kind']; tone: Tone; className?: string }

export function EngineStateIcon({ kind, tone, className }: StateIconProps) {
  const Icon = STATE_ICONS[kind]
  return (
    <Icon
      aria-hidden
      className={cn(toneText[tone], kind === 'checking' && 'motion-safe:animate-spin', className)}
    />
  )
}

/** A tool's or a problem's level, shown in the popover. */
export type Level = 'ok' | 'warning' | 'error'

const LEVEL_ICONS: Record<Level, LucideIcon> = { ok: Check, warning: TriangleAlert, error: X }
const LEVEL_TONES: Record<Level, Tone> = { ok: 'success', warning: 'warning', error: 'danger' }

export function LevelIcon({ level, className }: { level: Level; className?: string }) {
  const Icon = LEVEL_ICONS[level]
  return <Icon aria-hidden className={cn('size-3.5', toneText[LEVEL_TONES[level]], className)} />
}
