import { formatDuration, type Track } from '@dj-scraper/shared'
import { useId } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { TrackDownload } from './track-download.tsx'
import { TrackSource } from './track-source.tsx'
import { useTrackDownload } from './use-track-download.ts'

type TrackCardProps = {
  track: Track
  /** Queue the download on mount (the "Auto-download single tracks" setting). */
  autoStart: boolean
}

/**
 * A resolved single track: artwork, names, duration, platform and the source's codec and bitrate
 * (the stream the download really fetched, once known), then its download. Keyed by the paste
 * submission, so `autoStart` fires once per paste.
 */
export function TrackCard({ track, autoStart }: TrackCardProps) {
  const titleId = useId()
  const artist = track.artist ?? track.uploader
  const unavailable = track.availability === 'unavailable'
  const download = useTrackDownload(track, autoStart)

  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex gap-4">
        <Artwork src={track.thumbnailUrl} size={96} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2
            id={titleId}
            title={track.title}
            className="line-clamp-2 text-base leading-snug font-medium [overflow-wrap:anywhere]"
          >
            {track.title}
          </h2>
          {artist !== undefined && (
            <p className="truncate text-sm text-muted-foreground">{artist}</p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
            <PlatformBadge platform={track.platform} />
            {track.durationSec !== undefined && (
              <span className="tabular-nums">
                <span className="sr-only">Duration </span>
                {formatDuration(track.durationSec)}
              </span>
            )}
            <TrackSource source={track.source} jobId={download.jobId} unavailable={unavailable} />
          </div>
        </div>
      </div>
      <div className="border-t pt-3">
        <TrackDownload track={track} download={download} />
      </div>
    </article>
  )
}
