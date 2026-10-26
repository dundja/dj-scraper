import { formatDuration, type RemixSuggestion, type RemixUpload } from '@dj-scraper/shared'
import { useId } from 'react'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { cn } from '@/lib/utils.ts'
import { RemixDownload } from './remix-download.tsx'
import {
  defaultUpload,
  genreSourceText,
  kindText,
  playsText,
  uploadsByPlatform,
} from './remix-text.ts'

type RemixRowProps = {
  suggestion: RemixSuggestion
  /** The job of the upload of it downloaded last, if any. */
  jobId: string | undefined
  onQueued: (upload: RemixUpload, jobId: string) => void
}

/**
 * One version of the song: its default upload's artwork and title, what kind of version it is and
 * by whom, its genre, a chip per platform it's on (with that platform's most played upload's
 * count), the length, and its download.
 */
export function RemixRow({ suggestion, jobId, onQueued }: RemixRowProps) {
  const titleId = useId()
  const top = defaultUpload(suggestion)
  return (
    <li
      aria-labelledby={titleId}
      className="flex items-start gap-3 border-b border-border/50 py-2.5 last:border-b-0"
    >
      <Artwork src={top.thumbnailUrl} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          id={titleId}
          title={top.title}
          className="line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere]"
        >
          {top.title}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{kindText(suggestion)}</span>
          {suggestion.genre !== undefined && <GenreChip genre={suggestion.genre} />}
          {uploadsByPlatform(suggestion).map((upload) => (
            <PlatformBadge key={upload.platform} platform={upload.platform}>
              {upload.plays === undefined ? undefined : playsText(upload.platform, upload.plays)}
            </PlatformBadge>
          ))}
          {top.durationSec !== undefined && (
            <span className="tabular-nums">
              <span className="sr-only">Duration </span>
              {formatDuration(top.durationSec)}
            </span>
          )}
        </div>
      </div>
      <RemixDownload uploads={suggestion.uploads} jobId={jobId} onQueued={onQueued} />
    </li>
  )
}

/**
 * The genre: solid when the uploader set it on SoundCloud, dashed when a title or tags named it
 * (a guess). Where it came from is in its tooltip and, for screen readers, its text.
 */
function GenreChip({ genre }: { genre: NonNullable<RemixSuggestion['genre']> }) {
  const source = genreSourceText(genre.source)
  return (
    <Badge
      variant="outline"
      title={source}
      data-genre-source={genre.source}
      className={cn(
        'font-normal',
        genre.source === 'text' ? 'border-dashed text-muted-foreground' : 'text-foreground',
      )}
    >
      {genre.name}
      <span className="sr-only"> ({source})</span>
    </Badge>
  )
}
