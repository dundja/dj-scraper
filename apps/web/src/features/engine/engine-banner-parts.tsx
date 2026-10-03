import type { HealthProblem } from '@dj-scraper/shared'
import { LoaderCircle, type LucideIcon, RefreshCw, X } from 'lucide-react'
import { type ReactNode, useId, useRef, useState } from 'react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { focusNextAfter } from '@/lib/focus.ts'
import { cn } from '@/lib/utils.ts'
import type { Recheck } from './engine-details.tsx'
import { ProblemText } from './problem-text.tsx'
import { LevelIcon } from './status-icon.tsx'

type FrameProps = {
  tone: 'danger' | 'warning'
  icon: LucideIcon
  title: string
  children: ReactNode
  /** Shows a close button: the banner goes away for the session. */
  onDismiss?: () => void
}

/**
 * A full-width strip under the header. Problems interrupt (role alert); warnings don't (status):
 * the header chip announces every engine status politely anyway. Dismissing it moves the focus
 * on to what follows (the link box), instead of losing it with the banner.
 */
export function BannerFrame({ tone, icon: Icon, title, children, onDismiss }: FrameProps) {
  const titleId = useId()
  const frame = useRef<HTMLDivElement>(null)
  return (
    <Alert
      ref={frame}
      variant={tone === 'danger' ? 'destructive' : 'default'}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-labelledby={titleId}
      className={cn(
        'shrink-0 rounded-none border-x-0 border-t-0 px-4 py-2.5',
        tone === 'danger' ? 'bg-destructive/10' : 'bg-warning/10 *:[svg]:text-warning',
      )}
    >
      <Icon aria-hidden />
      <AlertTitle id={titleId}>{title}</AlertTitle>
      {/* The gap spaces the parts; the Alert's own margin under paragraphs would double it. */}
      <AlertDescription className="flex flex-col gap-2 [&_p:not(:last-child)]:mb-0">
        {children}
      </AlertDescription>
      {onDismiss !== undefined && (
        <AlertAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss for this session"
            onClick={() => {
              focusNextAfter(frame.current)
              onDismiss()
            }}
          >
            <X aria-hidden />
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

/** The engine's problems in the server's words, their commands as code. */
export function ProblemList({ problems }: { problems: readonly HealthProblem[] }) {
  return (
    <ul aria-label="Problems" className="flex flex-col gap-1">
      {problems.map((problem) => (
        <li key={`${problem.tool}:${problem.message}`} className="flex gap-2">
          <LevelIcon level={problem.severity} className="mt-0.75 shrink-0" />
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

/** A row of the banner's actions and notes. */
export function BannerActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
}

/**
 * "Check again" (POST /api/health/recheck) after installing or updating a tool, with when the shown
 * check ran, so a re-check that finds the same problems visibly happened.
 */
export function CheckAgain({ recheck, checkedAt }: { recheck: Recheck; checkedAt: string }) {
  return (
    <BannerActions>
      <Button
        variant="outline"
        size="xs"
        disabled={recheck.pending}
        focusableWhenDisabled
        onClick={recheck.run}
      >
        <SpinOrRefresh spinning={recheck.pending} />
        {recheck.pending ? 'Checking…' : 'Check again'}
      </Button>
      <span className="text-xs text-muted-foreground">
        Last checked <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleTimeString()}</time>
      </span>
      {recheck.error !== null && (
        <span role="alert" className="text-xs text-destructive">
          Check failed: {recheck.error.message}
        </span>
      )}
    </BannerActions>
  )
}

/**
 * Asks the server for the engine status now instead of at the next automatic retry; `onRetry`
 * settles once that attempt is over.
 */
export function TryNow({ note, onRetry }: { note: string; onRetry: () => Promise<unknown> }) {
  const [pending, setPending] = useState(false)
  const retry = () => {
    setPending(true)
    void onRetry().finally(() => setPending(false))
  }
  return (
    <BannerActions>
      <Button variant="outline" size="xs" disabled={pending} focusableWhenDisabled onClick={retry}>
        <SpinOrRefresh spinning={pending} />
        {pending ? 'Trying…' : 'Try now'}
      </Button>
      <span className="text-xs text-muted-foreground">{note}</span>
    </BannerActions>
  )
}

function SpinOrRefresh({ spinning }: { spinning: boolean }) {
  return spinning ? (
    <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
  ) : (
    <RefreshCw aria-hidden />
  )
}
