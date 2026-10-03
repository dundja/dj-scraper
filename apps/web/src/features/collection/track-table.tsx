// biome-ignore-all lint/a11y/useSemanticElements: virtualized rows are absolutely positioned, which a <table> layout can't do, so ARIA table roles carry the semantics.
// biome-ignore-all lint/a11y/useFocusableInteractive: rows and column headers of a static table (not a grid) take no focus; each row's checkbox does.
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useCallback, useEffect, useEffectEvent, useMemo, useRef } from 'react'
import type { TrackKey } from '@/features/downloads/track-ref.ts'
import { useJobIdsByTrack } from '@/features/downloads/use-downloads.ts'
import { cn } from '@/lib/utils.ts'
import { rowsInView, type TableRow } from './rows.ts'
import { ROW_GRID, ROW_HEIGHT } from './table-layout.ts'
import { TrackRow } from './track-row.tsx'
import { useRowFocus } from './use-row-focus.ts'

const rowHeight = () => ROW_HEIGHT

type TrackTableProps = {
  /** The rows to show, in order: the filter already applied. */
  rows: readonly TableRow[]
  selected: ReadonlySet<TrackKey>
  onRowClick: (position: number, shift: boolean) => void
  /**
   * The rows in view, as collection indexes with the overscan, in the order to look them up
   * (rowsInView): useEnrichment's `setRowsInView`. Called again whenever the shown rows change.
   */
  onRowsInViewChange: (indexes: readonly number[]) => void
  /** What to say when no row is shown (the filter matches nothing). */
  empty: ReactNode
}

/**
 * The collection's tracks, virtualized: only the rows in view (plus a few) are in the DOM, so
 * 5,000 rows scroll as smoothly as 30. It scrolls on its own: within the left column on wide
 * screens, in a box of 60 % of the window's height below that.
 */
export function TrackTable({
  rows,
  selected,
  onRowClick,
  onRowsInViewChange,
  empty,
}: TrackTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // A row keeps its element when the filter moves it. Stable between renders, or the virtualizer
  // would lay out all rows again on every selection change.
  const getItemKey = useCallback((position: number) => rows[position]?.index ?? position, [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    getItemKey,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  const focus = useRowFocus(rows.length, virtualizer, scrollRef)
  // Changes only when jobs come or go; each row's chip follows its own job.
  const jobIds = useJobIdsByTrack()

  // Partial rows fill in as they come into view; the rows a filter hides never do.
  const startIndex = virtualizer.range?.startIndex ?? 0
  const endIndex = virtualizer.range?.endIndex ?? -1
  const inView = useMemo(() => rowsInView(rows, startIndex, endIndex), [rows, startIndex, endIndex])
  const reportRowsInView = useEffectEvent(onRowsInViewChange)
  useEffect(() => {
    reportRowsInView(inView)
  }, [inView])

  // The Tab stop: the last focused row while it is rendered, else the first row in view.
  const tabbable = items.some((item) => item.index === focus.active)
    ? focus.active
    : (virtualizer.range?.startIndex ?? 0)

  return (
    <div
      role="table"
      aria-label="Tracks"
      aria-rowcount={rows.length + 1}
      className="flex flex-col border-t lg:min-h-0 lg:flex-1"
    >
      {/* The same stable gutter as the list below, so the columns line up beside its scrollbar. */}
      <div role="rowgroup" className="shrink-0 overflow-hidden border-b [scrollbar-gutter:stable]">
        <div
          role="row"
          aria-rowindex={1}
          className={cn(ROW_GRID, 'h-8 text-xs font-medium text-muted-foreground')}
        >
          <span role="columnheader">
            <span className="sr-only">Selected</span>
          </span>
          <span role="columnheader" className="text-right">
            #
          </span>
          <span role="columnheader">
            <span className="sr-only">Artwork</span>
          </span>
          <span role="columnheader">Title</span>
          <span role="columnheader" className="hidden @2xl:block">
            Artist
          </span>
          <span role="columnheader" className="text-right">
            Time
          </span>
          <span role="columnheader">Status</span>
        </div>
      </div>
      <div
        ref={scrollRef}
        role="rowgroup"
        data-slot="track-list"
        className="max-h-[60svh] overflow-y-auto [scrollbar-gutter:stable] lg:max-h-none lg:overscroll-contain lg:min-h-0 lg:flex-1"
        onKeyDown={focus.onKeyDown}
      >
        {rows.length === 0 ? (
          <div role="row" className="px-4 py-10 text-center text-sm text-muted-foreground">
            <span role="cell">{empty}</span>
          </div>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index]
              if (row === undefined) return null
              return (
                <TrackRow
                  key={item.key}
                  row={row}
                  position={item.index}
                  selected={selected.has(row.key)}
                  tabbable={item.index === tabbable}
                  jobId={jobIds.get(row.key)}
                  onClick={onRowClick}
                  onFocus={focus.setActive}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
