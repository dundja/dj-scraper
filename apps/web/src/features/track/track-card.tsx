import { formatDuration, type Track } from '@dj-scraper/shared'
import { useId } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { TrackDownload } from './track-download.tsx'
import { TrackMatch } from './track-match.tsx'
import { TrackSource } from './track-source.tsx'
import { useTrackDownload } from './use-track-download.ts'

type TrackCardProps = { track: Track }

/**
 * A resolved single track as a wide header (ADR-031): large artwork, names, platform, duration and
 * the source's codec and bitrate (the stream the download really fetched, once known), for a
 * Spotify track where its audio comes from (`TrackMatch`), then its download along the bottom (the
 * status on the left, Download and the format on the right), which waits for Download or ⌘D.
 * Below md the artwork shrinks and the download takes the card's full width under a hairline.
 */
export function TrackCard({ track }: TrackCardProps) {
  const titleId = useId()
  const artist = track.artist ?? track.uploader
  const unavailable = track.availability === 'unavailable'
  const download = useTrackDownload(track)

  return (
    <article
      aria-labelledby={titleId}
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-lg border bg-card p-4 text-card-foreground md:grid-rows-[1fr_auto] md:gap-x-5"
    >
      <Artwork
        src={track.thumbnailUrl}
        size={160}
        sizeClassName="size-24 md:size-40"
        className="md:row-span-2"
      />
      <div className="flex min-w-0 flex-col gap-1 md:pt-1">
        <h2
          id={titleId}
          title={track.title}
          className="line-clamp-2 text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          {track.title}
        </h2>
        {artist !== undefined && <p className="truncate text-sm text-muted-foreground">{artist}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-xs text-muted-foreground">
          <PlatformBadge platform={track.platform} />
          {track.durationSec !== undefined && (
            <span className="font-mono tabular-nums">
              <span className="sr-only">Duration </span>
              {formatDuration(track.durationSec)}
            </span>
          )}
          <TrackSource source={track.source} jobId={download.jobId} unavailable={unavailable} />
        </div>
        <div className="pt-1.5 empty:hidden">
          <TrackMatch track={track} jobId={download.jobId} />
        </div>
      </div>
      <div className="col-span-2 border-t pt-3 md:col-span-1 md:col-start-2 md:self-end md:border-t-0 md:pt-0">
        <TrackDownload track={track} download={download} />
      </div>
    </article>
  )
}
