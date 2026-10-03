import { Link2 } from 'lucide-react'

/**
 * Covers the window while a link is dragged over it. It lets the pointer through, so the drag
 * events keep reaching the page underneath; assistive tech doesn't drag, so it stays hidden there.
 */
export function DropOverlay() {
  return (
    <div
      aria-hidden
      data-slot="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ring px-12 py-10 text-center">
        <Link2 className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">Drop the link to load it</p>
        <p className="text-xs text-muted-foreground">A YouTube or SoundCloud track or list</p>
      </div>
    </div>
  )
}
