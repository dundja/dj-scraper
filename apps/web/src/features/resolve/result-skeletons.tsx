import { Skeleton } from '@/components/ui/skeleton.tsx'

/** A track card while it loads: artwork, title, artist and details. */
export function TrackSkeleton() {
  return (
    <div
      aria-hidden
      data-slot="track-skeleton"
      className="flex gap-4 rounded-lg border bg-card/40 p-4"
    >
      <Skeleton className="size-24 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-1">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="mt-auto h-3 w-1/3" />
      </div>
    </div>
  )
}

/** Title widths of the placeholder rows; each is distinct, so it doubles as the row's key. */
const ROW_WIDTHS = [
  'w-[62%]',
  'w-[41%]',
  'w-[53%]',
  'w-[68%]',
  'w-[35%]',
  'w-[48%]',
  'w-[58%]',
  'w-[44%]',
]

/** A list while it loads: its header, then rows like the track table's. */
export function ListSkeleton() {
  return (
    <div aria-hidden data-slot="list-skeleton" className="flex flex-col gap-4">
      <div className="flex gap-4">
        <Skeleton className="size-18 shrink-0 rounded-md" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3.5 w-1/3" />
        </div>
      </div>
      <div className="flex flex-col">
        {ROW_WIDTHS.map((width) => (
          <div key={width} className="flex h-11 items-center gap-3 border-b border-border/50">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="size-8 rounded-sm" />
            <Skeleton className={`h-3.5 ${width}`} />
            <Skeleton className="ml-auto h-3.5 w-10" />
          </div>
        ))}
      </div>
    </div>
  )
}
