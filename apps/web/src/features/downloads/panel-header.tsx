import type { Ref } from 'react'
import { Progress } from '@/components/ui/progress.tsx'
import { useThrottledValue } from '@/lib/use-throttled-value.ts'
import type { BulkRequest } from './panel-actions.ts'
import { BulkMenu } from './panel-menu.tsx'
import { countsText } from './panel-text.ts'
import { type JobsSummary, percentDone } from './summary.ts'

/**
 * The counts are spoken at most this often: a burst of finished downloads (YouTube starts ten at
 * once) is one announcement, and the latest count always follows within this time.
 */
const COUNTS_ANNOUNCE_MS = 3000

type Props = {
  /** Every job in the panel: the counts and the bulk menu. */
  all: JobsSummary
  /**
   * The jobs of the batches at work since the panel was last idle (`useRunningSummary`): the
   * overall progress bar, none when all is finished.
   */
  running: JobsSummary
  onAction: (request: BulkRequest) => void
  focusAfterClear: (cleared: number) => HTMLElement | null
  /** The heading: it takes the focus when the control that had it goes (see `focusAfterClear`). */
  headingRef: Ref<HTMLHeadingElement>
  /** The "Actions for all downloads" trigger, there while the panel has jobs. */
  menuRef: Ref<HTMLButtonElement>
}

/** "Downloads" with the counts, the overall progress and the bulk actions over every job. */
export function PanelHeader({
  all,
  running,
  onAction,
  focusAfterClear,
  headingRef,
  menuRef,
}: Props) {
  const percent = percentDone(running)
  const working = running.active > 0
  const counts = countsText(all.counts)
  const announced = useThrottledValue(counts, COUNTS_ANNOUNCE_MS)
  return (
    <div
      data-slot="downloads-header"
      className="flex shrink-0 flex-col gap-1.5 border-b px-4 pt-2 pb-3"
    >
      <div className="flex h-7 items-center gap-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Downloads
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {working && (
            <span aria-hidden className="text-xs text-muted-foreground tabular-nums">
              {percent} %
            </span>
          )}
          {all.total > 0 && (
            <BulkMenu
              label="Actions for all downloads"
              target={{ scope: 'all' }}
              summary={all}
              onAction={onAction}
              focusAfterClear={focusAfterClear}
              triggerRef={menuRef}
            />
          )}
        </div>
      </div>
      {/* The counts change as each job finishes: shown at once, spoken at most every few
          seconds (the live region below). The bar's percent is there to read, not announced. */}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground tabular-nums">
        {counts}
      </p>
      <p role="status" className="sr-only">
        {announced}
      </p>
      {working && (
        <Progress
          value={percent}
          aria-label="Overall progress"
          getAriaValueText={(formatted) =>
            `${formatted} done, ${running.active.toLocaleString('en-US')} left`
          }
          className="gap-0"
        />
      )}
    </div>
  )
}
