import type { ResolveMode, ResolveResult, Track } from '@dj-scraper/shared'
import { type ReactNode, useState } from 'react'
import { CollectionView } from '@/features/collection/collection-view.tsx'
import { useSettings } from '@/features/settings/use-settings.ts'
import { TrackCard } from '@/features/track/track-card.tsx'
import { AmbiguousPrompt } from './ambiguous-prompt.tsx'
import { TrackSkeleton } from './result-skeletons.tsx'

type ResolvedResultProps = {
  result: ResolveResult
  /** Loads a link the result points at: the whole list of a track-in-a-list, a set on a page. */
  onLoad: (url: string, mode: ResolveMode) => void
  /** The user picked the track of a track-in-a-list link (the prompt's buttons go away). */
  onTrackChosen: () => void
}

/**
 * What a link resolved to. Keyed by the paste's number, so each paste mounts a fresh track card
 * (whose auto-download fires once) or collection (whose selection starts over).
 */
export function ResolvedResult({ result, onLoad, onTrackChosen }: ResolvedResultProps) {
  // For an ambiguous link: the user chose the track it opens.
  const [trackChosen, setTrackChosen] = useState(false)

  switch (result.kind) {
    case 'track':
      return (
        <Padded>
          <TrackResult track={result.track} />
        </Padded>
      )
    case 'ambiguous':
      return (
        <Padded>
          {trackChosen ? (
            <TrackResult track={result.track} />
          ) : (
            <AmbiguousPrompt
              result={result}
              // The track is already in the answer: no second resolve.
              onTrack={() => {
                setTrackChosen(true)
                onTrackChosen()
              }}
              onList={() => onLoad(result.collectionUrl, 'collection')}
            />
          )}
        </Padded>
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

function Padded({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-3xl px-4 pb-6">{children}</div>
}

/**
 * The track card, auto-downloading when the setting says so. It waits for the settings (normally
 * loaded already: the header's folder picker reads them), so it never mounts with the wrong value.
 */
function TrackResult({ track }: { track: Track }) {
  const settings = useSettings()
  if (settings.isPending) return <TrackSkeleton />
  const autoStart =
    settings.data?.autoDownloadSingles === true && track.availability !== 'unavailable'
  return <SettledTrackCard track={track} autoStart={autoStart} />
}

/**
 * Keeps the `autoStart` the card mounted with: settings that change or arrive later (after an
 * error) must not start a download the user has been looking at for a while.
 */
function SettledTrackCard({ track, autoStart }: { track: Track; autoStart: boolean }) {
  const [initialAutoStart] = useState(autoStart)
  return <TrackCard track={track} autoStart={initialAutoStart} />
}
