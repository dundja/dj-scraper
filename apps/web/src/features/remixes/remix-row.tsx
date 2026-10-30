import { formatDuration, type RemixSuggestion, type RemixSuggestions } from '@dj-scraper/shared'
import { Artwork } from '@/components/artwork.tsx'
import { PlatformBadge } from '@/components/platform-badge.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { TrackJobStatus } from '@/features/collection/job-status.tsx'
import { cn } from '@/lib/utils.ts'
import { RemixDownload } from './remix-download.tsx'
import { type RemixJobsStore, useRemixJobId } from './remix-jobs.ts'
import { REMIX_CELL, REMIX_ROW } from './remix-layout.ts'
import { RemixPreviewButton } from './remix-preview-button.tsx'
import {
  defaultUpload,
  genreSourceText,
  kindText,
  playsText,
  uploadsByPlatform,
  versionTitle,
} from './remix-text.ts'
import { usePreviewPlayer } from './use-preview-player.ts'

type RemixRowProps = {
  suggestion: RemixSuggestion
  /** The song searched for: the rows show what their titles add to it. */
  song: RemixSuggestions['song']
  /** The section's rows' jobs: this row shows the job of its upload downloaded last. */
  jobs: RemixJobsStore
}

/**
 * One version of the song on the list's columns (`remix-layout.ts`): its default upload's artwork
 * and the part of its title that tells it apart ("Arty Remix"; the whole title names the row and
 * shows in its tooltip), what kind of version it is and by whom, its genre, a badge per platform it's on (with
 * that platform's most played upload's count), the length, Play and its download. The row whose
 * audio is on (preparing, playing, paused or failed) is the one raised row; the now-playing bar
 * holds its player.
 */
export function RemixRow({ suggestion, song, jobs }: RemixRowProps) {
  const top = defaultUpload(suggestion)
  const credit = kindText(suggestion)
  const version = versionTitle(top.title, song)
  const preview = usePreviewPlayer(top, { credit, version, jobs })
  const jobId = useRemixJobId(jobs, suggestion.uploads)
  const { status } = preview.state
  return (
    <li
      aria-label={top.title}
      data-preview={status}
      className={cn(
        REMIX_ROW,
        'min-h-14 gap-y-0.5 border-b border-border/50 py-1 last:border-b-0',
        // The row whose audio is on is the one raised surface (DESIGN.md, One Raised Row).
        status !== 'idle' && 'rounded-lg border-transparent bg-card',
      )}
    >
      <Artwork
        src={top.thumbnailUrl}
        size={48}
        sizeClassName="size-10 @4xl:size-12"
        className={REMIX_CELL.cover}
      />
      <p
        title={top.title}
        className={cn(
          REMIX_CELL.title,
          // One line on the columns, so every row keeps the same height.
          'line-clamp-2 text-sm leading-snug font-medium [overflow-wrap:anywhere] @4xl:line-clamp-1',
        )}
      >
        {version}
      </p>
      <div
        className={cn(
          REMIX_CELL.line,
          'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground',
        )}
      >
        <span className={cn(REMIX_CELL.kind, 'text-xs text-muted-foreground')}>
          <span className="truncate">{credit}</span>
          {/* The job's status beside the kind, so the actions keep their width down the list. */}
          {jobId !== undefined && (
            <span className="max-w-28 shrink-0">
              <TrackJobStatus jobId={jobId} />
            </span>
          )}
        </span>
        <span className={REMIX_CELL.genre}>
          {suggestion.genre !== undefined && <GenreChip genre={suggestion.genre} />}
        </span>
        <span className={REMIX_CELL.platforms}>
          {uploadsByPlatform(suggestion).map((upload) => (
            <PlatformBadge key={upload.platform} platform={upload.platform} variant="plain-wide">
              {upload.plays === undefined ? undefined : playsText(upload.platform, upload.plays)}
            </PlatformBadge>
          ))}
        </span>
        {top.durationSec !== undefined && (
          <span className={cn(REMIX_CELL.length, 'font-mono text-xs tabular-nums')}>
            <span className="sr-only">Duration </span>
            {formatDuration(top.durationSec)}
          </span>
        )}
      </div>
      <div className={REMIX_CELL.play}>
        <RemixPreviewButton upload={top} status={status} onToggle={preview.toggle} />
      </div>
      <div className={REMIX_CELL.download}>
        <RemixDownload
          uploads={suggestion.uploads}
          jobId={jobId}
          onQueued={jobs.remember}
          showStatus={false}
        />
      </div>
    </li>
  )
}

type GenreChipProps = { genre: NonNullable<RemixSuggestion['genre']> }

/**
 * The genre: solid when the uploader set it on SoundCloud, dashed when a title or tags named it
 * (a guess). Where it came from is in its tooltip and, for screen readers, its text.
 */
function GenreChip({ genre }: GenreChipProps) {
  const source = genreSourceText(genre.source)
  return (
    <Badge
      variant="outline"
      title={source}
      data-genre-source={genre.source}
      className={cn(
        'max-w-40 truncate font-normal',
        genre.source === 'text' ? 'border-dashed text-muted-foreground' : 'text-foreground',
      )}
    >
      {genre.name}
      <span className="sr-only"> ({source})</span>
    </Badge>
  )
}
