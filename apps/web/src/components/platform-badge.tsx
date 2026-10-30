import type { Platform } from '@dj-scraper/shared'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge.tsx'
import { cn } from '@/lib/utils.ts'

const PLATFORMS: Record<Platform, { label: string; dot?: string }> = {
  youtube: { label: 'YouTube', dot: 'bg-platform-youtube' },
  soundcloud: { label: 'SoundCloud', dot: 'bg-platform-soundcloud' },
  // A track list only: its audio is matched on YouTube (ADR-026).
  spotify: { label: 'Spotify', dot: 'bg-platform-spotify' },
  // Anything else yt-dlp handles (Bandcamp, Mixcloud, …): no brand to hint at.
  other: { label: 'Web' },
}

/** The plain look: the dot and the words, no pill (the platform column of a remix row). */
const PLAIN = 'h-auto rounded-none border-transparent px-0'
const PLAIN_WIDE = '@4xl:h-auto @4xl:rounded-none @4xl:border-transparent @4xl:px-0'

type PlatformBadgeProps = {
  platform: Platform
  /** More after the name, e.g. a remix upload's "908K views". */
  children?: ReactNode
  /**
   * `badge` (the default): a bordered pill. `plain`: the dot and the words alone. `plain-wide`: a
   * pill, plain once its container is `@4xl` wide (where it stands in a column of its own).
   */
  variant?: 'badge' | 'plain' | 'plain-wide'
  className?: string
}

/**
 * Where a track or list comes from: the platform's name with a dot in its brand color. Text, not
 * a logo: lucide has no brand icons, and a made-up one would be worse than none.
 */
export function PlatformBadge({
  platform,
  children,
  variant = 'badge',
  className,
}: PlatformBadgeProps) {
  const { label, dot } = PLATFORMS[platform]
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal text-muted-foreground',
        variant === 'plain' && PLAIN,
        variant === 'plain-wide' && PLAIN_WIDE,
        className,
      )}
    >
      {dot !== undefined && <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />}
      {label}
      {children !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{children}</span>
        </>
      )}
    </Badge>
  )
}
