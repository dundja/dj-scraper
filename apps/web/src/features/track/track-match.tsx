import type { Track } from '@dj-scraper/shared'
import { ExternalLink, Info } from 'lucide-react'
import { useJob } from '@/features/downloads/use-downloads.ts'

type TrackMatchProps = {
  track: Track
  /** The track's download, once queued: its attempt names the YouTube upload it matched. */
  jobId: string | undefined
}

/**
 * Where a Spotify track's audio comes from (ADR-026). Spotify's streams are DRM-protected, so the
 * download finds the track on YouTube: until it has, the card says so; then it names the upload,
 * linked, so the DJ can check it is the right version. Nothing for other platforms.
 */
export function TrackMatch({ track, jobId }: TrackMatchProps) {
  const match = useJob(jobId)?.match
  if (track.platform !== 'spotify') return null
  return (
    <p data-slot="track-match" className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="mt-px size-3.5 shrink-0" />
      {match === undefined ? (
        <span>
          Spotify streams are DRM-protected: DJ Scraper finds this track on YouTube and downloads it
          from there.
        </span>
      ) : (
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Audio from YouTube:{' '}
          <a
            href={match.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {match.title}
            <ExternalLink aria-hidden className="ml-1 inline size-3 align-[-1px]" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {match.uploader !== undefined && ` · ${match.uploader}`}
        </span>
      )}
    </p>
  )
}
