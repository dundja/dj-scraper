import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useRef } from 'react'
import { JOB_ROW_HEIGHT } from './job-layout.ts'
import { JobRow } from './job-row.tsx'
import type { BulkRequest } from './panel-actions.ts'
import { BatchRow } from './panel-batch-row.tsx'
import { BATCH_ROW_HEIGHT, type PanelRow } from './panel-rows.ts'

/** Rows rendered beyond each edge of the visible ones, so a quick scroll doesn't show gaps. */
const OVERSCAN = 8

// The stream keeps an unchanged job's identity, so a progress event re-renders only its own row.
const MemoJobRow = memo(JobRow)

type Props = {
  rows: readonly PanelRow[]
  onAction: (request: BulkRequest) => void
  focusAfterClear: (cleared: number) => HTMLElement | null
}

/**
 * Every batch header and job as one virtualized list: only the rows in view (plus OVERSCAN) are
 * in the DOM, so 5,000 jobs scroll as smoothly as 5. Rows have fixed heights, so nothing is
 * measured. Fills the column on lg+; below lg it grows with its rows up to 60 % of the screen.
 * Each row says where it sits in the whole list (aria-posinset/-setsize), and Tab walks the rows'
 * buttons: the browser scrolls the focused one into view, which renders the rows after it.
 */
export function PanelList({ rows, onAction, focusAfterClear }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  // New callbacks for new rows: the virtualizer recomputes its row positions when they change.
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
  const estimateSize = useCallback(
    (index: number) => (rows[index]?.kind === 'batch' ? BATCH_ROW_HEIGHT : JOB_ROW_HEIGHT),
    [rows],
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
  })

  return (
    <div
      ref={scrollerRef}
      data-slot="downloads-list"
      className="max-h-[60svh] overflow-y-auto overscroll-contain lg:max-h-none lg:min-h-0 lg:flex-1"
    >
      <ul
        aria-label="Downloads by batch"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (row === undefined) return null
          return (
            <li
              key={item.key}
              aria-setsize={rows.length}
              aria-posinset={item.index + 1}
              className="absolute top-0 left-0 w-full"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'batch' ? (
                <BatchRow group={row.group} onAction={onAction} focusAfterClear={focusAfterClear} />
              ) : (
                <MemoJobRow job={row.job} />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
