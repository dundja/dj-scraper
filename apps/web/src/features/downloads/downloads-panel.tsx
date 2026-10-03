import { ArrowDownToLine } from 'lucide-react'
import { useCallback, useMemo, useRef } from 'react'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { describeError } from '@/lib/error-text.ts'
import { BULK_ACTIONS, useBulkAction } from './panel-actions.ts'
import { PanelHeader } from './panel-header.tsx'
import { PanelList } from './panel-list.tsx'
import { PanelError, PanelNotes } from './panel-notes.tsx'
import { groupByBatch, panelRows } from './panel-rows.ts'
import { combineSummaries } from './summary.ts'
import { useDownloads } from './use-downloads.ts'
import { useRunningSummary } from './use-running-summary.ts'

/**
 * The right column (an `<aside aria-label="Downloads">` in the shell): batches and their jobs, with
 * overall progress and bulk actions. Everything comes from `['downloads']`, which only the event
 * stream writes; the bulk actions' answers are counts, and their changes arrive as events.
 */
export function DownloadsPanel() {
  const { data } = useDownloads()
  const bulk = useBulkAction()
  const order = data?.order
  const byId = data?.byId
  const batches = data?.batches
  // Queue and connection updates leave these alone, so they don't regroup the jobs.
  const groups = useMemo(
    () =>
      order === undefined || byId === undefined || batches === undefined
        ? []
        : groupByBatch({ order, byId, batches }),
    [order, byId, batches],
  )
  const rows = useMemo(() => panelRows(groups), [groups])
  const all = useMemo(() => combineSummaries(groups.map((group) => group.summary)), [groups])
  const running = useRunningSummary(groups)
  const heading = useRef<HTMLHeadingElement>(null)
  const allMenu = useRef<HTMLButtonElement>(null)
  // "Clear finished" over finished jobs only removes the menu it was chosen from: the focus goes
  // to the header's menu while other jobs stay, else to the heading.
  const totalJobs = all.total
  const focusAfterClear = useCallback(
    (cleared: number) => (totalJobs > cleared ? allMenu.current : heading.current),
    [totalJobs],
  )

  // Before the first snapshot there is nothing to show yet (unless the stream is already down).
  if (data === undefined || (data.serverId === undefined && data.connection === 'connecting')) {
    return <PanelSkeleton />
  }

  const failure = bulk.isError ? describeError(bulk.error) : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        all={all}
        running={running}
        onAction={bulk.mutate}
        focusAfterClear={focusAfterClear}
        headingRef={heading}
        menuRef={allMenu}
      />
      <PanelNotes connection={data.connection} queue={data.queue} />
      {failure !== undefined && bulk.variables !== undefined && (
        <PanelError
          error={{
            ...failure,
            message: `${BULK_ACTIONS[bulk.variables.action].failed} ${failure.message}`,
          }}
          onDismiss={bulk.reset}
          fallbackFocus={heading}
        />
      )}
      {rows.length > 0 ? (
        <PanelList rows={rows} onAction={bulk.mutate} focusAfterClear={focusAfterClear} />
      ) : (
        data.serverId !== undefined && <PanelEmpty />
      )}
    </div>
  )
}

function PanelEmpty() {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ArrowDownToLine aria-hidden />
        </EmptyMedia>
        <EmptyTitle>Nothing downloading yet</EmptyTitle>
        <EmptyDescription>Paste a link to start.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Before the first snapshot: the panel's shape, so nothing jumps when the jobs arrive. */
function PanelSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col">
      <div className="flex flex-col gap-1.5 border-b px-4 pt-2 pb-3">
        <h2 className="flex h-7 items-center text-sm font-medium">Downloads</h2>
        <Skeleton className="h-4 w-40" />
      </div>
      <p role="status" className="sr-only">
        Loading downloads…
      </p>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 shrink-0" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
