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

type PlatformBadgeProps = {
  platform: Platform
  /** More after the name, e.g. a remix upload's "908K views". */
  children?: ReactNode
  className?: string
}

/**
 * Where a track or list comes from: the platform's name with a dot in its brand color. Text, not
 * a logo: lucide has no brand icons, and a made-up one would be worse than none.
 */
export function PlatformBadge({ platform, children, className }: PlatformBadgeProps) {
  const { label, dot } = PLATFORMS[platform]
  return (
    <Badge variant="outline" className={cn('font-normal text-muted-foreground', className)}>
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
