import { formatDuration, type ResolveResult } from '@dj-scraper/shared'
import { useEffect, useId, useRef } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ambiguousWording } from './resolve-text.ts'

type AmbiguousPromptProps = {
  result: Extract<ResolveResult, { kind: 'ambiguous' }>
  /** Keep the track already looked up. */
  onTrack: () => void
  /** List the whole playlist, album or mix instead. */
  onList: () => void
}

/**
 * "This track or the whole playlist?" for a `watch?v=…&list=…` link, worded by the list's kind and
 * showing the track it opens. A mix never ends, so there the track is the default (and focused).
 */
export function AmbiguousPrompt({ result, onTrack, onList }: AmbiguousPromptProps) {
  const { track, collectionKind } = result
  const wording = ambiguousWording(collectionKind)
  const isMix = collectionKind === 'mix'
  const trackButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (isMix) trackButton.current?.focus()
  }, [isMix])

  const details = [
    track.artist ?? track.uploader,
    track.durationSec === undefined ? undefined : formatDuration(track.durationSec),
  ].filter((detail) => detail !== undefined)

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-lg border bg-card/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-base font-medium">
          {wording.question}
        </h2>
        <p className="text-xs text-pretty text-muted-foreground">{wording.note}</p>
      </div>
      <div className="flex items-center gap-3">
        <Artwork src={track.thumbnailUrl} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{track.title}</p>
          {details.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">{details.join(' · ')}</p>
          )}
        </div>
        <PlatformBadge platform={track.platform} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button ref={trackButton} variant={isMix ? 'default' : 'outline'} onClick={onTrack}>
          {wording.track}
        </Button>
        <Button variant="outline" onClick={onList}>
          {wording.list}
        </Button>
      </div>
    </section>
  )
}
