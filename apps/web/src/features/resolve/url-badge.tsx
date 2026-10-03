import { Lock } from 'lucide-react'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import type { UrlVerdict } from './url-verdict.ts'

/**
 * The instant guess at the end of the paste box: platform and what the link points at ("YouTube ·
 * Playlist"), or that a DRM service isn't supported. Nothing for text that isn't a link: the line
 * under the box says why.
 */
export function UrlBadge({ id, verdict }: { id: string; verdict: UrlVerdict }) {
  if (verdict.status === 'drm') {
    return (
      <span id={id} className="flex items-center">
        <Badge variant="destructive">{verdict.label}</Badge>
      </span>
    )
  }
  if (verdict.status !== 'ok') return null
  return (
    <span id={id} className="flex items-center gap-1.5 text-xs font-normal text-foreground">
      <span className="sr-only">Detected: </span>
      <PlatformBadge platform={verdict.platform} />
      <span className="whitespace-nowrap">{verdict.label}</span>
      {verdict.secret && (
        <>
          <Lock aria-hidden className="size-3 text-muted-foreground" />
          <span className="sr-only">, private link</span>
        </>
      )}
    </span>
  )
}
