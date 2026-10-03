import type { ReactNode } from 'react'
import { shortenPath } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

type FolderPathProps = {
  /** The full folder path; shown with the home folder as `~` (shortenPath). */
  path: string
  /** The tooltip (`title`). Default: the full path. */
  title?: string
  /** Shown right after the path, cut along with it, e.g. a subfolder ("/Summer 2026"). */
  children?: ReactNode
  className?: string
}

/**
 * A folder path on one line that, when it doesn't fit, loses its start rather than its end:
 * "…/USB/Sets/Summer 2026", not "/Volumes/USB/Sets/Su…", since the last folders tell paths apart.
 * The box is right-to-left so the ellipsis and the cut go on the left, and the path inside is
 * isolated left-to-right (`<bdi>`), so its leading "/" or "~" stays in front. Short paths sit on
 * the left as usual. The full path is in the tooltip.
 */
export function FolderPath({ path, title, children, className }: FolderPathProps) {
  return (
    <span
      dir="rtl"
      data-slot="folder-path"
      title={title ?? path}
      className={cn('block min-w-0 truncate text-left', className)}
    >
      <bdi dir="ltr">
        {shortenPath(path)}
        {children}
      </bdi>
    </span>
  )
}
