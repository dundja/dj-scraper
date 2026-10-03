// biome-ignore-all lint/a11y/useSemanticElements: virtualized rows are absolutely positioned, which a <table> layout can't do, so ARIA table roles carry the semantics.
// biome-ignore-all lint/a11y/useFocusableInteractive: rows and column headers of a static table (not a grid) take no focus; each row's checkbox does.
import { formatDuration } from '@dj-scraper/shared'
import { Ban } from 'lucide-react'
import { memo } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Skeleton } from '@/components/ui/skeleton.tsx'
import { unavailableLabel } from '@/lib/error-text.ts'
import { cn } from '@/lib/utils.ts'
import { TrackJobStatus } from './job-status.tsx'
import type { TableRow } from './rows.ts'
import { ROW_GRID, ROW_HEIGHT } from './table-layout.ts'

type TrackRowProps = {
  row: TableRow
  /** Its place among the shown rows (the filter applied): the virtual position and aria-rowindex. */
  position: number
  selected: boolean
  /** Whether its checkbox is the table's one Tab stop (roving focus: arrows move it). */
  tabbable: boolean
  /** The id of this track's newest download, if any (its chip reads the job). */
  jobId: string | undefined
  onClick: (position: number, shift: boolean) => void
  onFocus: (position: number) => void
}

/**
 * One fixed-height row of the track table. Memoized: a selection change re-renders only the rows
 * whose checkbox changed, and a download's progress only its status chip. A click anywhere on the row toggles it, shift extending the range; the
 * checkbox is its keyboard control (Space, Shift+Space).
 */
export const TrackRow = memo(function TrackRow({
  row,
  position,
  selected,
  tabbable,
  jobId,
  onClick,
  onFocus,
}: TrackRowProps) {
  const { entry, state, selectable } = row
  const loading = state === 'pending' || state === 'loading'
  const name = entry.title ?? `row ${row.index + 1}`
  const artist = entry.artist ?? entry.uploader
  // Where the artist goes: a placeholder while loading, the failure when the title is already shown.
  const byline =
    artist ??
    (loading ? (
      <Skeleton className="motion-reduce:animate-none h-3 w-2/5" />
    ) : state === 'failed' && entry.title !== undefined ? (
      <span className="italic">Couldn't load details</span>
    ) : null)

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox is the row's keyboard control; a click anywhere on the row is a mouse shortcut for it.
    <div
      role="row"
      aria-rowindex={position + 2}
      data-position={position}
      className={cn(
        ROW_GRID,
        'absolute inset-x-0 top-0 select-none',
        selectable ? 'cursor-pointer hover:bg-muted/50' : 'text-muted-foreground',
      )}
      style={{ height: ROW_HEIGHT, transform: `translateY(${position * ROW_HEIGHT}px)` }}
      onClick={(event) => {
        onFocus(position)
        onClick(position, event.shiftKey)
      }}
    >
      <div role="cell" className="flex">
        <Checkbox
          checked={selected}
          disabled={!selectable}
          tabIndex={tabbable ? 0 : -1}
          aria-label={`Select ${name}`}
          onFocus={() => onFocus(position)}
        />
      </div>
      <div role="cell" className="text-right text-xs text-muted-foreground tabular-nums">
        {row.index + 1}
      </div>
      <div role="cell" className={cn(!selectable && 'opacity-50')}>
        <Artwork src={entry.thumbnailUrl} size={32} />
      </div>
      <div role="cell" className="min-w-0">
        <RowTitle row={row} loading={loading} />
        <div className="mt-0.5 truncate text-xs text-muted-foreground @2xl:hidden">{byline}</div>
      </div>
      <div
        role="cell"
        className={cn(
          'hidden min-w-0 truncate text-sm @2xl:block',
          artist === undefined && 'text-muted-foreground',
        )}
        title={artist}
      >
        {byline}
      </div>
      <div role="cell" className="text-right text-xs text-muted-foreground tabular-nums">
        {entry.durationSec ? (
          formatDuration(entry.durationSec)
        ) : loading ? (
          <Skeleton className="motion-reduce:animate-none ml-auto h-3 w-8" />
        ) : null}
      </div>
      <div role="cell" className="min-w-0">
        {!selectable ? (
          <span
            className="flex items-center gap-1 truncate text-xs"
            title={unavailableLabel(entry.unavailableReason)}
          >
            <Ban aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{unavailableLabel(entry.unavailableReason)}</span>
          </span>
        ) : (
          jobId !== undefined && <TrackJobStatus jobId={jobId} />
        )}
      </div>
    </div>
  )
})

function RowTitle({ row, loading }: { row: TableRow; loading: boolean }) {
  const { title } = row.entry
  if (title !== undefined) {
    return (
      <div className="truncate text-sm" title={title}>
        {title}
      </div>
    )
  }
  if (loading) {
    return (
      <>
        <Skeleton className="motion-reduce:animate-none h-3.5 w-3/5 max-w-60" />
        <span className="sr-only">Loading details…</span>
      </>
    )
  }
  return (
    <div className="truncate text-sm text-muted-foreground italic" title={row.error?.message}>
      {row.state === 'failed' ? "Couldn't load details" : 'Untitled'}
    </div>
  )
}
