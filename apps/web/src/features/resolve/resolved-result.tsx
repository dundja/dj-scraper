import type { ResolveMode, ResolveResult, Track } from '@dj-scraper/shared'
import { useState } from 'react'
import { CollectionView } from '@/features/collection/collection-view.tsx'
import { RemixSection } from '@/features/remixes/remix-section.tsx'
import { TrackCard } from '@/features/track/track-card.tsx'
import { AmbiguousPrompt } from './ambiguous-prompt.tsx'

type ResolvedResultProps = {
  result: ResolveResult
  /** Loads a link the result points at: the whole list of a track-in-a-list, a set on a page. */
  onLoad: (url: string, mode: ResolveMode) => void
  /** The user picked the track of a track-in-a-list link (the prompt's buttons go away). */
  onTrackChosen: () => void
}

/**
 * What a link resolved to. Keyed by the paste's number, so each paste mounts a fresh track card
 * (whose download waits for Download, ADR-031) or collection (whose selection starts over).
 */
export function ResolvedResult({ result, onLoad, onTrackChosen }: ResolvedResultProps) {
  // For an ambiguous link: the user chose the track it opens.
  const [trackChosen, setTrackChosen] = useState(false)

  switch (result.kind) {
    case 'track':
      return <SingleTrack track={result.track} />
    case 'ambiguous':
      return trackChosen ? (
        <SingleTrack track={result.track} />
      ) : (
        // A question reads best at a line's length, unlike the track it opens.
        <div className="w-full max-w-3xl px-4 pb-6">
          <AmbiguousPrompt
            result={result}
            // The track is already in the answer: no second resolve.
            onTrack={() => {
              setTrackChosen(true)
              onTrackChosen()
            }}
            onList={() => onLoad(result.collectionUrl, 'collection')}
          />
        </div>
      )
    case 'collection':
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <CollectionView
            collection={result.collection}
            onOpenList={(url) => onLoad(url, 'auto')}
          />
        </div>
      )
  }
}

/**
 * A single track across the main column's full width (ADR-031): its card, then its song's remixes
 * below it (ADR-027). The search starts with the card and runs beside its download; below the
 * card, it never moves it.
 */
function SingleTrack({ track }: { track: Track }) {
  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-6">
      <TrackCard track={track} />
      <RemixSection track={track} />
    </div>
  )
}
