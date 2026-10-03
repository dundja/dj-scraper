import type { Platform } from '@dj-scraper/shared'
import { Badge } from '@/components/ui/badge.tsx'
import { cn } from '@/lib/utils.ts'

const PLATFORMS: Record<Platform, { label: string; dot?: string }> = {
  youtube: { label: 'YouTube', dot: 'bg-red-500' },
  soundcloud: { label: 'SoundCloud', dot: 'bg-orange-500' },
  // Anything else yt-dlp handles (Bandcamp, Mixcloud, …): no brand to hint at.
  other: { label: 'Web' },
}

/**
 * Where a track or list comes from: the platform's name with a dot in its brand color. Text, not
 * a logo: lucide has no brand icons, and a made-up one would be worse than none.
 */
export function PlatformBadge({ platform, className }: { platform: Platform; className?: string }) {
  const { label, dot } = PLATFORMS[platform]
  return (
    <Badge variant="outline" className={cn('font-normal text-muted-foreground', className)}>
      {dot !== undefined && <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />}
      {label}
    </Badge>
  )
}
